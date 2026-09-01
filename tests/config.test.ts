import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  authorizeWorkspace,
  CURSOR_RELAY_HARD_MAX_TIMEOUT_MS,
  loadConfig,
  normalizeCursorApiKeyEnvironment,
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
    tools: ["read", "grep", "glob", "ls", "webSearch", "webFetch"],
    sandboxEnabled: true,
    autoReview: true,
  });
  assert.equal(
    permissionOptions("read-only", false, false, false).sandboxEnabled,
    false,
  );
  assert.equal(
    permissionOptions("workspace-write", false, false, true, false)
      .sandboxEnabled,
    false,
  );
  assert.throws(
    () => permissionOptions("danger-full-access", true),
    (error: unknown) =>
      error instanceof RelayError &&
      error.code === "DANGEROUS_PERMISSION_DISABLED",
  );
  assert.throws(
    () => permissionOptions("danger-full-access", false, true),
    /confirmedDangerousPermission/u,
  );
  assert.equal(
    permissionOptions("danger-full-access", true, true).sandboxEnabled,
    false,
  );
  assert.deepEqual(
    permissionOptions("workspace-write", false, false, true, true, [
      "generateImage",
      "delete",
      "generateImage",
    ]).disallowedTools,
    ["task", "mcp"],
  );
  assert.deepEqual(
    permissionOptions("read-only", false, false, true, true, ["generateImage"])
      .tools,
    ["read", "grep", "glob", "ls", "webSearch", "webFetch", "generateImage"],
  );
  assert.throws(
    () => permissionOptions("read-only", false, false, true, true, ["delete"]),
    (error: unknown) =>
      error instanceof RelayError &&
      error.code === "TOOL_POLICY_PERMISSION_DENIED",
  );
});

test("default timeout gives Cursor a 24-hour total budget and hard cap", () => {
  const config = loadConfig({});
  assert.equal(config.defaultTimeoutMs, CURSOR_RELAY_HARD_MAX_TIMEOUT_MS);
  assert.equal(config.maxTimeoutMs, CURSOR_RELAY_HARD_MAX_TIMEOUT_MS);
});

test("config does not infer workspace roots", () => {
  const config = loadConfig({ CURSOR_RELAY_DEFAULT_TIMEOUT_MS: "1234" });
  assert.deepEqual(config.workspaceRoots, []);
  assert.equal(config.defaultTimeoutMs, 1234);
  assert.equal(config.dangerFullAccessEnabled, false);
  assert.equal(config.readOnlySandboxEnabled, process.platform !== "win32");
  assert.equal(
    config.workspaceWriteSandboxEnabled,
    process.platform !== "win32",
  );
  assert.equal(config.environmentApiKeyConfigured, false);
  assert.deepEqual(config.settingSources, ["project"]);
});

test("read-only sandbox is clamped off on Windows and configurable elsewhere", () => {
  assert.equal(
    loadConfig({ CURSOR_RELAY_READ_ONLY_SANDBOX_ENABLED: "true" })
      .readOnlySandboxEnabled,
    process.platform !== "win32",
  );
  assert.equal(
    loadConfig({ CURSOR_RELAY_READ_ONLY_SANDBOX_ENABLED: "false" })
      .readOnlySandboxEnabled,
    false,
  );
});

test("workspace-write sandbox is clamped off on Windows and configurable elsewhere", () => {
  assert.equal(
    loadConfig({ CURSOR_RELAY_WORKSPACE_WRITE_SANDBOX_ENABLED: "true" })
      .workspaceWriteSandboxEnabled,
    process.platform !== "win32",
  );
  assert.equal(
    loadConfig({ CURSOR_RELAY_WORKSPACE_WRITE_SANDBOX_ENABLED: "false" })
      .workspaceWriteSandboxEnabled,
    false,
  );
});

test("blank API key is missing and normalized so stored login can be used", () => {
  const env = { CURSOR_API_KEY: "  " };
  assert.equal(loadConfig(env).environmentApiKeyConfigured, false);
  normalizeCursorApiKeyEnvironment(env);
  assert.equal("CURSOR_API_KEY" in env, false);
});

test("configuration fails fast for invalid booleans, numbers and setting sources", () => {
  assert.throws(
    () => loadConfig({ CURSOR_RELAY_ENABLE_DANGER_FULL_ACCESS: "yes" }),
    /只能是 true 或 false/u,
  );
  assert.throws(
    () => loadConfig({ CURSOR_RELAY_READ_ONLY_SANDBOX_ENABLED: "yes" }),
    /只能是 true 或 false/u,
  );
  assert.throws(
    () => loadConfig({ CURSOR_RELAY_WORKSPACE_WRITE_SANDBOX_ENABLED: "yes" }),
    /只能是 true 或 false/u,
  );
  assert.throws(
    () => loadConfig({ CURSOR_RELAY_MAX_EVENTS: "12oops" }),
    /必须是正整数/u,
  );
  assert.throws(
    () => loadConfig({ CURSOR_RELAY_SETTING_SOURCES: "project,plugins" }),
    /仅允许/u,
  );
  assert.throws(
    () =>
      loadConfig({
        CURSOR_RELAY_DEFAULT_TIMEOUT_MS: "2000",
        CURSOR_RELAY_MAX_TIMEOUT_MS: "1000",
      }),
    /不能大于/u,
  );
  assert.throws(
    () =>
      loadConfig({
        CURSOR_RELAY_DEFAULT_TIMEOUT_MS: String(
          CURSOR_RELAY_HARD_MAX_TIMEOUT_MS,
        ),
        CURSOR_RELAY_MAX_TIMEOUT_MS: String(
          CURSOR_RELAY_HARD_MAX_TIMEOUT_MS + 1,
        ),
      }),
    /不能超过 .*24 小时/u,
  );
  assert.deepEqual(
    loadConfig({
      CURSOR_RELAY_ENABLE_DANGER_FULL_ACCESS: "true",
      CURSOR_RELAY_SETTING_SOURCES: "project,team,mdm",
    }).settingSources,
    ["project", "team", "mdm"],
  );
});
