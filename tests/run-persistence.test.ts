import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RelayError } from "../src/errors.js";
import { RunPersistence } from "../src/run-persistence.js";
import { StateStore } from "../src/state-store.js";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("persistence retry wakes waiters, preserves error details and clears only recovered operations", async () => {
  const blocked = gate();
  const delays: number[] = [];
  const reports: unknown[] = [];
  const persistence = new RunPersistence(
    (ms) => {
      delays.push(ms);
      return blocked.promise;
    },
    (health) => reports.push(health),
  );
  const notification = persistence.waitForFailure("run");
  let firstAttempts = 0;
  let secondAttempts = 0;
  const fail = () =>
    new RelayError("STATE_UPDATE_FAILED", "write failed", {
      retryable: true,
      details: { phase: "rename", systemCode: "EPERM", attempts: 7 },
    });
  const first = persistence.run("run", "event", async () => {
    if (++firstAttempts === 1) throw fail();
    return "event saved";
  });
  const second = persistence.run("other", "terminal", async () => {
    if (++secondAttempts === 1) throw fail();
    return "terminal saved";
  });
  await notification.promise;
  notification.dispose();
  assert.deepEqual(persistence.snapshot("run")?.error.details, {
    phase: "rename",
    systemCode: "EPERM",
    attempts: 7,
  });
  assert.equal(persistence.snapshot("run")?.operation, "event");
  assert.equal(firstAttempts, 1);
  assert.deepEqual(delays, [100, 100]);
  assert.equal(reports.length, 2);
  blocked.resolve();
  assert.deepEqual(await Promise.all([first, second]), [
    "event saved",
    "terminal saved",
  ]);
  assert.equal(persistence.snapshot("run"), undefined);
  assert.equal(persistence.snapshot("other"), undefined);
});

test("storage retry is paced and capped; genuine SDK errors are not retried", async () => {
  const delays: number[] = [];
  const persistence = new RunPersistence(
    async (ms) => {
      delays.push(ms);
    },
    () => undefined,
  );
  let attempts = 0;
  await persistence.run("run", "event", async () => {
    if (++attempts < 9)
      throw new RelayError("STATE_LOCK_TIMEOUT", "busy", { retryable: true });
  });
  assert.deepEqual(delays, [100, 250, 500, 1_000, 2_000, 5_000, 5_000, 5_000]);
  const original = new RelayError("SDK_STREAM_FAILED", "network", {
    retryable: true,
  });
  let sdkCalls = 0;
  await assert.rejects(
    persistence.run("run", "event", async () => {
      sdkCalls++;
      throw original;
    }),
    (error) => error === original,
  );
  assert.equal(sdkCalls, 1);
  assert.equal(persistence.snapshot("run"), undefined);
});

test("committed state with a failing lock cleanup is never mutated twice by recovery", async () => {
  const dir = await mkdtemp(join(tmpdir(), "relay-committed-recovery-"));
  let failures = 2;
  let mutations = 0;
  const store = new StateStore(dir, {
    rm: async (...args) => {
      if (String(args[0]).endsWith(".lock") && failures-- > 0)
        throw Object.assign(new Error("busy cleanup"), { code: "EPERM" });
      return rm(...args);
    },
  });
  const persistence = new RunPersistence(
    async () => undefined,
    () => undefined,
  );
  try {
    const saved = await persistence.run("run", "update_run", () =>
      store.update(() => {
        mutations++;
        return 7;
      }),
    );
    assert.equal(saved, 7);
    assert.equal(mutations, 1);
    assert.equal(persistence.snapshot("run"), undefined);
    await store.update(() => undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
