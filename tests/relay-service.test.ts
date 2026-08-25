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

  constructor(
    readonly id: string,
    readonly agentId: string,
  ) {}
  async *stream(): AsyncGenerator<CursorEvent, void> {
    yield { type: "status", status: "RUNNING" };
    await this.resultPromise;
    yield { type: "status", status: this.status.toUpperCase() };
  }
  wait() {
    return this.resultPromise;
  }
  async cancel() {
    this.cancelled = true;
    this.finish({ status: "cancelled" });
  }
  finish(result: CursorRunResult) {
    this.status = result.status;
    this.resolveResult(result);
  }
  fail(error: unknown) {
    this.rejectResult(error);
  }
  finishAfterStatus(result: CursorRunResult, delayMs: number) {
    this.status = result.status;
    setTimeout(() => this.resolveResult(result), delayMs);
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

  async listModels() {
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
    return [...this.runs.values()].find((run) => run.agentId === agentId);
  }
  private create(options: AgentLaunchOptions) {
    const existing = [...this.runs.values()].find(
      (run) => run.agentId === options.agentId && run.status === "running",
    );
    if (existing) return existing;
    this.launches.push(options);
    const run = new FakeRun(`run-${this.runs.size + 1}`, options.agentId);
    this.runs.set(run.id, run);
    return run;
  }
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "cursor-relay-service-"));
  const sdk = new FakeSdk();
  const config: RelayConfig = {
    apiKey: "secret-for-test",
    stateDir: join(dir, "state"),
    workspaceRoots: [dir],
    defaultTimeoutMs: 5_000,
    maxTimeoutMs: 20_000,
    maxEventsPerRun: 10,
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
  } finally {
    await rm(item.dir, { recursive: true, force: true });
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
        ?.finishAfterStatus({ status: "finished", result: "on time" }, 150);
    }, 950);
    const result = await item.service.waitRun(started.run.relayRunId, 2_000);
    assert.equal(result.run.status, "succeeded");
    assert.equal(result.run.assistantText, "on time");
  } finally {
    await rm(item.dir, { recursive: true, force: true });
  }
});
