import { homedir } from "node:os";
import { delimiter, isAbsolute, resolve, sep } from "node:path";
import { realpath } from "node:fs/promises";
import { RelayError } from "./errors.js";
import type { CodexControlledTool, PermissionPreset } from "./types.js";

export interface RelayConfig {
  environmentApiKeyConfigured: boolean;
  stateDir: string;
  workspaceRoots: string[];
  defaultTimeoutMs: number;
  maxTimeoutMs: number;
  maxEventsPerRun: number;
  dangerFullAccessEnabled: boolean;
  readOnlySandboxEnabled: boolean;
  workspaceWriteSandboxEnabled: boolean;
  settingSources: ("project" | "team" | "mdm")[];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RelayConfig {
  const roots = (env.CURSOR_RELAY_WORKSPACE_ROOTS ?? "")
    .split(delimiter)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => resolve(item));
  const defaultTimeoutMs = positiveInt(
    "CURSOR_RELAY_DEFAULT_TIMEOUT_MS",
    env.CURSOR_RELAY_DEFAULT_TIMEOUT_MS,
    2 * 60 * 60_000,
  );
  const maxTimeoutMs = positiveInt(
    "CURSOR_RELAY_MAX_TIMEOUT_MS",
    env.CURSOR_RELAY_MAX_TIMEOUT_MS,
    4 * 60 * 60_000,
  );
  if (defaultTimeoutMs > maxTimeoutMs) {
    throw new RelayError(
      "CONFIG_INVALID",
      "CURSOR_RELAY_DEFAULT_TIMEOUT_MS 不能大于 CURSOR_RELAY_MAX_TIMEOUT_MS",
    );
  }
  return {
    environmentApiKeyConfigured: Boolean(env.CURSOR_API_KEY?.trim()),
    stateDir: resolve(
      env.CURSOR_RELAY_STATE_DIR ?? resolve(homedir(), ".cursor-relay-mcp"),
    ),
    workspaceRoots: roots,
    defaultTimeoutMs,
    maxTimeoutMs,
    maxEventsPerRun: positiveInt(
      "CURSOR_RELAY_MAX_EVENTS",
      env.CURSOR_RELAY_MAX_EVENTS,
      1_000,
    ),
    dangerFullAccessEnabled: strictBoolean(
      "CURSOR_RELAY_ENABLE_DANGER_FULL_ACCESS",
      env.CURSOR_RELAY_ENABLE_DANGER_FULL_ACCESS,
      false,
    ),
    readOnlySandboxEnabled:
      strictBoolean(
        "CURSOR_RELAY_READ_ONLY_SANDBOX_ENABLED",
        env.CURSOR_RELAY_READ_ONLY_SANDBOX_ENABLED,
        true,
      ) && process.platform !== "win32",
    workspaceWriteSandboxEnabled:
      strictBoolean(
        "CURSOR_RELAY_WORKSPACE_WRITE_SANDBOX_ENABLED",
        env.CURSOR_RELAY_WORKSPACE_WRITE_SANDBOX_ENABLED,
        true,
      ) && process.platform !== "win32",
    settingSources: parseSettingSources(env.CURSOR_RELAY_SETTING_SOURCES),
  };
}

export function normalizeCursorApiKeyEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (env.CURSOR_API_KEY !== undefined && !env.CURSOR_API_KEY.trim())
    delete env.CURSOR_API_KEY;
}

function positiveInt(
  name: string,
  value: string | undefined,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (!/^[1-9]\d*$/u.test(value))
    throw new RelayError("CONFIG_INVALID", `${name} 必须是正整数`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed))
    throw new RelayError("CONFIG_INVALID", `${name} 超出安全整数范围`);
  return parsed;
}

function strictBoolean(
  name: string,
  value: string | undefined,
  fallback: boolean,
): boolean {
  if (value === undefined) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new RelayError("CONFIG_INVALID", `${name} 只能是 true 或 false`);
}

function parseSettingSources(
  value: string | undefined,
): ("project" | "team" | "mdm")[] {
  if (value === undefined) return ["project"];
  const sources = value.split(",").map((item) => item.trim());
  if (
    sources.length === 0 ||
    sources.some(
      (source) => source !== "project" && source !== "team" && source !== "mdm",
    ) ||
    new Set(sources).size !== sources.length
  ) {
    throw new RelayError(
      "CONFIG_INVALID",
      "CURSOR_RELAY_SETTING_SOURCES 仅允许不重复的 project、team、mdm",
    );
  }
  return sources as ("project" | "team" | "mdm")[];
}

export async function authorizeWorkspace(
  workspace: string,
  roots: string[],
): Promise<string> {
  const actual = await resolveWorkspace(workspace);
  if (await workspaceIsWithinRoots(actual, roots)) return actual;
  if (roots.length === 0) {
    throw new RelayError(
      "WORKSPACE_DENIED",
      "未配置 CURSOR_RELAY_WORKSPACE_ROOTS；默认拒绝无人值守工作区",
    );
  }
  throw new RelayError("WORKSPACE_DENIED", `工作区不在允许根目录内：${actual}`);
}

export async function resolveWorkspace(workspace: string): Promise<string> {
  if (!isAbsolute(workspace))
    throw new RelayError("WORKSPACE_NOT_ABSOLUTE", "workspace 必须是绝对路径");
  try {
    return await realpath(workspace);
  } catch (cause) {
    throw new RelayError("WORKSPACE_NOT_FOUND", `工作区不存在：${workspace}`, {
      cause,
    });
  }
}

export async function workspaceIsWithinRoots(
  actualWorkspace: string,
  roots: string[],
): Promise<boolean> {
  for (const root of roots) {
    let actualRoot: string;
    try {
      actualRoot = await realpath(root);
    } catch {
      continue;
    }
    const candidate =
      process.platform === "win32"
        ? actualWorkspace.toLowerCase()
        : actualWorkspace;
    const allowed =
      process.platform === "win32" ? actualRoot.toLowerCase() : actualRoot;
    if (candidate === allowed || candidate.startsWith(`${allowed}${sep}`))
      return true;
  }
  return false;
}

export function permissionOptions(
  permission: PermissionPreset,
  confirmedDangerousPermission = false,
  dangerFullAccessEnabled = false,
  readOnlySandboxEnabled = true,
  workspaceWriteSandboxEnabled = true,
  codexAllowedTools: readonly CodexControlledTool[] = [],
) {
  const allowedTools = normalizeCodexAllowedTools(codexAllowedTools);
  if (permission === "danger-full-access") {
    if (!dangerFullAccessEnabled) {
      throw new RelayError(
        "DANGEROUS_PERMISSION_DISABLED",
        "服务端未启用 danger-full-access",
      );
    }
    if (!confirmedDangerousPermission) {
      throw new RelayError(
        "DANGEROUS_PERMISSION_NOT_CONFIRMED",
        "danger-full-access 需要 confirmedDangerousPermission=true",
      );
    }
    return { tools: undefined, sandboxEnabled: false, autoReview: false };
  }
  if (permission === "read-only") {
    const incompatible = allowedTools.filter(
      (tool) => tool !== "generateImage",
    );
    if (incompatible.length > 0) {
      throw new RelayError(
        "TOOL_POLICY_PERMISSION_DENIED",
        `read-only 不能放行可能修改工作区或扩大执行范围的工具：${incompatible.join(", ")}`,
      );
    }
    return {
      tools: [
        "read",
        "grep",
        "glob",
        "ls",
        "webSearch",
        "webFetch",
        ...allowedTools,
      ],
      sandboxEnabled: readOnlySandboxEnabled,
      autoReview: true,
    };
  }
  const allowed = new Set(allowedTools);
  return {
    tools: undefined,
    disallowedTools: CODEX_CONTROLLED_TOOLS.filter(
      (tool) => !allowed.has(tool),
    ),
    sandboxEnabled: workspaceWriteSandboxEnabled,
    autoReview: true,
  };
}

export const CODEX_CONTROLLED_TOOLS = [
  "delete",
  "task",
  "mcp",
  "generateImage",
] as const satisfies readonly CodexControlledTool[];

export function normalizeCodexAllowedTools(
  tools: readonly CodexControlledTool[] = [],
): CodexControlledTool[] {
  const requested = new Set(tools);
  return CODEX_CONTROLLED_TOOLS.filter((tool) => requested.has(tool));
}
