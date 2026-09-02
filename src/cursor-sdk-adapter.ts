import {
  Agent,
  AgentBusyError,
  AgentNotFoundError,
  AuthenticationError,
  ConfigurationError,
  Cursor,
  CursorSdkError,
  JsonlLocalAgentStore,
  NetworkError,
  RateLimitError,
  type AgentOptions,
  type SDKMessage,
} from "@cursor/sdk";
import { resolve } from "node:path";
import { RelayError } from "./errors.js";
import type {
  AgentLaunchOptions,
  CursorEvent,
  CursorRunHandle,
  CursorSdkPort,
} from "./sdk-port.js";
import { warmCursorSdkRuntime } from "./sdk-runtime/index.js";

export class CursorSdkAdapter implements CursorSdkPort {
  private readonly store: JsonlLocalAgentStore;
  private readonly environmentApiKeyConfigured: boolean;

  constructor(stateDir: string, environmentApiKeyConfigured = false) {
    this.store = new JsonlLocalAgentStore(resolve(stateDir, "cursor-sdk"));
    this.environmentApiKeyConfigured = environmentApiKeyConfigured;
  }

  async warmup(cwd = process.cwd()): Promise<void> {
    await sdkCall(() => warmCursorSdkRuntime(this.store, cwd));
  }

  async authStatus() {
    if (this.environmentApiKeyConfigured)
      return { mode: "environment-api-key" as const };
    return await sdkCall(async () => {
      const status = await Cursor.auth.status();
      return status.status === "logged-in"
        ? {
            mode: "stored-login" as const,
            ...(status.email === undefined ? {} : { email: status.email }),
            backendUrl: status.backendUrl,
            ...(status.apiKeyExpiresAtMs === undefined
              ? {}
              : { expiresAtMs: status.apiKeyExpiresAtMs }),
          }
        : { mode: "missing" as const };
    });
  }

  async reauthenticate() {
    return await sdkCall(async () => {
      const result = await Cursor.auth.login({
        openBrowser: true,
        apiKeyName: "Cursor Relay MCP",
      });
      return {
        mode: "stored-login" as const,
        expiresAtMs: result.apiKeyExpiresAtMs,
        ...(result.email === undefined ? {} : { email: result.email }),
      };
    });
  }

  async listModels() {
    return await sdkCall(() => Cursor.models.list());
  }

  async start(
    task: string,
    options: AgentLaunchOptions,
  ): Promise<CursorRunHandle> {
    const agent = await sdkCall(() => Agent.create(this.agentOptions(options)));
    try {
      const run = await sdkCall(() =>
        agent.send(task, { idempotencyKey: options.idempotencyKey }),
      );
      return wrapRun(run, () => agent.close());
    } catch (error) {
      agent.close();
      throw error;
    }
  }

  async reply(
    agentId: string,
    task: string,
    options: AgentLaunchOptions,
  ): Promise<CursorRunHandle> {
    const agent = await sdkCall(() =>
      Agent.resume(agentId, this.agentOptions(options)),
    );
    try {
      const run = await sdkCall(() =>
        agent.send(task, { idempotencyKey: options.idempotencyKey }),
      );
      return wrapRun(run, () => agent.close());
    } catch (error) {
      agent.close();
      throw error;
    }
  }

  async getRun(runId: string, workspace: string): Promise<CursorRunHandle> {
    return await sdkCall(async () => {
      const run = await Agent.getRun(runId, {
        runtime: "local",
        cwd: workspace,
        store: this.store,
      });
      return wrapRun(run);
    });
  }

  async findRun(
    agentId: string,
    workspace: string,
    createdAfter: number,
  ): Promise<CursorRunHandle | undefined> {
    return await sdkCall(async () => {
      const candidates: Awaited<ReturnType<typeof Agent.listRuns>>["items"] =
        [];
      const seenCursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const result = await Agent.listRuns(agentId, {
          runtime: "local",
          cwd: workspace,
          store: this.store,
          limit: 100,
          ...(cursor ? { cursor } : {}),
        });
        candidates.push(
          ...result.items.filter(
            (run) =>
              run.createdAt !== undefined && run.createdAt >= createdAfter,
          ),
        );
        cursor = result.nextCursor;
        if (cursor && seenCursors.has(cursor)) {
          throw new RelayError(
            "SDK_RUN_RECOVERY_AMBIGUOUS",
            "Cursor SDK 运行分页游标重复，无法安全恢复",
          );
        }
        if (cursor) seenCursors.add(cursor);
      } while (cursor);
      if (candidates.length > 1) {
        throw new RelayError(
          "SDK_RUN_RECOVERY_AMBIGUOUS",
          "找到多个可能的 Cursor SDK 运行，拒绝猜测恢复目标",
          { details: { candidateCount: candidates.length } },
        );
      }
      const candidate = candidates[0];
      return candidate ? wrapRun(candidate) : undefined;
    });
  }

  private agentOptions(options: AgentLaunchOptions): AgentOptions {
    return {
      agentId: options.agentId,
      idempotencyKey: options.idempotencyKey,
      model: {
        id: options.model.id,
        ...(options.model.params ? { params: options.model.params } : {}),
      },
      ...(options.tools ? { tools: options.tools } : {}),
      ...(options.disallowedTools
        ? { disallowedTools: options.disallowedTools }
        : {}),
      local: {
        cwd: options.workspace,
        store: this.store,
        settingSources: options.settingSources,
        autoReview: options.autoReview,
        sandboxOptions: { enabled: options.sandboxEnabled },
        enableAgentRetries: true,
      },
    };
  }
}

function wrapRun(
  run: Awaited<ReturnType<typeof Agent.getRun>>,
  close?: () => void,
): CursorRunHandle {
  let released = false;
  return {
    id: run.id,
    requestId: run.requestId,
    agentId: run.agentId,
    createdAt: run.createdAt,
    get status() {
      return run.status;
    },
    supports: (operation) => run.supports(operation),
    currentResult: () => currentResult(run),
    async *stream() {
      try {
        for await (const event of run.stream())
          yield event as SDKMessage & CursorEvent;
      } catch (error) {
        throw mapSdkError(error);
      }
    },
    wait: () => sdkCall(() => run.wait()),
    cancel: () => sdkCall(() => run.cancel()),
    release() {
      if (released) return Promise.resolve();
      released = true;
      close?.();
      return Promise.resolve();
    },
  };
}

function currentResult(
  run: Awaited<ReturnType<typeof Agent.getRun>>,
): ReturnType<CursorRunHandle["currentResult"]> {
  if (run.status === "running") return undefined;
  return {
    status: run.status,
    ...(run.requestId === undefined ? {} : { requestId: run.requestId }),
    ...(run.result === undefined ? {} : { result: run.result }),
    ...(run.error === undefined ? {} : { error: run.error }),
    ...(run.model === undefined ? {} : { model: run.model }),
    ...(run.durationMs === undefined ? {} : { durationMs: run.durationMs }),
    ...(run.usage === undefined ? {} : { usage: run.usage }),
  };
}

async function sdkCall<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw mapSdkError(error);
  }
}

export function mapSdkError(error: unknown): RelayError {
  if (error instanceof RelayError) return error;
  if (!(error instanceof CursorSdkError)) {
    return new RelayError(
      "CURSOR_SDK_ERROR",
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  }
  const planRequired =
    error.code === "plan_required" || /\[plan_required\]/iu.test(error.message);
  const code = planRequired
    ? "CURSOR_ACCOUNT_PLAN_REQUIRED"
    : error instanceof AuthenticationError
      ? "CURSOR_AUTHENTICATION_FAILED"
      : error instanceof RateLimitError
        ? "CURSOR_RATE_LIMITED"
        : error instanceof AgentBusyError
          ? "CURSOR_AGENT_BUSY"
          : error instanceof AgentNotFoundError
            ? "CURSOR_AGENT_NOT_FOUND"
            : error instanceof NetworkError
              ? "CURSOR_NETWORK_ERROR"
              : error instanceof ConfigurationError
                ? "CURSOR_CONFIGURATION_ERROR"
                : "CURSOR_SDK_ERROR";
  return new RelayError(
    code,
    planRequired
      ? "当前 Cursor SDK stored login 对应账户没有 Cloud Agent 权限；若 Cursor 桌面端已是 Pro，请调用 reauthenticate_cursor 重新选择同一账户，然后再次调用 list_models 验证。"
      : error.message,
    {
      retryable: error.isRetryable,
      cause: error,
      details: {
        ...(error.code === undefined ? {} : { sdkCode: error.code }),
        ...(error.status === undefined ? {} : { status: error.status }),
        ...(error.requestId === undefined
          ? {}
          : { requestId: error.requestId }),
        ...(error.endpoint === undefined ? {} : { endpoint: error.endpoint }),
        ...(error.operation === undefined
          ? {}
          : { operation: error.operation }),
      },
    },
  );
}
