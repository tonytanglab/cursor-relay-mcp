import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RelayError } from "../src/errors.js";
import { StateStore } from "../src/state-store.js";

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
