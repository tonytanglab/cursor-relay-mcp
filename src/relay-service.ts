import { createHash } from "node:crypto";
import { RelayError, asRelayError } from "./errors.js";
import {
  authorizeWorkspace,
  permissionOptions,
  type RelayConfig,
} from "./config.js";
import type {
  AgentLaunchOptions,
  CursorEvent,
  CursorRunHandle,
  CursorRunResult,
  CursorSdkPort,
} from "./sdk-port.js";
import { StateStore } from "./state-store.js";
import type {
  ModelSelection,
  RelayRun,
  RelayRunStatus,
  StartRunInput,
} from "./types.js";

const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);

export class RelayService {
  private readonly monitors = new Map<string, Promise<void>>();

  constructor(
    private readonly config: RelayConfig,
    private readonly store: StateStore,
    private readonly sdk: CursorSdkPort,
  ) {}

  doctor() {
    return {
      ok: Boolean(this.config.apiKey),
      sdkVersion: "1.0.28",
      authentication: this.config.apiKey ? "configured" : "missing",
      stateFile: this.store.path,
      workspaceRoots: this.config.workspaceRoots,
      warning: this.config.apiKey
        ? undefined
        : "CURSOR_API_KEY 未配置；模型发现和运行将失败",
    };
  }

  async listModels() {
    this.requireAuthentication();
    return { models: await this.sdk.listModels() };
  }

  async startRun(
    input: StartRunInput,
  ): Promise<{ run: RelayRun; idempotentReplay: boolean }> {
    this.requireAuthentication();
    const workspace = await authorizeWorkspace(
      input.workspace,
      this.config.workspaceRoots,
    );
    const permission = input.permission ?? "read-only";
    permissionOptions(permission, input.confirmedDangerousPermission);
    const timeoutMs = this.normalizeTimeout(input.timeoutMs);
    const normalized = { ...input, workspace, permission, timeoutMs };
    const fingerprint = hash(
      JSON.stringify({
        workspace,
        task: input.task,
        model: input.model,
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
        run: await this.requireRun(run.relayRunId),
        idempotentReplay: true,
      };
    }

    await this.validateModel(input.model);

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
      model: input.model,
      permission,
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
    await this.store.update((state) => {
      const raced = state.operations[input.idempotencyKey];
      if (raced)
        throw new RelayError(
          "IDEMPOTENCY_RACE",
          "幂等请求发生并发竞争，请重试",
          { retryable: true },
        );
      state.runs[relayRunId] = run;
      state.operations[input.idempotencyKey] = { fingerprint, relayRunId };
    });
    await this.launch(
      run,
      input.idempotencyKey,
      input.confirmedDangerousPermission,
    );
    return { run: await this.requireRun(relayRunId), idempotentReplay: false };
  }

  async replyRun(
    input: Omit<StartRunInput, "workspace" | "model"> & {
      parentRunId: string;
      model?: ModelSelection | undefined;
    },
  ) {
    const parent = await this.requireRun(input.parentRunId);
    if (!TERMINAL.has(parent.status))
      throw new RelayError("PARENT_NOT_TERMINAL", "只能续接已结束的运行");
    return await this.startRun({
      ...input,
      workspace: parent.workspace,
      model: input.model ?? parent.model,
      permission: input.permission ?? parent.permission,
    });
  }

  async getRun(relayRunId: string): Promise<RelayRun> {
    const run = await this.requireRun(relayRunId);
    await this.ensureAttached(run);
    return await this.requireRun(relayRunId);
  }

  async listRuns(limit = 50): Promise<{ runs: RelayRun[] }> {
    const state = await this.store.read();
    const runs = Object.values(state.runs)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, Math.min(Math.max(limit, 1), 200));
    return { runs };
  }

  async readEvents(relayRunId: string, afterSequence = 0, limit = 100) {
    const run = await this.getRun(relayRunId);
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
    const run = await this.getRun(relayRunId);
    if (TERMINAL.has(run.status)) return waitPayload(run);
    const monitor = this.monitors.get(relayRunId);
    if (monitor)
      await Promise.race([
        monitor,
        delay(Math.min(Math.max(waitMs, 0), 30_000)),
      ]);
    else await delay(Math.min(Math.max(waitMs, 0), 30_000));
    return waitPayload(await this.getRun(relayRunId));
  }

  async cancelRun(relayRunId: string) {
    const run = await this.requireRun(relayRunId);
    if (TERMINAL.has(run.status)) return { run, alreadyTerminal: true };
    if (run.sdkRunId) {
      const handle = await this.sdk.getRun(run.sdkRunId, run.workspace);
      try {
        await handle.cancel();
      } catch (error) {
        const current = await this.requireRun(relayRunId);
        if (TERMINAL.has(current.status))
          return { run: current, alreadyTerminal: true };
        throw error;
      }
    }
    const applied = await this.patchRun(relayRunId, { status: "cancelled" });
    return {
      run: await this.requireRun(relayRunId),
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
        { sdkRunId: handle.id, status: "running" },
        ["starting"],
      );
      if (!applied) {
        try {
          await handle.cancel();
        } catch {
          /* A persisted terminal state remains authoritative. */
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

  private async ensureAttached(
    run: RelayRun,
    confirmedDangerousPermission = false,
  ) {
    if (TERMINAL.has(run.status) || this.monitors.has(run.relayRunId)) return;
    if (Date.now() >= Date.parse(run.deadlineAt)) {
      await this.expire(run);
      return;
    }
    if (run.sdkRunId) {
      try {
        this.attachMonitor(
          run.relayRunId,
          await this.sdk.getRun(run.sdkRunId, run.workspace),
        );
      } catch (error) {
        const relayError = asRelayError(error, "SDK_RESUME_FAILED");
        await this.patchRun(run.relayRunId, {
          status: "failed",
          error: relayError.toJSON(),
        });
      }
      return;
    }
    const recovered = await this.sdk.findRun(
      run.agentId,
      run.workspace,
      Date.parse(run.createdAt),
    );
    if (recovered) {
      const applied = await this.patchRun(
        run.relayRunId,
        { sdkRunId: recovered.id, status: "running" },
        ["starting"],
      );
      if (applied) this.attachMonitor(run.relayRunId, recovered);
      return;
    }
    const state = await this.store.read();
    const operation = Object.entries(state.operations).find(
      ([, value]) => value.relayRunId === run.relayRunId,
    );
    if (!operation) throw new RelayError("STATE_CORRUPT", "运行缺少幂等索引");
    await this.launch(run, operation[0], confirmedDangerousPermission);
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
    const stream = this.captureEvents(relayRunId, handle).catch(
      async (error: unknown) => {
        await this.appendEvent(relayRunId, "stream_error", {
          message: String(error),
        });
      },
    );
    const terminal = handle.wait();
    let outcome = await Promise.race([terminal, timeout(remaining)]);
    if (outcome === "timeout") {
      const grace =
        handle.status === "running"
          ? await Promise.race([terminal, timeout(500)])
          : await terminal;
      if (grace !== "timeout") outcome = grace;
    }
    if (outcome === "timeout") {
      try {
        await handle.cancel();
      } catch {
        /* terminal state below is authoritative */
      }
      await this.patchRun(relayRunId, {
        status: "failed",
        error: {
          code: "RUN_TIMEOUT",
          message: "Cursor 运行超过总超时",
          retryable: true,
        },
      });
    } else {
      await this.finishFromOutcome(relayRunId, outcome);
    }
    await stream;
  }

  private async captureEvents(relayRunId: string, handle: CursorRunHandle) {
    for await (const event of handle.stream())
      await this.appendEvent(relayRunId, event.type, sanitizeEvent(event));
  }

  private async appendEvent(relayRunId: string, type: string, data: unknown) {
    await this.store.update((state) => {
      const run = state.runs[relayRunId];
      if (!run)
        throw new RelayError("RUN_NOT_FOUND", `运行不存在：${relayRunId}`);
      const sequence = (run.events.at(-1)?.sequence ?? 0) + 1;
      run.events.push({
        sequence,
        timestamp: new Date().toISOString(),
        type,
        data,
      });
      if (run.events.length > this.config.maxEventsPerRun)
        run.events.splice(0, run.events.length - this.config.maxEventsPerRun);
      run.updatedAt = new Date().toISOString();
    });
  }

  private async expire(run: RelayRun) {
    if (run.sdkRunId) {
      try {
        await (await this.sdk.getRun(run.sdkRunId, run.workspace)).cancel();
      } catch {
        /* still record timeout */
      }
    }
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
    if (outcome.status === "finished") {
      await this.patchRun(relayRunId, {
        status: "succeeded",
        ...(outcome.result === undefined
          ? {}
          : { assistantText: outcome.result }),
      });
    } else if (outcome.status === "cancelled") {
      await this.patchRun(relayRunId, { status: "cancelled" });
    } else {
      await this.patchRun(relayRunId, {
        status: "failed",
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

  private async validateModel(selection: ModelSelection) {
    const models = await this.sdk.listModels();
    const model = models.find(
      (item) =>
        item.id === selection.id || item.aliases?.includes(selection.id),
    );
    if (!model)
      throw new RelayError(
        "MODEL_NOT_FOUND",
        `当前 Cursor 账户不可用模型：${selection.id}`,
      );
    for (const param of selection.params ?? []) {
      const definition = model.parameters?.find(
        (candidate) => candidate.id === param.id,
      );
      if (
        !definition?.values.some((candidate) => candidate.value === param.value)
      ) {
        throw new RelayError(
          "MODEL_PARAMETER_INVALID",
          `模型参数无效：${param.id}=${param.value}`,
        );
      }
    }
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
    };
  }

  private requireAuthentication() {
    if (!this.config.apiKey)
      throw new RelayError(
        "AUTH_MISSING",
        "请通过环境变量 CURSOR_API_KEY 配置 Cursor API Key",
      );
  }
}

function waitPayload(run: RelayRun) {
  const terminal = TERMINAL.has(run.status);
  return {
    run,
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
function timeout(ms: number): Promise<"timeout"> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), ms);
    timer.unref();
  });
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
