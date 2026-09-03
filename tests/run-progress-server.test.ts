import assert from "node:assert/strict";
import test from "node:test";
import { request } from "node:http";
import { RunProgressServer } from "../src/run-progress-server.js";
import type { RelayService } from "../src/relay-service.js";

test("loopback viewer scopes tokens to one run, rejects cross-site and write access, closes cleanly", async () => {
  const calls: [string, number | undefined][] = [];
  const reader = {
    async getRunProgressSnapshot(id: string, cursor?: number) {
      calls.push([id, cursor]);
      if (id === "missing") throw new Error("not found");
      return {
        run: { relayRunId: id, task: "中文任务" },
        events: [],
        nextSequence: cursor ?? 0,
      };
    },
  } as unknown as Pick<RelayService, "getRunProgressSnapshot">;
  const viewer = new RunProgressServer(reader);
  let url = "";
  try {
    await assert.rejects(viewer.open("missing"));
    const [first, replay, second] = await Promise.all([
      viewer.open("one"),
      viewer.open("one"),
      viewer.open("two"),
    ]);
    url = first.progressUrl;
    assert.equal(replay.progressUrl, url);
    assert.notEqual(url, second.progressUrl);
    assert.equal(new URL(url).hostname, "127.0.0.1");
    const page = await fetch(url);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /window.cursorRelayLocalProgress = true/u);
    assert.equal(page.headers.get("cache-control"), "no-store");
    assert.match(
      page.headers.get("content-security-policy") ?? "",
      /frame-ancestors 'none'/u,
    );
    assert.equal(page.headers.get("access-control-allow-origin"), null);
    const snapshot = await fetch(
      url + "snapshot?afterSequence=12&relayRunId=two",
    );
    const result = (await snapshot.json()) as {
      data: { run: { relayRunId: string; task: string } };
    };
    assert.equal(result.data.run.relayRunId, "one");
    assert.equal(result.data.run.task, "中文任务");
    assert.deepEqual(calls.at(-1), ["one", 12]);
    const reads = calls.length;
    for (const [suffix, init, status] of [
      ["", { method: "POST" }, 405],
      ["snapshot", { headers: { origin: "https://untrusted.example" } }, 403],
      ["snapshot", { headers: { "sec-fetch-site": "cross-site" } }, 403],
      ["snapshot", { headers: { host: "untrusted.example" } }, 403],
      ["snapshot?afterSequence=-1", {}, 400],
      ["snapshot?afterSequence=1e10", {}, 400],
      ["../other", {}, 404],
    ] as const) {
      const actual = await new Promise<number | undefined>(
        (resolve, reject) => {
          const req = request(url + suffix, init, (response) => {
            response.resume();
            response.on("end", () => resolve(response.statusCode));
          });
          req.on("error", reject);
          req.end();
        },
      );
      assert.equal(actual, status, JSON.stringify({ suffix, init }));
    }
    const missing = new URL("/runs/" + "0".repeat(64) + "/snapshot", url);
    assert.equal((await fetch(missing)).status, 404);
    assert.equal(
      calls.length,
      reads,
      "unauthorized requests never reach state reader",
    );
  } finally {
    await viewer.close();
  }
  await assert.rejects(fetch(url));
  await assert.rejects(viewer.open("one"), /已关闭/u);
});

test("snapshot failure is bounded to a generic HTTP error, not a process crash", async () => {
  let fail = false;
  const viewer = new RunProgressServer({
    async getRunProgressSnapshot() {
      if (fail) throw new Error("private filesystem detail");
      return { run: {} };
    },
  } as unknown as Pick<RelayService, "getRunProgressSnapshot">);
  try {
    const { progressUrl } = await viewer.open("one");
    fail = true;
    const response = await fetch(progressUrl + "snapshot");
    assert.equal(response.status, 503);
    assert.doesNotMatch(await response.text(), /private/u);
    fail = false;
    assert.equal((await fetch(progressUrl + "snapshot")).status, 200);
  } finally {
    await viewer.close();
  }
});
