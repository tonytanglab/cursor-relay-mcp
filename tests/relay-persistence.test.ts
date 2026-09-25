import assert from "node:assert/strict";
import { mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RelayConfig } from "../src/config.js";
import { RelayService } from "../src/relay-service.js";
import type {
  CursorEvent,
  CursorRunHandle,
  CursorRunResult,
  CursorSdkPort,
} from "../src/sdk-port.js";
import { StateStore } from "../src/state-store.js";
import type { PersistedState } from "../src/types.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class PersistenceRun implements CursorRunHandle {
  readonly id: string;
  readonly agentId: string;
  constructor(suffix: string) {
    this.id = "sdk-persistence-run-" + suffix;
    this.agentId = "sdk-persistence-agent-" + suffix;
  }
  readonly executionOwnership = "owned";
  status: CursorRunHandle["status"] = "running";
  readonly eventGate = deferred<undefined>();
  readonly terminalGate = deferred<CursorRunResult>();
  result: CursorRunResult | undefined;
  yielded = 0;
  streamClosed = false;
  released = 0;
  cancelled = 0;
  supports() {
    return true;
  }
  currentResult() {
    return this.result;
  }
  async *stream(): AsyncGenerator<CursorEvent, void> {
    try {
      await this.eventGate.promise;
      this.yielded += 1;
      yield { type: "fixture_event", marker: "first" };
      this.yielded += 1;
      yield { type: "fixture_event", marker: "second" };
      await this.terminalGate.promise;
    } finally {
      this.streamClosed = true;
    }
  }
  wait() {
    return this.terminalGate.promise;
  }
  async cancel() {
    this.cancelled += 1;
    this.finish({ status: "cancelled" });
  }
  async release() {
    this.released += 1;
  }
  finish(
    result: CursorRunResult = { status: "finished", result: "真实最终输出" },
  ) {
    this.status = result.status;
    this.result = result;
    this.terminalGate.resolve(result);
  }
}

async function fixture(sharedDir?: string, identity = "fixture") {
  const dir =
    sharedDir ?? (await mkdtemp(join(tmpdir(), "cursor-relay-persistence-")));
  const config: RelayConfig = {
    environmentApiKeyConfigured: false,
    stateDir: join(dir, "state"),
    workspaceRoots: [dir],
    defaultTimeoutMs: 20_000,
    maxTimeoutMs: 20_000,
    maxEventsPerRun: 10,
    dangerFullAccessEnabled: false,
    readOnlySandboxEnabled: true,
    workspaceWriteSandboxEnabled: true,
    settingSources: ["project"],
  };
  const fault = {
    stage: "none" as "none" | "event" | "terminal" | "running",
    failures: 0,
  };
  const handle = new PersistenceRun(identity);
  const store = new StateStore(config.stateDir, {
    rename: async (from, to) => {
      const state = JSON.parse(await readFile(from, "utf8")) as PersistedState;
      const run = Object.values(state.runs).find(
        (candidate) => candidate.sdkRunId === handle.id,
      );
      if (
        run &&
        ((fault.stage === "event" && run.events.length > 0) ||
          (fault.stage === "terminal" && run.status === "succeeded") ||
          (fault.stage === "running" && run.status === "running"))
      ) {
        fault.failures += 1;
        throw Object.assign(new Error("injected local disk outage"), {
          code: "EIO",
        });
      }
      await rename(from, to);
    },
  });
  let launches = 0;
  const sdk = {
    listModels: async () => [
      { id: "fixture-model", displayName: "Offline fixture" },
    ],
    start: async () => {
      launches += 1;
      return handle;
    },
    getRun: async () => handle,
  } as unknown as CursorSdkPort;
  const service = new RelayService(config, store, sdk);
  const input = {
    workspace: dir,
    task: "只读离线故障验证",
    model: { id: "fixture-model" },
    idempotencyKey: identity,
  };
  return {
    dir,
    fault,
    store,
    handle,
    service,
    input,
    get launches() {
      return launches;
    },
    async cleanup() {
      fault.stage = "none";
      handle.eventGate.resolve(undefined);
      handle.finish();
      await until(async () => handle.released > 0);
      if (!sharedDir) await rm(dir, { recursive: true, force: true });
    },
  };
}

async function until(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 3_000;
  while (!(await predicate())) {
    assert.ok(
      Date.now() < deadline,
      "fixture condition must settle within 3 seconds",
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("local event write failure keeps the same stream and exposes health until recovery", async () => {
  const item = await fixture();
  try {
    const { run } = await item.service.startRun(item.input);
    item.fault.stage = "event";
    const waiting = item.service.waitRun(run.relayRunId, 30_000);
    item.handle.eventGate.resolve(undefined);
    const health = await waiting;
    assert.equal(health.needsAttention, true);
    assert.equal(health.mustCallAgain, false);
    assert.equal(health.terminal, false);
    assert.equal(health.run.persistence?.error.code, "STATE_UPDATE_FAILED");
    assert.match(health.instruction ?? "", /勿.*取消.*重发/u);
    assert.equal(item.handle.streamClosed, false);
    assert.equal(
      item.handle.yielded,
      1,
      "do not accumulate a second event while the first write is pending",
    );
    assert.equal(item.handle.released, 0);
    assert.equal(item.handle.cancelled, 0);
    assert.equal(
      (await item.service.listRuns()).runs[0]?.persistence?.state,
      "retrying",
    );
    assert.equal(
      (await item.service.getRunProgressSnapshot(run.relayRunId)).run
        .persistence?.state,
      "retrying",
    );
    assert.equal(
      (await item.service.readEvents(run.relayRunId)).persistence?.state,
      "retrying",
    );
    item.fault.stage = "none";
    await until(
      async () =>
        (await item.service.getRunProgressSnapshot(run.relayRunId)).events
          .length === 2,
    );
    item.handle.finish();
    const final = await item.service.waitRun(run.relayRunId, 2_000);
    assert.equal(final.run.status, "succeeded");
    assert.equal(final.run.assistantText, "真实最终输出");
    assert.equal(final.run.persistence, undefined);
    const events = (await item.store.read()).runs[run.relayRunId]?.events;
    assert.ok(events);
    assert.deepEqual(
      events.map((event) => event.type),
      ["fixture_event", "fixture_event"],
    );
    assert.deepEqual(
      events.map((event) => event.sequence),
      [1, 2],
    );
    assert.equal(item.launches, 1);
  } finally {
    await item.cleanup();
  }
});

test("SDK success with a failed terminal write is retained until the real result can be saved", async () => {
  const item = await fixture();
  try {
    const { run } = await item.service.startRun(item.input);
    item.handle.eventGate.resolve(undefined);
    await until(
      async () =>
        (await item.service.readEvents(run.relayRunId)).events.length === 2,
    );
    item.fault.stage = "terminal";
    item.handle.finish();
    const health = await item.service.waitRun(run.relayRunId, 2_000);
    assert.equal(health.run.status, "running");
    assert.equal(health.terminal, false);
    assert.equal(health.needsAttention, true);
    assert.equal(item.handle.released, 0);
    assert.equal(item.handle.cancelled, 0);
    item.fault.stage = "none";
    await until(async () => {
      const snapshot = await item.service.getRunSnapshot(run.relayRunId);
      return snapshot.status === "succeeded" && !snapshot.persistence;
    });
    const final = await item.service.waitRun(run.relayRunId, 2_000);
    assert.equal(final.terminal, true);
    assert.equal(final.run.assistantText, "真实最终输出");
    assert.equal(final.run.error, undefined);
    assert.equal(item.handle.cancelled, 0);
  } finally {
    await item.cleanup();
  }
});

test("post-launch write failure returns the reserved run and idempotent replay does not launch again", async () => {
  const item = await fixture();
  try {
    item.fault.stage = "running";
    const started = await item.service.startRun(item.input);
    assert.equal(started.run.status, "starting");
    assert.equal(started.run.persistence?.state, "retrying");
    const replay = await item.service.startRun(item.input);
    assert.equal(replay.idempotentReplay, true);
    assert.equal(replay.run.relayRunId, started.run.relayRunId);
    assert.equal(item.launches, 1);
    assert.equal(item.handle.released, 0);
    assert.equal(item.handle.cancelled, 0);
    const waiting = await item.service.waitRun(started.run.relayRunId, 2_000);
    assert.equal(waiting.needsAttention, true);
    item.fault.stage = "none";
    item.handle.eventGate.resolve(undefined);
    item.handle.finish();
    await until(
      async () =>
        (await item.service.getRunSnapshot(started.run.relayRunId)).status ===
        "succeeded",
    );
    assert.equal(item.launches, 1);
  } finally {
    await item.cleanup();
  }
});

test("two services sharing one state file recover a single writer outage without losing either run", async () => {
  const first = await fixture();
  const second = await fixture(first.dir, "sibling");
  try {
    const [left, right] = await Promise.all([
      first.service.startRun(first.input),
      second.service.startRun(second.input),
    ]);
    first.fault.stage = "event";
    first.handle.eventGate.resolve(undefined);
    second.handle.eventGate.resolve(undefined);
    const degraded = await first.service.waitRun(left.run.relayRunId, 2_000);
    assert.equal(degraded.needsAttention, true);
    second.handle.finish();
    const healthy = await second.service.waitRun(right.run.relayRunId, 2_000);
    assert.equal(healthy.run.status, "succeeded");
    assert.equal(healthy.run.persistence, undefined);
    assert.equal(first.handle.cancelled, 0);
    assert.equal(first.handle.released, 0);
    first.fault.stage = "none";
    await until(
      async () =>
        (await first.service.readEvents(left.run.relayRunId)).events.length ===
        2,
    );
    first.handle.finish();
    assert.equal(
      (await first.service.waitRun(left.run.relayRunId, 2_000)).run.status,
      "succeeded",
    );
    const saved = await first.store.read();
    for (const id of [left.run.relayRunId, right.run.relayRunId]) {
      const run = saved.runs[id];
      assert.ok(run);
      assert.equal(run.status, "succeeded");
      assert.deepEqual(
        run.events.map((event) => event.sequence),
        [1, 2],
      );
      assert.deepEqual(
        run.events.map((event) => (event.data as { marker: string }).marker),
        ["first", "second"],
      );
    }
    assert.equal(first.launches, 1);
    assert.equal(second.launches, 1);
  } finally {
    first.fault.stage = "none";
    await second.cleanup();
    await first.cleanup();
  }
});

test("an unsaved post-launch registration still enforces the owned SDK deadline", async () => {
  const item = await fixture();
  try {
    item.fault.stage = "running";
    const started = await item.service.startRun({
      ...item.input,
      timeoutMs: 1_000,
    });
    assert.equal(started.run.persistence?.state, "retrying");
    assert.equal(
      item.handle.cancelled,
      0,
      "a local disk fault alone must not cancel the SDK",
    );
    await until(async () => item.handle.cancelled === 1);
    item.fault.stage = "none";
    item.handle.eventGate.resolve(undefined);
    await until(async () => item.handle.released === 1);
    const final = await item.service.waitRun(started.run.relayRunId, 2_000);
    assert.equal(final.run.status, "failed");
    assert.equal(final.run.error?.code, "RUN_TIMEOUT");
    assert.equal(item.launches, 1);
  } finally {
    await item.cleanup();
  }
});

test("SDK success at the deadline wins over an unsaved post-launch registration", async () => {
  const item = await fixture();
  try {
    item.fault.stage = "running";
    const started = await item.service.startRun({
      ...item.input,
      timeoutMs: 1_000,
    });
    item.handle.finish();
    await until(async () => item.handle.released === 1);
    item.fault.stage = "none";
    item.handle.eventGate.resolve(undefined);
    await until(
      async () =>
        !(await item.service.getRunSnapshot(started.run.relayRunId))
          .persistence,
    );
    const final = await item.service.waitRun(started.run.relayRunId, 2_000);
    assert.equal(final.run.status, "succeeded");
    assert.equal(final.run.assistantText, "真实最终输出");
    assert.equal(final.run.error, undefined);
    assert.equal(item.handle.cancelled, 0);
    assert.equal(item.launches, 1);
  } finally {
    await item.cleanup();
  }
});
