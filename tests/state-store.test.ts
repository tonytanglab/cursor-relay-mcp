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
    await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        store.update((state) => {
          state.operations[`key-${index}`] = {
            fingerprint: String(index),
            relayRunId: String(index),
          };
        }),
      ),
    );
    assert.equal(Object.keys((await store.read()).operations).length, 10);
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
