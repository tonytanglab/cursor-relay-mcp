import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  Agent,
  AgentBusyError,
  AgentNotFoundError,
  AuthenticationError,
  ConfigurationError,
  Cursor,
  NetworkError,
  RateLimitError,
  type Run,
  type SDKAgent,
} from "@cursor/sdk";
import { CursorSdkAdapter, mapSdkError } from "../src/cursor-sdk-adapter.js";
import { RelayError } from "../src/errors.js";

function fakeRun(
  id: string,
  agentId: string,
  createdAt: number,
  status: Run["status"] = "finished",
): Run {
  return {
    id,
    agentId,
    createdAt,
    status,
    supports: () => true,
    unsupportedReason: () => undefined,
    async *stream() {
      yield* [];
    },
    conversation: async () => [],
    wait: async () => ({
      id,
      status: status === "running" ? "cancelled" : status,
    }),
    cancel: async () => undefined,
    onDidChangeStatus: () => () => undefined,
  };
}

test("findRun follows public pagination and rejects ambiguous recovery", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cursor-relay-adapter-"));
  const descriptor = Object.getOwnPropertyDescriptor(Agent, "listRuns");
  assert.ok(descriptor);
  try {
    const adapter = new CursorSdkAdapter(dir);
    const createdAfter = Date.now();
    let calls = 0;
    Object.defineProperty(Agent, "listRuns", {
      configurable: true,
      value: async (_agentId: string, options: { cursor?: string }) => {
        calls += 1;
        return options.cursor
          ? { items: [fakeRun("matched", "agent", createdAfter)] }
          : {
              items: [fakeRun("old", "agent", createdAfter - 5_000)],
              nextCursor: "page-2",
            };
      },
    });
    assert.equal(
      (await adapter.findRun("agent", dir, createdAfter))?.id,
      "matched",
    );
    assert.equal(calls, 2);

    Object.defineProperty(Agent, "listRuns", {
      configurable: true,
      value: async () => ({
        items: [
          fakeRun("one", "agent", createdAfter),
          fakeRun("two", "agent", createdAfter + 1),
        ],
      }),
    });
    await assert.rejects(
      adapter.findRun("agent", dir, createdAfter),
      (error: unknown) =>
        error instanceof RelayError &&
        error.code === "SDK_RUN_RECOVERY_AMBIGUOUS",
    );
  } finally {
    Object.defineProperty(Agent, "listRuns", descriptor);
    await rm(dir, { recursive: true, force: true });
  }
});

test("adapter exposes official stored login status without returning a key", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cursor-relay-adapter-"));
  const descriptor = Object.getOwnPropertyDescriptor(Cursor.auth, "status");
  assert.ok(descriptor);
  try {
    Object.defineProperty(Cursor.auth, "status", {
      configurable: true,
      value: async () => ({
        status: "logged-in",
        backendUrl: "https://api.cursor.com",
        email: "pro@example.com",
        apiKeyExpiresAtMs: 987,
      }),
    });
    const status = await new CursorSdkAdapter(dir).authStatus();
    assert.deepEqual(status, {
      mode: "stored-login",
      expiresAtMs: 987,
      email: "pro@example.com",
      backendUrl: "https://api.cursor.com",
    });
    assert.equal(JSON.stringify(status).includes("apiKey"), false);
  } finally {
    Object.defineProperty(Cursor.auth, "status", descriptor);
    await rm(dir, { recursive: true, force: true });
  }
});

test("adapter reauthenticates with browser login without exposing the minted key", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cursor-relay-adapter-"));
  const descriptor = Object.getOwnPropertyDescriptor(Cursor.auth, "login");
  assert.ok(descriptor);
  let receivedOptions: unknown;
  try {
    Object.defineProperty(Cursor.auth, "login", {
      configurable: true,
      value: async (options: unknown) => {
        receivedOptions = options;
        return {
          apiKey: "must-not-leak",
          email: "pro@example.com",
          apiKeyExpiresAtMs: 123_456,
        };
      },
    });
    const result = await new CursorSdkAdapter(dir).reauthenticate();
    assert.deepEqual(receivedOptions, {
      openBrowser: true,
      apiKeyName: "Cursor Relay MCP",
    });
    assert.deepEqual(result, {
      mode: "stored-login",
      email: "pro@example.com",
      expiresAtMs: 123_456,
    });
    assert.equal(JSON.stringify(result).includes("must-not-leak"), false);
    assert.equal(JSON.stringify(result).includes("apiKey"), false);
  } finally {
    Object.defineProperty(Cursor.auth, "login", descriptor);
    await rm(dir, { recursive: true, force: true });
  }
});

test("adapter keeps SDK agent alive until release and closes exactly once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cursor-relay-adapter-"));
  const descriptor = Object.getOwnPropertyDescriptor(Agent, "create");
  assert.ok(descriptor);
  let closes = 0;
  try {
    const run = fakeRun("run", "agent", Date.now());
    const agent = {
      agentId: "agent",
      model: undefined,
      send: async () => run,
      close: () => {
        closes += 1;
      },
      reload: async () => undefined,
      async [Symbol.asyncDispose]() {
        await Promise.resolve();
      },
      listArtifacts: async () => [],
      downloadArtifact: async () => Buffer.alloc(0),
      getUsage: async () => ({
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 0,
        },
        runs: [],
      }),
    } satisfies SDKAgent;
    Object.defineProperty(Agent, "create", {
      configurable: true,
      value: async () => agent,
    });
    const handle = await new CursorSdkAdapter(dir).start("task", {
      agentId: "agent",
      idempotencyKey: "idempotent",
      workspace: dir,
      model: { id: "model" },
      sandboxEnabled: true,
      autoReview: true,
      settingSources: ["project"],
    });
    assert.equal(closes, 0);
    await handle.release();
    await handle.release();
    assert.equal(closes, 1);
  } finally {
    Object.defineProperty(Agent, "create", descriptor);
    await rm(dir, { recursive: true, force: true });
  }
});

test("official SDK errors map to stable non-sensitive Relay errors", () => {
  const mapped = mapSdkError(
    new RateLimitError("slow down", {
      status: 429,
      isRetryable: true,
      requestId: "request-123",
      endpoint: "https://api.cursor.com/models",
      operation: "models.list",
    }),
  );
  assert.equal(mapped.code, "CURSOR_RATE_LIMITED");
  assert.equal(mapped.retryable, true);
  assert.deepEqual(mapped.details, {
    status: 429,
    requestId: "request-123",
    endpoint: "https://api.cursor.com/models",
    operation: "models.list",
  });
  const mappings = [
    [new AuthenticationError("auth"), "CURSOR_AUTHENTICATION_FAILED"],
    [new ConfigurationError("config"), "CURSOR_CONFIGURATION_ERROR"],
    [new AgentBusyError("busy"), "CURSOR_AGENT_BUSY"],
    [new NetworkError("network"), "CURSOR_NETWORK_ERROR"],
    [new AgentNotFoundError("missing"), "CURSOR_AGENT_NOT_FOUND"],
  ] as const;
  for (const [error, expected] of mappings)
    assert.equal(mapSdkError(error).code, expected);

  const planRequired = mapSdkError(
    new ConfigurationError("[plan_required] upgrade", {
      code: "plan_required",
      status: 403,
    }),
  );
  assert.equal(planRequired.code, "CURSOR_ACCOUNT_PLAN_REQUIRED");
  assert.match(planRequired.message, /reauthenticate_cursor/u);
});
