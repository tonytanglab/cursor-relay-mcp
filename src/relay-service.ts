import { createHash } from "node:crypto";
import { RelayError, asRelayError } from "./errors.js";
import {
  normalizeCodexAllowedTools,
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
import {
  buildCursorWorkspaceTask,
  normalizeTargetLocations,
  normalizeTaskScope,
} from "./task-contract.js";
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
const MAX_COALESCED_TEXT_BYTES = 6 * 1024;
const DEADLINE_GRACE_MS = 500;
const CANCEL_SETTLE_MS = 10_000;
const CANCEL_REQUEST_GRACE_MS = 1_000;
const CANCEL_MONITOR_DRAIN_MS = 250;

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
      ...(authentication.mode === "stored-login" && authentication.email
        ? { authenticationEmail: authentication.email }
        : {}),
      ...(authentication.mode === "stored-login" && authentication.backendUrl
        ? { authenticationBackendUrl: authentication.backendUrl }
        : {}),
      ...(authentication.mode === "stored-login" &&
      authentication.expiresAtMs !== undefined
        ? { authenticationExpiresAtMs: authentication.expiresAtMs }
        : {}),
      stateFile: this.store.path,
      workspaceRoots: this.config.workspaceRoots,
      dangerFullAccessEnabled: this.config.dangerFullAccessEnabled,
      readOnlySandboxEnabled: this.config.readOnlySandboxEnabled,
      workspaceWriteSandboxEnabled: this.config.workspaceWriteSandboxEnabled,
      settingSources: this.config.settingSources,
      defaultTimeoutMs: this.config.defaultTimeoutMs,
      maxTimeoutMs: this.config.maxTimeoutMs,
      capabilities: {
        liveRunPanel: true,
        workspaceReadsSourceDirectly: true,
        embeddedSourceArgumentsRejected: true,
        cursorManagedNetworkAccess: true,
        transientReconnectKeepsRunAlive: true,
        activeRunSteering: false,
        activeRunSteeringReason:
          "@cursor/sdk 1.0.28 的公开 Run API 仅支持 stream、wait、cancel 与 conversation；Relay 不会把内部事件追加伪装成已向运行中的 Agent 送达纠偏指令",
      },
      warning:
        authentication.mode === "missing"
          ? "未配置 CURSOR_API_KEY，且没有官方 Cursor SDK stored login"
          : undefined,
    };
  }

  async listModels() {
    return { models: await this.getModels() };
  }

  async reauthenticateCursorAccount() {
    const authentication = await this.sdk.reauthenticate();
    this.modelCache = undefined;
    this.modelRefresh = undefined;
    return {
      authentication: authentication.mode,
      ...(authentication.email
        ? { authenticationEmail: authentication.email }
        : {}),
      authenticationExpiresAtMs: authentication.expiresAtMs,
      instruction:
        "已替换 Cursor SDK stored login；请立即调用 list_models 验证该账户的实际模型权限。",
    };
  }

  async authorizeConversationWorkspace(
    input: AuthorizeWorkspaceInput,
    callerScope = "stdio-process",
  ) {
    const workspace = await resolveWorkspace(input.workspace);
    const permission = input.permission ?? "read-only";
    if (permission === "danger-full-access") {
      throw new RelayError(
        "WORKSPACE_APPROVAL_PERMISSION_DENIED",
        "当前对话工作区授权不允许 danger-full-access；危险权限仍须静态白名单与二次确认",
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
      permission,
      callerScope,
    });
    return {
      authorizationRequired: true,
      workspace,
      permission,
      source: "conversation-capability" as const,
      ...grant,
      instruction: `在当前对话后续运行中，用相同 workspace 和不高于 ${permission} 的权限调用 start_run 或 reply_run，并传入 workspaceApprovalToken；只传 targetLocations 与 task 范围，禁止嵌入源码正文，由 Cursor 在获授权工作区自行读取。令牌只显示一次但可在本对话内复用。`,
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
    const codexAllowedTools = normalizeCodexAllowedTools(
      input.codexAllowedTools,
    );
    const conversationPermission =
      permission === "danger-full-access" ? undefined : permission;
    if (!staticallyAllowed && conversationPermission === undefined) {
      throw new RelayError(
        "WORKSPACE_DENIED",
        "工作区不在静态白名单内；当前对话授权不能授予 danger-full-access",
      );
    }
    permissionOptions(
      permission,
      input.confirmedDangerousPermission,
      this.config.dangerFullAccessEnabled,
      this.config.readOnlySandboxEnabled,
      this.config.workspaceWriteSandboxEnabled,
      codexAllowedTools,
    );
    const timeoutMs = this.normalizeTimeout(input.timeoutMs);
    const model = await this.validateModel(input.model);
    const task = normalizeTaskScope(input.task);
    const targetLocations = normalizeTargetLocations(input.targetLocations);
    const normalized = {
      ...input,
      workspace,
      task,
      targetLocations,
      model,
      permission,
      codexAllowedTools,
      timeoutMs,
    };
    const fingerprint = hash(
      JSON.stringify({
        workspace,
        task,
        targetLocations,
        model,
        permission,
        codexAllowedTools,
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
      permission: conversationPermission ?? "read-only",
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
      task,
      ...(targetLocations.length > 0 ? { targetLocations } : {}),
      model,
      permission,
      codexAllowedTools,
      workspaceAuthorization: staticallyAllowed
        ? { source: "static-allowlist" }
        : {
            source: "conversation-capability",
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
        targetLocations: input.targetLocations ?? parent.targetLocations,
        codexAllowedTools: input.codexAllowedTools ?? parent.codexAllowedTools,
      },
      callerScope,
    );
  }

  async getRun(relayRunId: string): Promise<RelayRunSummary> {
    const run = await this.requireRun(relayRunId);
    await this.ensureAttached(run);
    return summarize(await this.requireRun(relayRunId));
  }

  async getRunSnapshot(relayRunId: string): Promise<RelayRunSummary> {
    return summarize(await this.requireRun(relayRunId));
  }

  async listRuns(limit = 50): Promise<{ runs: RelayRunSummary[] }> {
    const state = await this.store.read();
    const runs = Object.values(state.runs)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, Math.min(Math.max(limit, 1), 200));
    return { runs: runs.map((run) => summarize(run)) };
  }

  async readEvents(relayRunId: string, afterSequence = 0, limit = 100) {
    const existing = await this.requireRun(relayRunId);
    const connectionError =
      await this.ensureAttachedOrConnectionError(existing);
    const run = await this.requireRun(relayRunId);
    const events = run.events
      .filter((event) => event.sequence > afterSequence)
      .slice(0, Math.min(Math.max(limit, 1), 500));
    return {
      relayRunId,
      events,
      nextSequence: events.at(-1)?.sequence ?? afterSequence,
      status: run.status,
      ...(connectionError
        ? {
            connection: {
              state: "reconnecting" as const,
              error: connectionError,
            },
          }
        : {}),
    };
  }

  async waitRun(relayRunId: string, waitMs = 30_000) {
    const existing = await this.requireRun(relayRunId);
    const connectionError =
      await this.ensureAttachedOrConnectionError(existing);
    const run = await this.requireRun(relayRunId);
    if (TERMINAL.has(run.status)) return waitPayload(run);
    if (connectionError) {
      await delay(Math.min(Math.max(waitMs, 0), 1_000));
      return waitPayload(await this.requireRun(relayRunId), connectionError);
    }
    const monitor = this.monitors.get(relayRunId);
    if (monitor)
      await Promise.race([
        monitor,
        delay(Math.min(Math.max(waitMs, 0), 30_000)),
      ]);
    else await delay(Math.min(Math.max(waitMs, 0), 30_000));
    return waitPayload(await this.requireRun(relayRunId));
  }

  private async ensureAttachedOrConnectionError(
    run: RelayRun,
  ): Promise<ReturnType<RelayError["toJSON"]> | undefined> {
    try {
      await this.ensureAttached(run);
      return undefined;
    } catch (error) {
      const relayError = asRelayError(error, "SDK_RESUME_FAILED");
      if (!relayError.retryable || Date.now() >= Date.parse(run.deadlineAt)) {
        throw relayError;
      }
      return relayError.toJSON();
    }
  }

  async cancelRun(relayRunId: string) {
    const run = await this.requireRun(relayRunId);
    if (TERMINAL.has(run.status))
      return { run: summarize(run), alreadyTerminal: true };
    if (run.sdkRunId) {
      const handle = await this.sdk.getRun(run.sdkRunId, run.workspace);
      try {
        await raceWithDeadline(handle.cancel(), CANCEL_REQUEST_GRACE_MS);
      } catch (error) {
        const current = await this.requireRun(relayRunId);
        if (TERMINAL.has(current.status))
          return { run: summarize(current), alreadyTerminal: true };
        throw error;
      } finally {
        await handle.release();
      }
    }
    const applied = await this.patchRun(relayRunId, { status: "cancelled" });
    const monitor = this.monitors.get(relayRunId);
    if (monitor) await raceWithDeadline(monitor, CANCEL_MONITOR_DRAIN_MS);
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
      const cursorTask = buildCursorWorkspaceTask(
        run.task,
        run.targetLocations ?? [],
        run.permission,
      );
      handle = run.parentRunId
        ? await this.sdk.reply(run.agentId, cursorTask, launchOptions)
        : await this.sdk.start(cursorTask, launchOptions);
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
        if (relayError.retryable && Date.now() < Date.parse(run.deadlineAt)) {
          throw relayError;
        }
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
      if (await this.finishFromCurrentResult(relayRunId, handle, true)) return;
      try {
        if (handle.supports("cancel")) await handle.cancel();
      } catch {
        /* The relay timeout remains authoritative. */
      }
      if (await this.finishFromCurrentResult(relayRunId, handle, false)) return;
      const settled = await raceWithDeadline(
        flow.catch(() => undefined),
        CANCEL_SETTLE_MS,
      );
      if (
        settled.kind === "outcome" &&
        settled.outcome &&
        settled.outcome.status !== "cancelled"
      ) {
        await this.finishFromOutcome(relayRunId, settled.outcome);
        return;
      }
      if (await this.finishFromCurrentResult(relayRunId, handle, false)) return;
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
      await handle.release();
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
    let pending: CoalescedTextEvent | undefined;
    const emit = async (event: CoalescedTextEvent, text: string) => {
      await this.appendEvent(
        relayRunId,
        event.type,
        coalescedEventData(event, text),
      );
    };
    const flush = async () => {
      if (!pending) return;
      const current = pending;
      pending = undefined;
      if (!current.text.trim()) return;
      await emit(current, current.text);
    };
    const flushParagraphs = async () => {
      while (pending) {
        const end = firstParagraphEnd(pending.text);
        if (end < 0) return;
        const current = pending;
        const remainder = current.text.slice(end);
        await emit(current, current.text.slice(0, end));
        pending = remainder ? { ...current, text: remainder } : undefined;
      }
    };
    const appendText = async (event: CoalescedTextEvent) => {
      const codePoints = Array.from(event.text);
      if (!pending || !sameTextStream(pending, event)) {
        await flush();
      }
      if (codePoints.length === 0) return;
      pending ??= { ...event, text: "" };
      let offset = 0;
      while (offset < codePoints.length) {
        pending ??= { ...event, text: "" };
        const count = fittingCodePointCount(pending, codePoints, offset);
        if (count === 0) {
          if (pending.text) {
            await flush();
          } else {
            throw new RelayError(
              "SDK_EVENT_TOO_LARGE",
              "Cursor SDK 文本事件标识超出安全事件上限",
            );
          }
        } else {
          pending.text += codePoints.slice(offset, offset + count).join("");
          offset += count;
          await flushParagraphs();
          if (offset < codePoints.length) await flush();
        }
      }
    };

    try {
      for await (const event of handle.stream()) {
        const textEvent = coalescibleTextEvent(event);
        if (textEvent) await appendText(textEvent);
        else {
          await flush();
          await this.appendEvent(relayRunId, event.type, sanitizeEvent(event));
        }
      }
    } finally {
      await flush();
    }
  }

  private async appendEvent(relayRunId: string, type: string, data: unknown) {
    const current = await this.requireRun(relayRunId);
    if (TERMINAL.has(current.status)) return;
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
    try {
      if (
        handle &&
        (await this.finishFromCurrentResult(run.relayRunId, handle, true))
      ) {
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
          return;
        }
        if (await this.finishFromCurrentResult(run.relayRunId, handle, true))
          return;
      }
      if (handle?.status === "running" && handle.supports("cancel")) {
        try {
          await handle.cancel();
        } catch {
          /* still record timeout */
        }
        if (await this.finishFromCurrentResult(run.relayRunId, handle, false))
          return;
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
          return;
        }
      }
      if (
        handle &&
        (await this.finishFromCurrentResult(run.relayRunId, handle, false))
      ) {
        return;
      }
      await this.patchRun(run.relayRunId, {
        status: "failed",
        error: {
          code: "RUN_TIMEOUT",
          message: "Cursor 运行超过总超时",
          retryable: true,
        },
      });
    } finally {
      if (handle) await handle.release();
    }
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

  private async finishFromCurrentResult(
    relayRunId: string,
    handle: CursorRunHandle,
    includeCancelled: boolean,
  ): Promise<boolean> {
    const outcome = handle.currentResult();
    if (!outcome || (!includeCancelled && outcome.status === "cancelled"))
      return false;
    await this.finishFromOutcome(relayRunId, outcome);
    return true;
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
      this.config.workspaceWriteSandboxEnabled,
      run.codexAllowedTools,
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

function waitPayload(
  run: RelayRun,
  connectionError?: ReturnType<RelayError["toJSON"]>,
) {
  const terminal = TERMINAL.has(run.status);
  return {
    run: summarize(run, connectionError),
    terminal,
    mustCallAgain: !terminal,
    ...(terminal
      ? {}
      : {
          nextPollAfterMs: 1_000,
          instruction: connectionError
            ? "Cursor SDK 暂时不可达，运行仍保持非终态；请继续调用 wait_run 以自动重连"
            : "运行仍在继续；请再次调用 wait_run，直到 terminal=true",
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
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface CoalescedTextEvent {
  type: "thinking" | "assistant";
  agentId: string;
  runId: string;
  text: string;
}

function coalescibleTextEvent(
  event: CursorEvent,
): CoalescedTextEvent | undefined {
  const record = event as Record<string, unknown>;
  if (
    typeof record.agent_id !== "string" ||
    typeof record.run_id !== "string"
  ) {
    return undefined;
  }
  if (
    record.type === "thinking" &&
    typeof record.text === "string" &&
    hasOnlyKeys(record, ["type", "agent_id", "run_id", "text"])
  ) {
    return {
      type: "thinking",
      agentId: record.agent_id,
      runId: record.run_id,
      text: record.text,
    };
  }
  if (
    record.type !== "assistant" ||
    !hasOnlyKeys(record, ["type", "agent_id", "run_id", "message"]) ||
    !isRecord(record.message) ||
    record.message.role !== "assistant" ||
    !hasOnlyKeys(record.message, ["role", "content"]) ||
    !Array.isArray(record.message.content) ||
    record.message.content.length === 0 ||
    !record.message.content.every(
      (block) =>
        isRecord(block) &&
        block.type === "text" &&
        typeof block.text === "string" &&
        hasOnlyKeys(block, ["type", "text"]),
    )
  ) {
    return undefined;
  }
  return {
    type: "assistant",
    agentId: record.agent_id,
    runId: record.run_id,
    text: record.message.content
      .map((block) => (block as { text: string }).text)
      .join(""),
  };
}

function coalescedEventData(event: CoalescedTextEvent, text: string): unknown {
  const identity = { agent_id: event.agentId, run_id: event.runId };
  return event.type === "thinking"
    ? { ...identity, text }
    : {
        ...identity,
        message: {
          role: "assistant",
          content: [{ type: "text", text }],
        },
      };
}

function sameTextStream(
  left: CoalescedTextEvent,
  right: CoalescedTextEvent,
): boolean {
  return (
    left.type === right.type &&
    left.agentId === right.agentId &&
    left.runId === right.runId
  );
}

function fittingCodePointCount(
  pending: CoalescedTextEvent,
  codePoints: string[],
  offset: number,
): number {
  let low = 0;
  let high = codePoints.length - offset;
  while (low < high) {
    const candidate = Math.ceil((low + high) / 2);
    const text =
      pending.text + codePoints.slice(offset, offset + candidate).join("");
    const data = coalescedEventData(pending, text);
    if (
      Buffer.byteLength(text, "utf8") <= MAX_COALESCED_TEXT_BYTES &&
      eventDataBytes(data) <= MAX_EVENT_DATA_BYTES
    ) {
      low = candidate;
    } else {
      high = candidate - 1;
    }
  }
  return low;
}

function eventDataBytes(data: unknown): number {
  return Buffer.byteLength(JSON.stringify({ data }), "utf8");
}

function firstParagraphEnd(text: string): number {
  for (const match of text.matchAll(/(?:\r?\n){2,}/gu)) {
    const end = match.index + match[0].length;
    if (text.slice(0, match.index).trim() && text.slice(end).trim()) return end;
  }
  return -1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === allowed.length && keys.every((key) => allowed.includes(key))
  );
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

function summarize(
  run: RelayRun,
  connectionError?: ReturnType<RelayError["toJSON"]>,
): RelayRunSummary {
  const { events, ...summary } = run;
  return {
    ...summary,
    eventCount: events.length,
    ...(connectionError
      ? {
          connection: {
            state: "reconnecting" as const,
            error: connectionError,
          },
        }
      : {}),
  };
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
