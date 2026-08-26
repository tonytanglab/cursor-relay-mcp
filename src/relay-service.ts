import { createHash } from "node:crypto";
import { RelayError, asRelayError } from "./errors.js";
import {
  permissionOptions,
  resolveWorkspace,
  workspaceIsWithinRoots,
  type RelayConfig,
} from "./config.js";
import {
  CURSOR_SDK_VERSION,
  type AgentLaunchOptions,
  type CursorEvent,
  type CursorModel,
  type CursorRunHandle,
  type CursorRunResult,
  type CursorSdkPort,
} from "./sdk-port.js";
import { StateStore } from "./state-store.js";
import { WorkspaceApprovalBroker } from "./workspace-approval.js";
import type {
  AuthorizeWorkspaceInput,
  ModelSelection,
  RelayRun,
  RelayRunSummary,
  RelayRunStatus,
  StartRunInput,
} from "./types.js";

const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);
const MODEL_CACHE_TTL_MS = 60_000;
const MAX_EVENT_DATA_BYTES = 8 * 1024;
const DEADLINE_GRACE_MS = 500;
const CANCEL_SETTLE_MS = 10_000;

export class RelayService {
  private readonly monitors = new Map<string, Promise<void>>();
  private readonly launches = new Map<string, Promise<void>>();
  private modelCache: { expiresAt: number; models: CursorModel[] } | undefined;
  private modelRefresh: Promise<CursorModel[]> | undefined;

  constructor(
    private readonly config: RelayConfig,
    private readonly store: StateStore,
    private readonly sdk: CursorSdkPort,
    private readonly workspaceApprovals = new WorkspaceApprovalBroker(),
  ) {}

  async doctor() {
    const authentication = await this.sdk.authStatus();
    return {
      ok: authentication.mode !== "missing",
      sdkVersion: CURSOR_SDK_VERSION,
      authentication: authentication.mode,
      ...(authentication.mode === "stored-login" &&
      authentication.expiresAtMs !== undefined
        ? { authenticationExpiresAtMs: authentication.expiresAtMs }
        : {}),
      stateFile: this.store.path,
      workspaceRoots: this.config.workspaceRoots,
      dangerFullAccessEnabled: this.config.dangerFullAccessEnabled,
      readOnlySandboxEnabled: this.config.readOnlySandboxEnabled,
      settingSources: this.config.settingSources,
      warning:
        authentication.mode === "missing"
          ? "未配置 CURSOR_API_KEY，且没有官方 Cursor SDK stored login"
          : undefined,
    };
  }

  async listModels() {
    return { models: await this.getModels() };
  }

  async authorizeWorkspaceOnce(
    input: AuthorizeWorkspaceInput,
    callerScope = "stdio-process",
  ) {
    const workspace = await resolveWorkspace(input.workspace);
    const permission = input.permission ?? "read-only";
    if (permission !== "read-only") {
      throw new RelayError(
        "WORKSPACE_APPROVAL_PERMISSION_DENIED",
        "当前对话的一次性工作区授权仅允许 read-only；写权限仍须静态白名单",
      );
    }
    if (await workspaceIsWithinRoots(workspace, this.config.workspaceRoots)) {
      return {
        authorizationRequired: false,
        workspace,
        permission,
        source: "static-allowlist" as const,
      };
    }
    const grant = this.workspaceApprovals.issue({
      workspace,
      task: input.task,
      idempotencyKey: input.idempotencyKey,
      callerScope,
    });
    return {
      authorizationRequired: true,
      workspace,
      permission,
      source: "interactive-once" as const,
      ...grant,
      instruction:
        "立即用相同 workspace、task、idempotencyKey 和 read-only 调用 start_run，并传入 workspaceApprovalToken；令牌只显示一次。",
    };
  }

  async startRun(
    input: StartRunInput,
    callerScope = "stdio-process",
  ): Promise<{ run: RelayRunSummary; idempotentReplay: boolean }> {
    const workspace = await resolveWorkspace(input.workspace);
    const staticallyAllowed = await workspaceIsWithinRoots(
      workspace,
      this.config.workspaceRoots,
    );
    const permission = input.permission ?? "read-only";
    if (!staticallyAllowed && permission !== "read-only") {
      throw new RelayError(
        "WORKSPACE_DENIED",
        "工作区不在静态白名单内；当前对话授权不能授予 workspace-write 或 danger-full-access",
      );
    }
    permissionOptions(
      permission,
      input.confirmedDangerousPermission,
      this.config.dangerFullAccessEnabled,
      this.config.readOnlySandboxEnabled,
    );
    const timeoutMs = this.normalizeTimeout(input.timeoutMs);
    const model = await this.validateModel(input.model);
    const normalized = { ...input, workspace, model, permission, timeoutMs };
    const fingerprint = hash(
      JSON.stringify({
        workspace,
        task: input.task,
        model,
        permission,
        timeoutMs,
        parentRunId: input.parentRunId ?? null,
      }),
    );
    const existing = await this.store.read();
    const operation = existing.operations[input.idempotencyKey];
    if (operation) {
      if (operation.fingerprint !== fingerprint) {
        throw new RelayError(
          "IDEMPOTENCY_CONFLICT",
          "相同 idempotencyKey 对应了不同请求",
          {
            details: { relayRunId: operation.relayRunId },
          },
        );
      }
      const run = existing.runs[operation.relayRunId];
      if (!run)
        throw new RelayError("STATE_CORRUPT", "幂等索引引用了不存在的运行");
      await this.ensureAttached(run, normalized.confirmedDangerousPermission);
      return {
        run: summarize(await this.requireRun(run.relayRunId)),
        idempotentReplay: true,
      };
    }

    const approvalRequest = {
      workspace,
      task: input.task,
      idempotencyKey: input.idempotencyKey,
      callerScope,
    };
    const approval = staticallyAllowed
      ? undefined
      : this.workspaceApprovals.validate(
          input.workspaceApprovalToken,
          approvalRequest,
        );

    const now = new Date();
    const relayRunId = stableId("crun", input.idempotencyKey);
    const agentId = input.parentRunId
      ? (await this.requireRun(input.parentRunId)).agentId
      : stableId("agent", input.idempotencyKey);
    const run: RelayRun = {
      relayRunId,
      agentId,
      workspace,
      task: input.task,
      model,
      permission,
      workspaceAuthorization: staticallyAllowed
        ? { source: "static-allowlist" }
        : {
            source: "interactive-once",
            approvalId: approval?.approvalId,
            authorizedAt: approval?.authorizedAt,
          },
      ...(permission === "danger-full-access"
        ? { dangerousPermissionConfirmed: true }
        : {}),
      status: "starting",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      deadlineAt: new Date(now.getTime() + timeoutMs).toISOString(),
      ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
      events: [],
    };
    const reservation = await this.store.update((state) => {
      const raced = state.operations[input.idempotencyKey];
      if (raced) {
        if (raced.fingerprint !== fingerprint) {
          throw new RelayError(
            "IDEMPOTENCY_CONFLICT",
            "相同 idempotencyKey 对应了不同请求",
            { details: { relayRunId: raced.relayRunId } },
          );
        }
        if (!state.runs[raced.relayRunId])
          throw new RelayError("STATE_CORRUPT", "幂等索引引用了不存在的运行");
        return { created: false as const, relayRunId: raced.relayRunId };
      }
      state.runs[relayRunId] = run;
      state.operations[input.idempotencyKey] = { fingerprint, relayRunId };
      return { created: true as const, relayRunId };
    });
    if (
      reservation.created &&
      approval &&
      input.workspaceApprovalToken !== undefined
    ) {
      this.workspaceApprovals.consume(
        input.workspaceApprovalToken,
        approval.approvalId,
      );
    }
    if (!reservation.created) {
      const racedRun = await this.requireRun(reservation.relayRunId);
      await this.ensureAttached(
        racedRun,
        normalized.confirmedDangerousPermission,
      );
      return {
        run: summarize(await this.requireRun(reservation.relayRunId)),
        idempotentReplay: true,
      };
    }
    await this.launchSingleFlight(
      run,
      input.idempotencyKey,
      input.confirmedDangerousPermission,
    );
    return {
      run: summarize(await this.requireRun(relayRunId)),
      idempotentReplay: false,
    };
  }

  async replyRun(
    input: Omit<StartRunInput, "workspace" | "model"> & {
      parentRunId: string;
      model?: ModelSelection | undefined;
    },
    callerScope = "stdio-process",
  ) {
    const parent = await this.requireRun(input.parentRunId);
    if (!TERMINAL.has(parent.status))
      throw new RelayError("PARENT_NOT_TERMINAL", "只能续接已结束的运行");
    return await this.startRun(
      {
        ...input,
        workspace: parent.workspace,
        model: input.model ?? parent.model,
        permission: input.permission ?? parent.permission,
      },
      callerScope,
    );
  }

  async getRun(relayRunId: string): Promise<RelayRunSummary> {
    const run = await this.requireRun(relayRunId);
    await this.ensureAttached(run);
    return summarize(await this.requireRun(relayRunId));
  }

  async listRuns(limit = 50): Promise<{ runs: RelayRunSummary[] }> {
    const state = await this.store.read();
    const runs = Object.values(state.runs)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, Math.min(Math.max(limit, 1), 200));
    return { runs: runs.map(summarize) };
  }

  async readEvents(relayRunId: string, afterSequence = 0, limit = 100) {
    const existing = await this.requireRun(relayRunId);
    await this.ensureAttached(existing);
    const run = await this.requireRun(relayRunId);
    const events = run.events
      .filter((event) => event.sequence > afterSequence)
      .slice(0, Math.min(Math.max(limit, 1), 500));
    return {
      relayRunId,
      events,
      nextSequence: events.at(-1)?.sequence ?? afterSequence,
      status: run.status,
    };
  }

  async waitRun(relayRunId: string, waitMs = 30_000) {
    const existing = await this.requireRun(relayRunId);
    await this.ensureAttached(existing);
    const run = await this.requireRun(relayRunId);
    if (TERMINAL.has(run.status)) return waitPayload(run);
    const monitor = this.monitors.get(relayRunId);
    if (monitor)
      await Promise.race([
        monitor,
        delay(Math.min(Math.max(waitMs, 0), 30_000)),
      ]);
    else await delay(Math.min(Math.max(waitMs, 0), 30_000));
    return waitPayload(await this.requireRun(relayRunId));
  }

  async cancelRun(relayRunId: string) {
    const run = await this.requireRun(relayRunId);
    if (TERMINAL.has(run.status))
      return { run: summarize(run), alreadyTerminal: true };
    if (run.sdkRunId) {
      const handle = await this.sdk.getRun(run.sdkRunId, run.workspace);
      try {
        await handle.cancel();
      } catch (error) {
        const current = await this.requireRun(relayRunId);
        if (TERMINAL.has(current.status))
          return { run: summarize(current), alreadyTerminal: true };
        throw error;
      }
    }
    const applied = await this.patchRun(relayRunId, { status: "cancelled" });
    const monitor = this.monitors.get(relayRunId);
    if (monitor) await monitor;
    return {
      run: summarize(await this.requireRun(relayRunId)),
      alreadyTerminal: !applied,
    };
  }

  private async launch(
    run: RelayRun,
    idempotencyKey: string,
    confirmedDangerousPermission = false,
  ) {
    const launchOptions = this.launchOptions(
      run,
      idempotencyKey,
      confirmedDangerousPermission,
    );
    let handle: CursorRunHandle;
    try {
      handle = run.parentRunId
        ? await this.sdk.reply(run.agentId, run.task, launchOptions)
        : await this.sdk.start(run.task, launchOptions);
      const applied = await this.patchRun(
        run.relayRunId,
        {
          sdkRunId: handle.id,
          ...(handle.requestId === undefined
            ? {}
            : { requestId: handle.requestId }),
          status: "running",
        },
        ["starting"],
      );
      if (!applied) {
        try {
          await handle.cancel();
          if (handle.supports("wait")) await handle.wait();
        } catch {
          /* A persisted terminal state remains authoritative. */
        } finally {
          if (handle.status !== "running") await handle.release();
        }
        return;
      }
    } catch (error) {
      const relayError = asRelayError(error, "SDK_START_FAILED");
      await this.patchRun(run.relayRunId, {
        status: "failed",
        error: relayError.toJSON(),
      });
      throw relayError;
    }
    this.attachMonitor(run.relayRunId, handle);
  }

  private async launchSingleFlight(
    run: RelayRun,
    idempotencyKey: string,
    confirmedDangerousPermission = false,
  ): Promise<void> {
    const pending = this.launches.get(run.relayRunId);
    if (pending) return await pending;
    const launch = this.launch(
      run,
      idempotencyKey,
      confirmedDangerousPermission,
    ).finally(() => this.launches.delete(run.relayRunId));
    this.launches.set(run.relayRunId, launch);
    await launch;
  }

  private async ensureAttached(
    run: RelayRun,
    confirmedDangerousPermission = false,
  ) {
    if (TERMINAL.has(run.status) || this.monitors.has(run.relayRunId)) return;
    const pendingLaunch = this.launches.get(run.relayRunId);
    if (pendingLaunch) {
      await pendingLaunch;
      return;
    }
    if (run.sdkRunId) {
      try {
        const handle = await this.sdk.getRun(run.sdkRunId, run.workspace);
        if (Date.now() >= Date.parse(run.deadlineAt)) {
          await this.expire(run, handle);
        } else {
          this.attachMonitor(run.relayRunId, handle);
        }
      } catch (error) {
        const relayError = asRelayError(error, "SDK_RESUME_FAILED");
        await this.patchRun(run.relayRunId, {
          status: "failed",
          error: relayError.toJSON(),
        });
      }
      return;
    }
    let recovered: CursorRunHandle | undefined;
    try {
      recovered = await this.sdk.findRun(
        run.agentId,
        run.workspace,
        Date.parse(run.createdAt),
      );
    } catch (error) {
      if (Date.now() < Date.parse(run.deadlineAt)) throw error;
      const relayError = asRelayError(error, "SDK_RESUME_FAILED");
      await this.patchRun(
        run.relayRunId,
        { status: "failed", error: relayError.toJSON() },
        ["starting", "running"],
      );
      return;
    }
    if (recovered) {
      const applied = await this.patchRun(
        run.relayRunId,
        { sdkRunId: recovered.id, status: "running" },
        ["starting"],
      );
      if (applied) {
        if (Date.now() >= Date.parse(run.deadlineAt))
          await this.expire(run, recovered);
        else this.attachMonitor(run.relayRunId, recovered);
      }
      return;
    }
    if (Date.now() >= Date.parse(run.deadlineAt)) {
      await this.expire(run);
      return;
    }
    const state = await this.store.read();
    const operation = Object.entries(state.operations).find(
      ([, value]) => value.relayRunId === run.relayRunId,
    );
    if (!operation) throw new RelayError("STATE_CORRUPT", "运行缺少幂等索引");
    await this.launchSingleFlight(
      run,
      operation[0],
      confirmedDangerousPermission,
    );
  }

  private attachMonitor(relayRunId: string, handle: CursorRunHandle) {
    if (this.monitors.has(relayRunId)) return;
    const monitor = this.monitor(relayRunId, handle)
      .catch(async (error: unknown) => {
        const relayError = asRelayError(error, "SDK_MONITOR_FAILED");
        try {
          await this.patchRun(
            relayRunId,
            { status: "failed", error: relayError.toJSON() },
            ["starting", "running"],
          );
        } catch {
          /* The monitor must never create an unhandled rejection. */
        }
      })
      .finally(() => this.monitors.delete(relayRunId));
    this.monitors.set(relayRunId, monitor);
  }

  private async monitor(relayRunId: string, handle: CursorRunHandle) {
    const run = await this.requireRun(relayRunId);
    const remaining = Math.max(0, Date.parse(run.deadlineAt) - Date.now());
    const flow = this.consumeThenWait(relayRunId, handle);
    try {
      const raced = await raceWithDeadline(flow, remaining);
      if (raced.kind === "outcome") {
        await this.finishFromOutcome(relayRunId, raced.outcome);
        return;
      }
      const terminalSnapshot = handle.currentResult();
      if (terminalSnapshot) {
        await this.finishFromOutcome(relayRunId, terminalSnapshot);
        return;
      }
      const grace = await raceWithDeadline(flow, DEADLINE_GRACE_MS);
      if (grace.kind === "outcome") {
        await this.finishFromOutcome(relayRunId, grace.outcome);
        return;
      }
      try {
        if (handle.supports("cancel")) await handle.cancel();
      } catch {
        /* The relay timeout remains authoritative. */
      }
      const settled = await raceWithDeadline(
        flow.catch(() => undefined),
        CANCEL_SETTLE_MS,
      );
      if (
        settled.kind === "outcome" &&
        settled.outcome?.status === "finished"
      ) {
        await this.finishFromOutcome(relayRunId, settled.outcome);
        return;
      }
      await this.patchRun(
        relayRunId,
        {
          status: "failed",
          error: {
            code: "RUN_TIMEOUT",
            message: "Cursor 运行超过总超时",
            retryable: true,
          },
        },
        ["starting", "running"],
      );
    } finally {
      if (handle.status !== "running") await handle.release();
    }
  }

  private async consumeThenWait(
    relayRunId: string,
    handle: CursorRunHandle,
  ): Promise<CursorRunResult> {
    if (handle.supports("stream")) {
      try {
        await this.captureEvents(relayRunId, handle);
      } catch (error) {
        await this.appendEvent(relayRunId, "stream_error", {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (!handle.supports("wait")) {
      throw new RelayError(
        "SDK_OPERATION_UNSUPPORTED",
        "Cursor SDK 运行不支持 wait",
      );
    }
    return await handle.wait();
  }

  private async captureEvents(relayRunId: string, handle: CursorRunHandle) {
    for await (const event of handle.stream())
      await this.appendEvent(relayRunId, event.type, sanitizeEvent(event));
  }

  private async appendEvent(relayRunId: string, type: string, data: unknown) {
    const boundedData = boundEventData(data);
    await this.store.update((state) => {
      const run = state.runs[relayRunId];
      if (!run)
        throw new RelayError("RUN_NOT_FOUND", `运行不存在：${relayRunId}`);
      const sequence = (run.events.at(-1)?.sequence ?? 0) + 1;
      run.events.push({
        sequence,
        timestamp: new Date().toISOString(),
        type,
        data: boundedData,
      });
      if (run.events.length > this.config.maxEventsPerRun)
        run.events.splice(0, run.events.length - this.config.maxEventsPerRun);
      run.updatedAt = new Date().toISOString();
    });
  }

  private async expire(run: RelayRun, attached?: CursorRunHandle) {
    let handle = attached;
    if (!handle && run.sdkRunId) {
      try {
        handle = await this.sdk.getRun(run.sdkRunId, run.workspace);
      } catch {
        /* A missing handle cannot prevent recording the elapsed deadline. */
      }
    }
    const terminalSnapshot = handle?.currentResult();
    if (terminalSnapshot) {
      await this.finishFromOutcome(run.relayRunId, terminalSnapshot);
      return;
    }
    let terminal: Promise<CursorRunResult> | undefined;
    if (handle?.supports("wait")) {
      terminal = handle.wait();
      const grace = await raceWithDeadline(
        terminal.catch(() => undefined),
        DEADLINE_GRACE_MS,
      );
      if (grace.kind === "outcome" && grace.outcome) {
        await this.finishFromOutcome(run.relayRunId, grace.outcome);
        if (handle.currentResult()) await handle.release();
        return;
      }
    }
    if (handle?.status === "running" && handle.supports("cancel")) {
      try {
        await handle.cancel();
      } catch {
        /* still record timeout */
      }
    }
    if (terminal) {
      const settled = await raceWithDeadline(
        terminal.catch(() => undefined),
        CANCEL_SETTLE_MS,
      );
      if (
        settled.kind === "outcome" &&
        settled.outcome &&
        settled.outcome.status !== "cancelled"
      ) {
        await this.finishFromOutcome(run.relayRunId, settled.outcome);
        if (handle?.currentResult()) await handle.release();
        return;
      }
    }
    if (handle?.currentResult()) await handle.release();
    await this.patchRun(run.relayRunId, {
      status: "failed",
      error: {
        code: "RUN_TIMEOUT",
        message: "Cursor 运行超过总超时",
        retryable: true,
      },
    });
  }

  private async patchRun(
    relayRunId: string,
    patch: Partial<RelayRun>,
    expectedStatuses?: RelayRunStatus[],
  ): Promise<boolean> {
    return await this.store.update((state) => {
      const run = state.runs[relayRunId];
      if (!run)
        throw new RelayError("RUN_NOT_FOUND", `运行不存在：${relayRunId}`);
      if (expectedStatuses && !expectedStatuses.includes(run.status))
        return false;
      if (patch.status !== undefined && TERMINAL.has(run.status)) return false;
      Object.assign(run, patch, { updatedAt: new Date().toISOString() });
      return true;
    });
  }

  private async finishFromOutcome(
    relayRunId: string,
    outcome: CursorRunResult,
  ): Promise<void> {
    const metadata = outcomeMetadata(outcome);
    if (outcome.status === "finished") {
      await this.patchRun(relayRunId, {
        status: "succeeded",
        ...metadata,
        ...(outcome.result === undefined
          ? {}
          : { assistantText: outcome.result }),
      });
    } else if (outcome.status === "cancelled") {
      await this.patchRun(relayRunId, { status: "cancelled", ...metadata });
    } else {
      await this.patchRun(relayRunId, {
        status: "failed",
        ...metadata,
        error: {
          code: outcome.error?.code ?? "SDK_RUN_FAILED",
          message: outcome.error?.message ?? "Cursor 运行失败",
          retryable: false,
        },
      });
    }
  }

  private async requireRun(relayRunId: string): Promise<RelayRun> {
    const run = (await this.store.read()).runs[relayRunId];
    if (!run)
      throw new RelayError("RUN_NOT_FOUND", `运行不存在：${relayRunId}`);
    return run;
  }

  private async validateModel(
    selection: ModelSelection,
  ): Promise<ModelSelection> {
    const duplicate = findDuplicate(
      selection.params?.map((param) => param.id) ?? [],
    );
    if (duplicate) {
      throw new RelayError(
        "MODEL_PARAMETER_DUPLICATE",
        `模型参数重复：${duplicate}`,
      );
    }
    let models = await this.getModels();
    let model = models.find(
      (item) =>
        item.id === selection.id || item.aliases?.includes(selection.id),
    );
    if (!model) {
      models = await this.getModels(true);
      model = models.find(
        (item) =>
          item.id === selection.id || item.aliases?.includes(selection.id),
      );
    }
    if (!model)
      throw new RelayError(
        "MODEL_NOT_FOUND",
        `当前 Cursor 账户不可用模型：${selection.id}`,
      );
    const params = [...(selection.params ?? [])].sort((a, b) =>
      a.id.localeCompare(b.id),
    );
    const selected = new Map(params.map((param) => [param.id, param.value]));
    const matchesVariant =
      params.length > 0 &&
      model.variants?.some((variant) => {
        if (variant.params.length !== selected.size) return false;
        return variant.params.every(
          (param) => selected.get(param.id) === param.value,
        );
      }) === true;
    for (const param of params) {
      const definition = model.parameters?.find(
        (candidate) => candidate.id === param.id,
      );
      if (
        !definition?.values.some(
          (candidate) => candidate.value === param.value,
        ) &&
        !matchesVariant
      ) {
        throw new RelayError(
          "MODEL_PARAMETER_INVALID",
          `模型参数无效：${param.id}=${param.value}`,
        );
      }
    }
    return {
      id: model.id,
      ...(params.length === 0 ? {} : { params }),
    };
  }

  private async getModels(forceRefresh = false): Promise<CursorModel[]> {
    if (
      !forceRefresh &&
      this.modelCache &&
      this.modelCache.expiresAt > Date.now()
    ) {
      return this.modelCache.models;
    }
    if (this.modelRefresh) return await this.modelRefresh;
    const refresh = this.sdk
      .listModels()
      .then((models) => {
        this.modelCache = {
          models,
          expiresAt: Date.now() + MODEL_CACHE_TTL_MS,
        };
        return models;
      })
      .finally(() => {
        this.modelRefresh = undefined;
      });
    this.modelRefresh = refresh;
    return await refresh;
  }

  private normalizeTimeout(timeoutMs?: number) {
    const value = timeoutMs ?? this.config.defaultTimeoutMs;
    if (
      !Number.isSafeInteger(value) ||
      value < 1_000 ||
      value > this.config.maxTimeoutMs
    ) {
      throw new RelayError(
        "TIMEOUT_INVALID",
        `timeoutMs 必须在 1000 到 ${this.config.maxTimeoutMs} 之间`,
      );
    }
    return value;
  }

  private launchOptions(
    run: RelayRun,
    idempotencyKey: string,
    confirmedDangerousPermission: boolean,
  ): AgentLaunchOptions {
    const permission = permissionOptions(
      run.permission,
      confirmedDangerousPermission || run.dangerousPermissionConfirmed === true,
      this.config.dangerFullAccessEnabled,
      this.config.readOnlySandboxEnabled,
    );
    return {
      agentId: run.agentId,
      idempotencyKey,
      workspace: run.workspace,
      model: run.model,
      ...(permission.tools ? { tools: permission.tools } : {}),
      ...(permission.disallowedTools
        ? { disallowedTools: permission.disallowedTools }
        : {}),
      sandboxEnabled: permission.sandboxEnabled,
      autoReview: permission.autoReview,
      settingSources: this.config.settingSources,
    };
  }
}

function waitPayload(run: RelayRun) {
  const terminal = TERMINAL.has(run.status);
  return {
    run: summarize(run),
    terminal,
    mustCallAgain: !terminal,
    ...(terminal
      ? {}
      : {
          nextPollAfterMs: 1_000,
          instruction: "运行仍在继续；请再次调用 wait_run，直到 terminal=true",
        }),
  };
}

function stableId(prefix: string, key: string): string {
  const hex = createHash("sha256")
    .update(key, "utf8")
    .digest("hex")
    .slice(0, 32);
  return `${prefix}-${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function raceWithDeadline<T>(
  promise: Promise<T>,
  ms: number,
): Promise<{ kind: "outcome"; outcome: T } | { kind: "timeout" }> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then((outcome) => ({ kind: "outcome" as const, outcome })),
      new Promise<{ kind: "timeout" }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: "timeout" }), ms);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
function sanitizeEvent(event: CursorEvent): unknown {
  const copy = structuredClone(event) as Record<string, unknown>;
  delete copy.type;
  return redact(copy);
}
function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value !== "object" || value === null) return value;
  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    output[key] = /authorization|api[-_]?key|password|secret|token/iu.test(key)
      ? "[REDACTED]"
      : redact(nested);
  }
  return output;
}

function boundEventData(data: unknown): unknown {
  const json = JSON.stringify({ data });
  const bytes = Buffer.from(json, "utf8");
  if (bytes.length <= MAX_EVENT_DATA_BYTES) return data;
  return {
    truncated: true,
    originalBytes: bytes.length,
    previewUtf8: bytes.subarray(0, 6 * 1024).toString("utf8"),
    redactionScope: "sensitive-field-names-only",
  };
}

function summarize(run: RelayRun): RelayRunSummary {
  const { events, ...summary } = run;
  return { ...summary, eventCount: events.length };
}

function outcomeMetadata(outcome: CursorRunResult): Partial<RelayRun> {
  return {
    ...(outcome.requestId === undefined
      ? {}
      : { requestId: outcome.requestId }),
    ...(outcome.model === undefined ? {} : { effectiveModel: outcome.model }),
    ...(outcome.durationMs === undefined
      ? {}
      : { durationMs: outcome.durationMs }),
    ...(outcome.usage === undefined ? {} : { usage: outcome.usage }),
  };
}

function findDuplicate(values: string[]): string | undefined {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return undefined;
}
