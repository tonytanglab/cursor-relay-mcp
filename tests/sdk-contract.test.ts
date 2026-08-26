import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Agent, Cursor, JsonlLocalAgentStore } from "@cursor/sdk";
import { CURSOR_SDK_VERSION } from "../src/sdk-port.js";

test("pinned Cursor SDK exports required public beta contract", async () => {
  const packageJson: unknown = JSON.parse(
    await readFile(
      new URL("../node_modules/@cursor/sdk/package.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(
    typeof packageJson === "object" &&
      packageJson !== null &&
      "version" in packageJson
      ? packageJson.version
      : undefined,
    CURSOR_SDK_VERSION,
  );
  assert.equal(typeof Agent.create, "function");
  assert.equal(typeof Agent.resume, "function");
  assert.equal(typeof Agent.getRun, "function");
  assert.equal(typeof Agent.listRuns, "function");
  assert.equal(typeof Agent.cancelRun, "function");
  assert.equal(typeof Cursor.models.list, "function");
  assert.equal(typeof Cursor.auth.status, "function");
  assert.equal(typeof JsonlLocalAgentStore, "function");
});
