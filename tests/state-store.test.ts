import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RelayError } from "../src/errors.js";
import { StateStore } from "../src/state-store.js";
import type { PersistedState } from "../src/types.js";

function addRun(state: PersistedState, relayRunId: string, workspace: string) {
  const now = new Date().toISOString();
  state.runs[relayRunId] = {
    relayRunId,
    agentId: `agent-${relayRunId}`,
    workspace,
    task: `task-${relayRunId}`,
    model: { id: "model" },
    permission: "read-only",
    status: "running",
    createdAt: now,
    updatedAt: now,
    deadlineAt: now,
    events: [],
  };
}

function systemError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function assertNoTemporaryFiles(directory: string) {
  const entries = await readdir(directory);
  assert.deepEqual(
    entries.filter((entry) => /^relay-state\.json\..+\.tmp$/u.test(entry)),
    [],
  );
}

test("state store serializes concurrent atomic updates", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cursor-relay-state-"));
  try {
    const store = new StateStore(dir);
    const now = new Date().toISOString();
    await store.update((state) => {
      state.runs.run = {
        relayRunId: "run",
        agentId: "agent",
        workspace: dir,
        task: "test",
        model: { id: "model" },
        permission: "read-only",
        status: "running",
        createdAt: now,
        updatedAt: now,
        deadlineAt: now,
        events: [],
      };
      state.operations.initial = {
        fingerprint: "fingerprint",
        relayRunId: "run",
      };
    });
    await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        store.update((state) => {
          state.runs.run?.events.push({
            sequence: index + 1,
            timestamp: now,
            type: "test",
            data: index,
          });
        }),
      ),
    );
    assert.equal((await store.read()).runs.run?.events.length, 10);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("legacy v1 state remains readable while nested corruption names the record", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cursor-relay-state-"));
  try {
    const store = new StateStore(dir);
    const now = new Date().toISOString();
    const legacy = {
      schemaVersion: 1,
      runs: {
        legacy: {
          relayRunId: "legacy",
          agentId: "agent",
          workspace: dir,
          task: "legacy",
          model: { id: "model" },
          permission: "read-only",
          status: "succeeded",
          createdAt: now,
          updatedAt: now,
          deadlineAt: now,
          events: [],
        },
      },
      operations: {
        legacy: { fingerprint: "fingerprint", relayRunId: "legacy" },
      },
    };
    await writeFile(store.path, `${JSON.stringify(legacy)}\n`, "utf8");
    assert.equal((await store.read()).runs.legacy?.status, "succeeded");

    legacy.runs.legacy.status = "mystery";
    await writeFile(store.path, `${JSON.stringify(legacy)}\n`, "utf8");
    await assert.rejects(
      store.read(),
      (error: unknown) =>
        error instanceof RelayError &&
        error.code === "STATE_CORRUPT" &&
        error.message.includes("runs.legacy.status"),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("state corruption is explicit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cursor-relay-state-"));
  try {
    const store = new StateStore(dir);
    await writeFile(store.path, "{broken", "utf8");
    await assert.rejects(
      store.read(),
      (error: unknown) =>
        error instanceof RelayError && error.code === "STATE_CORRUPT",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Windows retries a transient EPERM replacement and reuses the completed temp file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cursor-relay-state-"));
  try {
    let attempts = 0;
    const delays: number[] = [];
    const sources = new Set<string>();
    const store = new StateStore(dir, {
      platform: "win32",
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      },
      rename: async (source, destination) => {
        attempts += 1;
        sources.add(String(source));
        if (attempts < 3) throw systemError("EPERM");
        await rename(source, destination);
      },
    });

    await store.update((state) => addRun(state, "retried", dir));

    assert.equal(attempts, 3);
    assert.deepEqual(delays, [25, 50]);
    assert.equal(sources.size, 1);
    assert.equal((await store.read()).runs.retried?.relayRunId, "retried");
    await assertNoTemporaryFiles(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("permanent Windows EPERM is bounded, cleans temp, and does not poison the queue", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cursor-relay-state-"));
  try {
    let failReplacement = true;
    let attempts = 0;
    const store = new StateStore(dir, {
      platform: "win32",
      sleep: async () => undefined,
      rename: async (source, destination) => {
        attempts += 1;
        if (failReplacement) throw systemError("EPERM");
        await rename(source, destination);
      },
    });

    await assert.rejects(
      store.update((state) => addRun(state, "failed", dir)),
      (error: unknown) => {
        assert.ok(error instanceof RelayError);
        assert.equal(error.code, "STATE_UPDATE_FAILED");
        assert.equal(error.retryable, true);
        assert.deepEqual(error.details, {
          systemCode: "EPERM",
          attempts: 7,
          path: store.path,
        });
        return true;
      },
    );
    assert.equal(attempts, 7);
    await assertNoTemporaryFiles(dir);

    failReplacement = false;
    await store.update((state) => addRun(state, "recovered", dir));
    assert.equal((await store.read()).runs.recovered?.relayRunId, "recovered");
    assert.equal(attempts, 8);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a non-retryable replacement error is attempted only once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cursor-relay-state-"));
  try {
    let attempts = 0;
    const store = new StateStore(dir, {
      platform: "win32",
      sleep: async () => assert.fail("non-retryable errors must not sleep"),
      rename: async () => {
        attempts += 1;
        throw systemError("ENOSPC");
      },
    });

    await assert.rejects(
      store.update((state) => addRun(state, "full", dir)),
      (error: unknown) =>
        error instanceof RelayError &&
        error.code === "STATE_UPDATE_FAILED" &&
        !error.retryable &&
        (error.details as { attempts?: number }).attempts === 1,
    );
    assert.equal(attempts, 1);
    await assertNoTemporaryFiles(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("two store instances serialize the complete read-modify-write transaction", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cursor-relay-state-"));
  try {
    const firstEntered = deferred();
    const releaseFirst = deferred();
    const secondBlocked = deferred();
    const allowSecondRetry = deferred();
    let secondWaited = false;
    const first = new StateStore(dir);
    const second = new StateStore(dir, {
      sleep: async () => {
        if (!secondWaited) {
          secondWaited = true;
          secondBlocked.resolve();
          await allowSecondRetry.promise;
        }
      },
    });

    const firstUpdate = first.update(async (state) => {
      addRun(state, "first", dir);
      firstEntered.resolve();
      await releaseFirst.promise;
    });
    await firstEntered.promise;
    const secondUpdate = second.update((state) => {
      addRun(state, "second", dir);
    });
    await secondBlocked.promise;
    releaseFirst.resolve();
    await firstUpdate;
    allowSecondRetry.resolve();
    await secondUpdate;

    const state = await first.read();
    assert.deepEqual(Object.keys(state.runs).sort(), ["first", "second"]);
    assert.equal(secondWaited, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a live lock owner is never stolen and lock waiting is bounded", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cursor-relay-state-"));
  try {
    const store = new StateStore(dir, {
      now: () => 10_000,
      lockTimeoutMs: 0,
      lockStaleMs: 0,
      processIsAlive: (pid) => pid === 4242,
    });
    const lockPath = `${store.path}.lock`;
    await mkdir(lockPath);
    await writeFile(
      join(lockPath, "owner.json"),
      `${JSON.stringify({ pid: 4242, token: "live", acquiredAt: "now" })}\n`,
      "utf8",
    );

    await assert.rejects(
      store.update((state) => addRun(state, "blocked", dir)),
      (error: unknown) =>
        error instanceof RelayError &&
        error.code === "STATE_LOCK_TIMEOUT" &&
        error.retryable,
    );
    assert.equal((await readdir(lockPath)).includes("owner.json"), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a stale lock owned by a dead process is recovered", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cursor-relay-state-"));
  try {
    const observedPids: number[] = [];
    const store = new StateStore(dir, {
      lockStaleMs: 0,
      processIsAlive: (pid) => {
        observedPids.push(pid);
        return false;
      },
    });
    const lockPath = `${store.path}.lock`;
    await mkdir(lockPath);
    await writeFile(
      join(lockPath, "owner.json"),
      `${JSON.stringify({ pid: 7777, token: "dead", acquiredAt: "old" })}\n`,
      "utf8",
    );

    await store.update((state) => addRun(state, "recovered-lock", dir));

    assert.deepEqual(observedPids, [7777]);
    await assert.rejects(readdir(lockPath), { code: "ENOENT" });
    assert.equal(
      (await store.read()).runs["recovered-lock"]?.relayRunId,
      "recovered-lock",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("stale recovery never deletes a live lock published after observation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cursor-relay-state-"));
  try {
    const lockPath = join(dir, "relay-state.json.lock");
    let quarantineAttempts = 0;
    const removedPaths: string[] = [];
    const storeDependencies = {
      lockStaleMs: 0,
      lockTimeoutMs: 0,
      processIsAlive: (pid: number) => pid === 9090,
      rename: async (source: Parameters<typeof rename>[0]) => {
        quarantineAttempts += 1;
        assert.equal(String(source), lockPath);
        await writeFile(
          join(lockPath, "owner.json"),
          `${JSON.stringify({ pid: 9090, token: "live", acquiredAt: "new" })}\n`,
          "utf8",
        );
        throw systemError("EPERM");
      },
      rm: async (...args: Parameters<typeof rm>) => {
        removedPaths.push(String(args[0]));
        await rm(...args);
      },
    };
    const store = new StateStore(dir, storeDependencies);
    await mkdir(lockPath);
    await writeFile(
      join(lockPath, "owner.json"),
      `${JSON.stringify({ pid: 8080, token: "stale", acquiredAt: "old" })}\n`,
      "utf8",
    );

    await assert.rejects(
      store.update((state) => addRun(state, "must-not-start", dir)),
      (error: unknown) =>
        error instanceof RelayError && error.code === "STATE_LOCK_TIMEOUT",
    );

    assert.equal(quarantineAttempts, 1);
    assert.equal(removedPaths.includes(lockPath), false);
    const owner = JSON.parse(
      await readFile(join(lockPath, "owner.json"), "utf8"),
    ) as { pid: number; token: string };
    assert.deepEqual(owner, {
      pid: 9090,
      token: "live",
      acquiredAt: "new",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("read EPERM is a retryable I/O failure rather than state corruption", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cursor-relay-state-"));
  try {
    const store = new StateStore(dir, {
      readFile: async () => {
        throw systemError("EPERM");
      },
    });
    await assert.rejects(store.read(), (error: unknown) => {
      assert.ok(error instanceof RelayError);
      assert.equal(error.code, "STATE_READ_FAILED");
      assert.equal(error.retryable, true);
      assert.deepEqual(error.details, {
        systemCode: "EPERM",
        path: store.path,
      });
      return true;
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
