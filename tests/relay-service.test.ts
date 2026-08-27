import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RelayConfig } from "../src/config.js";
import { RelayError } from "../src/errors.js";
import { RelayService } from "../src/relay-service.js";
import type {
  AgentLaunchOptions,
  CursorEvent,
  CursorModel,
  CursorRunHandle,
  CursorRunResult,
  CursorSdkPort,
} from "../src/sdk-port.js";
import { StateStore } from "../src/state-store.js";

class FakeRun implements CursorRunHandle {
  status: CursorRunHandle["status"] = "running";
  private resolveResult!: (result: CursorRunResult) => void;
  private rejectResult!: (error: unknown) => void;
  private readonly resultPromise = new Promise<CursorRunResult>(
    (resolve, reject) => {
      this.resolveResult = resolve;
      this.rejectResult = reject;
    },
  );
  cancelled = false;
  released = 0;
  readonly order: string[] = [];
  readonly createdAt = Date.now();
  private terminalResult: CursorRunResult | undefined;
  private streamActive = false;
  concurrentWaitObserved = false;

  constructor(
    readonly id: string,
    readonly agentId: string,
    private readonly initialEvents: CursorEvent[] = [],
  ) {}
  supports() {
    return true;
  }
  currentResult() {
    return this.terminalResult;
  }
  async *stream(): AsyncGenerator<CursorEvent, void> {
    this.streamActive = true;
    try {
      this.order.push("stream:start");
      yield { type: "status", status: "RUNNING" };
      for (const event of this.initialEvents) yield event;
      await this.resultPromise;
      yield { type: "status", status: this.status.toUpperCase() };
    } finally {
      this.streamActive = false;
      this.order.push("stream:end");
    }
  }
  wait() {
    if (this.streamActive) this.concurrentWaitObserved = true;
    this.order.push("wait");
    return this.resultPromise;
  }
  async cancel() {
    this.cancelled = true;
    this.finish({ status: "cancelled" });
  }
  finish(result: CursorRunResult) {
    this.status = result.status;
    this.terminalResult = result;
    this.resolveResult(result);
  }
  fail(error: unknown) {
    this.status = "error";
    setTimeout(() => this.rejectResult(error), 50);
  }
  finishAfterStatus(result: CursorRunResult, delayMs: number) {
    this.status = result.status;
    this.terminalResult = result;
    setTimeout(() => this.resolveResult(result), delayMs);
  }
  finishAfterDelay(result: CursorRunResult, delayMs: number) {
    setTimeout(() => this.finish(result), delayMs);
  }
  async release() {
    this.released += 1;
  }
}

class FakeSdk implements CursorSdkPort {
  readonly models: CursorModel[] = [
    {
      id: "cursor-test",
      displayName: "Cursor Test",
      aliases: ["test"],
      parameters: [{ id: "reasoning", values: [{ value: "max" }] }],
    },
  ];
  readonly runs = new Map<string, FakeRun>();
  launches: AgentLaunchOptions[] = [];
  listModelsCalls = 0;
  nextEvents: CursorEvent[] = [];
  findRunError: Error | undefined;
  authMode:
    | { mode: "environment-api-key" }
    | { mode: "stored-login"; expiresAtMs?: number }
    | { mode: "missing" } = { mode: "environment-api-key" };

  async authStatus() {
    return this.authMode;
  }

  async listModels() {
    this.listModelsCalls += 1;
    return this.models;
  }
  async start(_task: string, options: AgentLaunchOptions) {
    return this.create(options);
  }
  async reply(_agentId: string, _task: string, options: AgentLaunchOptions) {
    return this.create(options);
  }
  async getRun(runId: string) {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`missing fake run ${runId}`);
    return run;
  }
  async findRun(agentId: string) {
    if (this.findRunError) throw this.findRunError;
    return [...this.runs.values()].find((run) => run.agentId === agentId);
  }
  private create(options: AgentLaunchOptions) {
    const existing = [...this.runs.values()].find(
      (run) => run.agentId === options.agentId && run.status === "running",
    );
    if (existing) return existing;
    this.launches.push(options);
    const run = new FakeRun(
      `run-${this.runs.size + 1}`,
      options.agentId,
      this.nextEvents,
    );
    this.nextEvents = [];
    this.runs.set(run.id, run);
    return run;
  }
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "cursor-relay-service-"));
  const sdk = new FakeSdk();
  const config: RelayConfig = {
    environmentApiKeyConfigured: true,
    stateDir: join(dir, "state"),
    workspaceRoots: [dir],
    defaultTimeoutMs: 5_000,
    maxTimeoutMs: 20_000,
    maxEventsPerRun: 10,
    dangerFullAccessEnabled: false,
    readOnlySandboxEnabled: true,
    workspaceWriteSandboxEnabled: true,
    settingSources: ["project"],
  };
  const store = new StateStore(config.stateDir);
  return {
    dir,
    sdk,
    config,
    store,
    service: new RelayService(config, store, sdk),
  };
}

test("model validation, permission mapping, idempotency and wait contract", async () => {
  const item = await fixture();
  try {
    await assert.rejects(
      item.service.startRun({
        workspace: item.dir,
        task: "x",
        model: { id: "unknown" },
        idempotencyKey: "unknown-model",
      }),
      (error: unknown) =>
        error instanceof RelayError && error.code === "MODEL_NOT_FOUND",
    );

    const input = {
      workspace: item.dir,
      task: "review",
      model: { id: "test", params: [{ id: "reasoning", value: "max" }] },
      idempotencyKey: "same-operation",
      permission: "read-only" as const,
    };
    const first = await item.service.startRun(input);
    const replay = await item.service.startRun(input);
    assert.equal(replay.idempotentReplay, true);
    assert.equal(replay.run.relayRunId, first.run.relayRunId);
    assert.deepEqual(item.sdk.launches[0]?.tools, [
      "read",
      "grep",
      "glob",
      "ls",
    ]);
    await assert.rejects(
      item.service.startRun({ ...input, task: "different" }),
      (error: unknown) =>
        error instanceof RelayError && error.code === "IDEMPOTENCY_CONFLICT",
    );

    const polling = await item.service.waitRun(first.run.relayRunId, 0);
    assert.equal(polling.terminal, false);
    assert.equal(polling.mustCallAgain, true);
    item.sdk.runs
      .get(first.run.sdkRunId ?? "")
      ?.finish({ status: "finished", result: "done" });
    const terminal = await item.service.waitRun(first.run.relayRunId, 2_000);
    assert.equal(terminal.terminal, true);
    assert.equal(terminal.run.assistantText, "done");
    await new Promise((resolve) => setTimeout(resolve, 10));
    const sdkRun = item.sdk.runs.get(first.run.sdkRunId ?? "");
    assert.ok(sdkRun);
    assert.equal(sdkRun.concurrentWaitObserved, false);
    assert.ok(
      sdkRun.order.indexOf("stream:start") < sdkRun.order.indexOf("wait"),
    );
    assert.equal(sdkRun.released, 1);
  } finally {
    await rm(item.dir, { recursive: true, force: true });
  }
});

test("explicit conversation approval grants reusable read/write access outside static roots", async () => {
  const item = await fixture();
  const outside = await mkdtemp(join(tmpdir(), "cursor-relay-approved-"));
  const callerScope = "task:current-conversation";
  try {
    await assert.rejects(
      item.service.startRun(
        {
          workspace: outside,
          task: "修改 PackCAD CLI/MCP",
          model: { id: "cursor-test" },
          permission: "workspace-write",
          idempotencyKey: "packcad-write-without-approval",
        },
        callerScope,
      ),
      (error: unknown) =>
        error instanceof RelayError &&
        error.code === "WORKSPACE_APPROVAL_REQUIRED",
    );
    await assert.rejects(
      item.service.authorizeConversationWorkspace(
        {
          workspace: outside,
          permission: "danger-full-access",
        },
        callerScope,
      ),
      (error: unknown) =>
        error instanceof RelayError &&
        error.code === "WORKSPACE_APPROVAL_PERMISSION_DENIED",
    );

    const readGrant = await item.service.authorizeConversationWorkspace(
      { workspace: outside },
      callerScope,
    );
    assert.equal(readGrant.authorizationRequired, true);
    assert.ok("token" in readGrant && readGrant.token);

    await assert.rejects(
      item.service.startRun(
        {
          workspace: outside,
          task: "只读授权不得升级为写入",
          model: { id: "cursor-test" },
          permission: "workspace-write",
          idempotencyKey: "packcad-read-token-write-attempt",
          workspaceApprovalToken:
            "token" in readGrant ? readGrant.token : undefined,
        },
        callerScope,
      ),
      (error: unknown) =>
        error instanceof RelayError &&
        error.code === "WORKSPACE_APPROVAL_MISMATCH",
    );

    const grant = await item.service.authorizeConversationWorkspace(
      { workspace: outside, permission: "workspace-write" },
      callerScope,
    );
    assert.equal(grant.authorizationRequired, true);
    assert.equal(grant.source, "conversation-capability");
    assert.ok("token" in grant && grant.token);

    await assert.rejects(
      item.service.startRun(
        {
          workspace: outside,
          task: "不同对话不能复用",
          model: { id: "cursor-test" },
          permission: "workspace-write",
          idempotencyKey: "packcad-different-conversation",
          workspaceApprovalToken: "token" in grant ? grant.token : undefined,
        },
        "task:different-conversation",
      ),
      (error: unknown) =>
        error instanceof RelayError &&
        error.code === "WORKSPACE_APPROVAL_MISMATCH",
    );
    await assert.rejects(
      item.service.startRun(
        {
          workspace: outside,
          task: "危险权限不能由对话授权获得",
          model: { id: "cursor-test" },
          idempotencyKey: "packcad-danger-attempt",
          permission: "danger-full-access",
          confirmedDangerousPermission: true,
          workspaceApprovalToken: "token" in grant ? grant.token : undefined,
        },
        callerScope,
      ),
      (error: unknown) =>
        error instanceof RelayError && error.code === "WORKSPACE_DENIED",
    );

    const started = await item.service.startRun(
      {
        workspace: outside,
        task: "第一次修改 PackCAD",
        model: { id: "cursor-test" },
        permission: "workspace-write",
        idempotencyKey: "packcad-first-write",
        workspaceApprovalToken: "token" in grant ? grant.token : undefined,
      },
      callerScope,
    );
    const authorization = started.run.workspaceAuthorization;
    assert.ok(authorization);
    assert.equal(authorization.source, "conversation-capability");
    assert.equal(
      authorization.approvalId,
      "approvalId" in grant ? grant.approvalId : undefined,
    );
    assert.equal(
      JSON.stringify(await item.store.read()).includes(
        "token" in grant ? grant.token : "impossible",
      ),
      false,
    );

    item.sdk.runs
      .get(started.run.sdkRunId ?? "")
      ?.finish({ status: "finished", result: "first changed" });
    await item.service.waitRun(started.run.relayRunId, 2_000);

    const second = await item.service.replyRun(
      {
        parentRunId: started.run.relayRunId,
        task: "第二次修改 PackCAD",
        permission: "workspace-write",
        idempotencyKey: "packcad-second-write",
        workspaceApprovalToken: "token" in grant ? grant.token : undefined,
      },
      callerScope,
    );
    assert.equal(second.idempotentReplay, false);
    assert.equal(second.run.permission, "workspace-write");
    assert.equal(second.run.agentId, started.run.agentId);

    const review = await item.service.startRun(
      {
        workspace: outside,
        task: "复核两次修改",
        model: { id: "cursor-test" },
        permission: "read-only",
        idempotencyKey: "packcad-review-after-writes",
        workspaceApprovalToken: "token" in grant ? grant.token : undefined,
      },
      callerScope,
    );
    assert.equal(review.run.permission, "read-only");

    item.sdk.runs
      .get(second.run.sdkRunId ?? "")
      ?.finish({ status: "finished", result: "second changed" });
    item.sdk.runs
      .get(review.run.sdkRunId ?? "")
      ?.finish({ status: "finished", result: "reviewed" });
    await Promise.all([
      item.service.waitRun(second.run.relayRunId, 2_000),
      item.service.waitRun(review.run.relayRunId, 2_000),
    ]);
  } finally {
    await rm(item.dir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("a new service instance reconnects a persisted SDK run", async () => {
  const item = await fixture();
  try {
    const started = await item.service.startRun({
      workspace: item.dir,
      task: "persist",
      model: { id: "cursor-test" },
      idempotencyKey: "restart-operation",
    });
    const resumed = new RelayService(item.config, item.store, item.sdk);
    const running = await resumed.getRun(started.run.relayRunId);
    assert.equal(running.status, "running");
    item.sdk.runs
      .get(started.run.sdkRunId ?? "")
      ?.finish({ status: "finished", result: "recovered" });
    const done = await resumed.waitRun(started.run.relayRunId, 2_000);
    assert.equal(done.run.assistantText, "recovered");
  } finally {
    await rm(item.dir, { recursive: true, force: true });
  }
});

test("total timeout cancels SDK run and persists structured error", async () => {
  const item = await fixture();
  try {
    const started = await item.service.startRun({
      workspace: item.dir,
      task: "slow",
      model: { id: "cursor-test" },
      idempotencyKey: "timeout-operation",
      timeoutMs: 1_000,
    });
    const result = await item.service.waitRun(started.run.relayRunId, 2_000);
    assert.equal(result.run.status, "failed");
    assert.equal(result.run.error?.code, "RUN_TIMEOUT");
    assert.equal(
      item.sdk.runs.get(started.run.sdkRunId ?? "")?.cancelled,
      true,
    );
    assert.equal(item.sdk.runs.get(started.run.sdkRunId ?? "")?.released, 1);
  } finally {
    await rm(item.dir, { recursive: true, force: true });
  }
});

test("monitor rejection is contained and persisted instead of escaping", async () => {
  const item = await fixture();
  try {
    const started = await item.service.startRun({
      workspace: item.dir,
      task: "transport failure",
      model: { id: "cursor-test" },
      idempotencyKey: "monitor-rejection",
    });
    item.sdk.runs
      .get(started.run.sdkRunId ?? "")
      ?.fail(new Error("transport lost"));
    const result = await item.service.waitRun(started.run.relayRunId, 2_000);
    assert.equal(result.run.status, "failed");
    assert.equal(result.run.error?.code, "SDK_MONITOR_FAILED");
    assert.equal(item.sdk.runs.get(started.run.sdkRunId ?? "")?.released, 1);
  } finally {
    await rm(item.dir, { recursive: true, force: true });
  }
});

test("100 concurrent idempotent starts share one SDK launch", async () => {
  const item = await fixture();
  try {
    const input = {
      workspace: item.dir,
      task: "single flight",
      model: { id: "cursor-test" },
      idempotencyKey: "one-hundred-callers",
    };
    const results = await Promise.all(
      Array.from({ length: 100 }, () => item.service.startRun(input)),
    );
    assert.equal(item.sdk.launches.length, 1);
    assert.equal(new Set(results.map((result) => result.run.sdkRunId)).size, 1);
    const run = item.sdk.runs.get(results[0]?.run.sdkRunId ?? "");
    run?.finish({ status: "finished", result: "once" });
    await item.service.waitRun(results[0]?.run.relayRunId ?? "", 2_000);
  } finally {
    await rm(item.dir, { recursive: true, force: true });
  }
});

test("doctor supports official stored login without exposing credentials", async () => {
  const item = await fixture();
  try {
    item.sdk.authMode = { mode: "stored-login", expiresAtMs: 123_456 };
    const doctor = await item.service.doctor();
    assert.equal(doctor.ok, true);
    assert.equal(doctor.authentication, "stored-login");
    assert.equal(doctor.authenticationExpiresAtMs, 123_456);
    assert.equal(doctor.dangerFullAccessEnabled, false);
    assert.equal(JSON.stringify(doctor).includes("secret-for-test"), false);
  } finally {
    await rm(item.dir, { recursive: true, force: true });
  }
});

test("model aliases canonicalize, variants augment parameter validation, duplicates fail and cache is reused", async () => {
  const item = await fixture();
  const baseModel = item.sdk.models[0];
  assert.ok(baseModel);
  item.sdk.models[0] = {
    ...baseModel,
    parameters: [
      { id: "reasoning", values: [{ value: "max" }, { value: "low" }] },
    ],
    variants: [
      {
        displayName: "Maximum",
        params: [{ id: "reasoning", value: "max" }],
      },
    ],
  };
  try {
    const started = await item.service.startRun({
      workspace: item.dir,
      task: "canonical",
      model: { id: "test", params: [{ id: "reasoning", value: "max" }] },
      idempotencyKey: "canonical-model",
    });
    assert.equal(started.run.model.id, "cursor-test");
    const freeCombination = await item.service.startRun({
      workspace: item.dir,
      task: "valid catalog parameter outside preset variants",
      model: { id: "cursor-test", params: [{ id: "reasoning", value: "low" }] },
      idempotencyKey: "non-preset-model-parameter",
    });
    assert.equal(freeCombination.run.model.params?.[0]?.value, "low");
    await assert.rejects(
      item.service.startRun({
        workspace: item.dir,
        task: "duplicate",
        model: {
          id: "cursor-test",
          params: [
            { id: "reasoning", value: "max" },
            { id: "reasoning", value: "max" },
          ],
        },
        idempotencyKey: "duplicate-params",
      }),
      (error: unknown) =>
        error instanceof RelayError &&
        error.code === "MODEL_PARAMETER_DUPLICATE",
    );
    await item.service.listModels();
    assert.equal(item.sdk.listModelsCalls, 1);
    item.sdk.runs
      .get(started.run.sdkRunId ?? "")
      ?.finish({ status: "finished", model: started.run.model });
    await item.service.waitRun(started.run.relayRunId, 2_000);
  } finally {
    await rm(item.dir, { recursive: true, force: true });
  }
});

test("run summaries omit events and oversized event data is explicit", async () => {
  const item = await fixture();
  try {
    item.sdk.nextEvents = [
      { type: "tool_call", result: "x".repeat(12_000), apiKey: "hidden" },
    ];
    const started = await item.service.startRun({
      workspace: item.dir,
      task: "large event",
      model: { id: "cursor-test" },
      idempotencyKey: "large-event",
    });
    item.sdk.runs.get(started.run.sdkRunId ?? "")?.finish({
      status: "finished",
      result: "done",
      requestId: "request-1",
      durationMs: 42,
      usage: {
        inputTokens: 1,
        outputTokens: 2,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 3,
      },
    });
    await item.service.waitRun(started.run.relayRunId, 2_000);
    const summary = await item.service.getRun(started.run.relayRunId);
    assert.equal("events" in summary, false);
    assert.ok(summary.eventCount >= 1);
    assert.equal(summary.requestId, "request-1");
    assert.equal(summary.durationMs, 42);
    assert.equal(summary.usage?.totalTokens, 3);
    const events = await item.service.readEvents(started.run.relayRunId);
    const large = events.events.find((event) => event.type === "tool_call");
    assert.equal(
      (large?.data as { truncated?: boolean } | undefined)?.truncated,
      true,
    );
    assert.ok(Buffer.byteLength(JSON.stringify(large?.data), "utf8") < 8_192);
    const listed = await item.service.listRuns();
    const firstListed = listed.runs[0];
    assert.ok(firstListed);
    assert.equal("events" in firstListed, false);
  } finally {
    await rm(item.dir, { recursive: true, force: true });
  }
});

test("starting state without sdkRunId reconciles the existing SDK run", async () => {
  const item = await fixture();
  try {
    const started = await item.service.startRun({
      workspace: item.dir,
      task: "crash window",
      model: { id: "cursor-test" },
      idempotencyKey: "crash-window-reconcile",
    });
    await item.store.update((state) => {
      const run = state.runs[started.run.relayRunId];
      assert.ok(run);
      delete run.sdkRunId;
      run.status = "starting";
    });
    const resumed = new RelayService(item.config, item.store, item.sdk);
    const recovered = await resumed.getRun(started.run.relayRunId);
    assert.equal(recovered.sdkRunId, started.run.sdkRunId);
    assert.equal(item.sdk.launches.length, 1);
    item.sdk.runs
      .get(started.run.sdkRunId ?? "")
      ?.finish({ status: "finished", result: "reconciled" });
    await Promise.all([
      item.service.waitRun(started.run.relayRunId, 2_000),
      resumed.waitRun(started.run.relayRunId, 2_000),
    ]);
  } finally {
    await rm(item.dir, { recursive: true, force: true });
  }
});

test("terminal status is immutable when cancel races with completion", async () => {
  const item = await fixture();
  try {
    const started = await item.service.startRun({
      workspace: item.dir,
      task: "finish first",
      model: { id: "cursor-test" },
      idempotencyKey: "terminal-cas",
    });
    item.sdk.runs
      .get(started.run.sdkRunId ?? "")
      ?.finish({ status: "finished", result: "kept" });
    await item.service.waitRun(started.run.relayRunId, 2_000);
    const cancelled = await item.service.cancelRun(started.run.relayRunId);
    assert.equal(cancelled.alreadyTerminal, true);
    assert.equal(cancelled.run.status, "succeeded");
    assert.equal(cancelled.run.assistantText, "kept");
  } finally {
    await rm(item.dir, { recursive: true, force: true });
  }
});

test("deadline grace preserves a terminal result whose wait signal is late", async () => {
  const item = await fixture();
  try {
    const started = await item.service.startRun({
      workspace: item.dir,
      task: "deadline edge",
      model: { id: "cursor-test" },
      idempotencyKey: "deadline-edge",
      timeoutMs: 1_000,
    });
    setTimeout(() => {
      item.sdk.runs
        .get(started.run.sdkRunId ?? "")
        ?.finishAfterDelay({ status: "finished", result: "on time" }, 150);
    }, 950);
    const result = await item.service.waitRun(started.run.relayRunId, 2_000);
    assert.equal(result.run.status, "succeeded");
    assert.equal(result.run.assistantText, "on time");
  } finally {
    await rm(item.dir, { recursive: true, force: true });
  }
});

test("expired ambiguous recovery becomes a stable failure instead of wedging", async () => {
  const item = await fixture();
  try {
    const started = await item.service.startRun({
      workspace: item.dir,
      task: "ambiguous after deadline",
      model: { id: "cursor-test" },
      idempotencyKey: "expired-ambiguous-recovery",
    });
    await item.store.update((state) => {
      const run = state.runs[started.run.relayRunId];
      assert.ok(run);
      delete run.sdkRunId;
      run.status = "starting";
      run.deadlineAt = new Date(Date.now() - 1_000).toISOString();
    });
    item.sdk.findRunError = new RelayError(
      "SDK_RUN_RECOVERY_AMBIGUOUS",
      "ambiguous",
    );
    const resumed = new RelayService(item.config, item.store, item.sdk);
    const result = await resumed.getRun(started.run.relayRunId);
    assert.equal(result.status, "failed");
    assert.equal(result.error?.code, "SDK_RUN_RECOVERY_AMBIGUOUS");
  } finally {
    await rm(item.dir, { recursive: true, force: true });
  }
});

test("explicit cancellation reaches cancelled and releases the owned agent", async () => {
  const item = await fixture();
  try {
    const started = await item.service.startRun({
      workspace: item.dir,
      task: "cancel me",
      model: { id: "cursor-test" },
      idempotencyKey: "explicit-cancel",
    });
    await item.service.cancelRun(started.run.relayRunId);
    const terminal = await item.service.waitRun(started.run.relayRunId, 2_000);
    assert.equal(terminal.run.status, "cancelled");
    assert.equal(item.sdk.runs.get(started.run.sdkRunId ?? "")?.released, 1);
  } finally {
    await rm(item.dir, { recursive: true, force: true });
  }
});

test("restart after deadline preserves an SDK terminal result before cancelling", async () => {
  const item = await fixture();
  try {
    const started = await item.service.startRun({
      workspace: item.dir,
      task: "finished while host was away",
      model: { id: "cursor-test" },
      idempotencyKey: "expired-host-terminal-sdk",
    });
    await item.store.update((state) => {
      const run = state.runs[started.run.relayRunId];
      assert.ok(run);
      run.deadlineAt = new Date(Date.now() - 1_000).toISOString();
    });
    const sdkRun = item.sdk.runs.get(started.run.sdkRunId ?? "");
    assert.ok(sdkRun);
    sdkRun.finish({ status: "finished", result: "preserved" });
    const resumed = new RelayService(item.config, item.store, item.sdk);
    const result = await resumed.getRun(started.run.relayRunId);
    assert.equal(result.status, "succeeded");
    assert.equal(result.assistantText, "preserved");
    assert.equal(sdkRun.cancelled, false);
    for (let attempt = 0; attempt < 100 && sdkRun.released === 0; attempt += 1)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(sdkRun.released, 1);
  } finally {
    await rm(item.dir, { recursive: true, force: true });
  }
});
