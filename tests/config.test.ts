import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  authorizeWorkspace,
  loadConfig,
  permissionOptions,
} from "../src/config.js";
import { RelayError } from "../src/errors.js";

test("workspace allowlist resolves real paths and rejects default", async () => {
  const root = await mkdtemp(join(tmpdir(), "cursor-relay-config-"));
  const child = join(root, "child");
  await mkdir(child);
  try {
    await assert.rejects(
      authorizeWorkspace(child, []),
      (error: unknown) =>
        error instanceof RelayError && error.code === "WORKSPACE_DENIED",
    );
    assert.equal(
      await authorizeWorkspace(child, [root]),
      await realpath(child),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("permission presets fail closed", () => {
  assert.deepEqual(permissionOptions("read-only"), {
    tools: ["read", "grep", "glob", "ls"],
    sandboxEnabled: true,
    autoReview: true,
  });
  assert.throws(
    () => permissionOptions("danger-full-access"),
    /confirmedDangerousPermission/u,
  );
  assert.equal(
    permissionOptions("danger-full-access", true).sandboxEnabled,
    false,
  );
});

test("config does not infer workspace roots", () => {
  const config = loadConfig({ CURSOR_RELAY_DEFAULT_TIMEOUT_MS: "1234" });
  assert.deepEqual(config.workspaceRoots, []);
  assert.equal(config.defaultTimeoutMs, 1234);
});
