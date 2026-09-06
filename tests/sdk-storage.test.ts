import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { JsonlLocalAgentStore } from "@cursor/sdk";
import { SdkStorage } from "../src/sdk-storage.js";
import { CursorSdkAdapter } from "../src/cursor-sdk-adapter.js";

test("SQLite leases isolate workspaces, survive reopen and drain active holders", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cursor-storage-"));
  const pool = new SdkStorage(dir);
  try {
    const [a, b, other] = await Promise.all([
      pool.acquire(join(dir, "a")),
      pool.acquire(join(dir, "a")),
      pool.acquire(join(dir, "b")),
    ]);
    assert.equal(a.store, b.store);
    await a.store.runEvents.append({
      runId: "run",
      eventType: "message",
      payload: "first",
    });
    assert.equal(
      (await other.store.runEvents.list({ runId: "run" })).items.length,
      0,
    );
    await a.release();
    await a.release();
    pool.dispose();
    await assert.rejects(pool.acquire(join(dir, "a")), /存储已关闭/u);
    await b.store.runEvents.append({
      runId: "run",
      eventType: "message",
      payload: "second",
    });
    await b.release();
    await other.release();
    const reopened = new SdkStorage(dir);
    const c = await reopened.acquire(join(dir, "a"));
    assert.deepEqual(
      (await c.store.runEvents.list({ runId: "run" })).items.map(
        (x) => x.payload,
      ),
      ["first", "second"],
    );
    await c.release();
    reopened.dispose();
  } finally {
    pool.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("legacy history stays byte-identical and all legacy mutation surfaces reject", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cursor-storage-legacy-"));
  const root = join(dir, "cursor-sdk");
  const old = new JsonlLocalAgentStore(root);
  const pool = new SdkStorage(dir);
  try {
    await old.agents.create({
      agent: {
        agentId: "old-agent",
        cwd: dir,
        status: "idle",
        createdAt: 1,
        updatedAt: 1,
      },
    });
    await old.runs.create({
      run: {
        agentId: "old-agent",
        runId: "old",
        turnNumber: 1,
        status: "finished",
        result: "historic result",
        createdAt: 1,
        updatedAt: 1,
      },
    });
    await old.runEvents.append({
      runId: "old",
      eventType: "message",
      payload: "preserved",
    });
    const files = await readdir(root);
    const before = await Promise.all(files.map((f) => readFile(join(root, f))));
    assert.equal(
      (await pool.legacy.runEvents.list({ runId: "old" })).items[0]?.payload,
      "preserved",
    );
    const adapter = new CursorSdkAdapter(dir);
    const historic = await adapter.getRun("old", dir);
    assert.equal(historic.currentResult()?.result, "historic result");
    assert.equal(historic.executionOwnership, "detached");
    assert.equal(historic.supports("cancel"), false);
    await assert.rejects(historic.cancel(), /仅支持读取/u);
    await historic.release();
    adapter.dispose();
    await assert.rejects(
      pool.legacy.runEvents.append({ runId: "old", eventType: "mutation" }),
      /仅支持历史读取/u,
    );
    await assert.rejects(
      pool.legacy.runEvents.delete({ filter: {} }),
      /仅支持历史读取/u,
    );
    await assert.rejects(
      pool.legacy.agents.delete({ filter: {} }),
      /仅支持历史读取/u,
    );
    await assert.rejects(
      pool.legacy.runs.delete({ filter: {} }),
      /仅支持历史读取/u,
    );
    await assert.rejects(
      pool.legacy.checkpoints.delete({ filter: {} }),
      /仅支持历史读取/u,
    );
    const lease = await pool.acquire(dir);
    await lease.store.runEvents.append({
      runId: "new",
      eventType: "message",
      payload: "new data",
    });
    await lease.release();
    assert.deepEqual(
      await Promise.all(files.map((f) => readFile(join(root, f)))),
      before,
    );
  } finally {
    pool.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("public SQLite appends from separate processes preserve events and exclusive tail offsets", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cursor-storage-process-"));
  const pool = new SdkStorage(dir);
  try {
    const lease = await pool.acquire(dir);
    const first = await lease.store.runEvents.append({
      runId: "shared",
      eventType: "message",
      payload: "before",
    });
    const worker = `import { SdkStorage } from './src/sdk-storage.ts';
const p = new SdkStorage(process.argv[1]); const l = await p.acquire(process.argv[1]);
try { for(let i=0;i<40;i++) await l.store.runEvents.append({runId:'shared',eventType:'message',payload:process.argv[2]+':'+i,idempotencyKey:process.argv[2]+':'+i}); }
finally { await l.release(); p.dispose(); }`;
    const execute = promisify(execFile);
    await Promise.all(
      ["left", "right"].map((id) =>
        execute(
          process.execPath,
          ["--import", "tsx", "--input-type=module", "-e", worker, dir, id],
          { encoding: "utf8", windowsHide: true },
        ),
      ),
    );
    const tail = await lease.store.runEvents.list({
      runId: "shared",
      afterOffset: first.offset,
      limit: 100,
    });
    assert.equal(tail.items.length, 80);
    assert.equal(new Set(tail.items.map((x) => x.seq)).size, 80);
    assert.equal(new Set(tail.items.map((x) => x.payload)).size, 80);
    assert.equal(
      (await lease.store.runEvents.list({ runId: "shared", limit: 100 }))
        .items[0]?.payload,
      "before",
    );
    await lease.release();
  } finally {
    pool.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("128 MiB history uses incremental append and bounded tail reads", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cursor-storage-large-"));
  const pool = new SdkStorage(dir);
  const lease = await pool.acquire(dir);
  try {
    const payload = "x".repeat(128 * 1024);
    for (let i = 0; i < 1024; i++) {
      await lease.store.runEvents.append({
        runId: "history",
        eventType: "message",
        payload,
      });
    }
    const marker = await lease.store.runEvents.append({
      runId: "history",
      eventType: "message",
      payload: "marker",
    });
    const started = performance.now();
    for (let i = 0; i < 100; i++)
      await lease.store.runEvents.append({
        runId: "history",
        eventType: "message",
        payload: i,
      });
    const elapsed = performance.now() - started;
    const tail = await lease.store.runEvents.list({
      runId: "history",
      afterOffset: marker.offset,
      limit: 100,
    });
    assert.deepEqual(
      tail.items.map((x) => x.payload),
      Array.from({ length: 100 }, (_, i) => i),
    );
    assert.equal(
      (await lease.store.runEvents.list({ runId: "history", limit: 1 }))
        .items[0]?.payload,
      payload,
    );
    t.diagnostic(
      `128 MiB existing history: 100 small appends in ${elapsed.toFixed(1)} ms; SDK public SQLite, no timing threshold`,
    );
  } finally {
    await lease.release();
    pool.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
