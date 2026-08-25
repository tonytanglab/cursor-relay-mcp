import { homedir } from "node:os";
import { delimiter, isAbsolute, resolve, sep } from "node:path";
import { realpath } from "node:fs/promises";
import { RelayError } from "./errors.js";
import type { PermissionPreset } from "./types.js";

export interface RelayConfig {
  apiKey?: string;
  stateDir: string;
  workspaceRoots: string[];
  defaultTimeoutMs: number;
  maxTimeoutMs: number;
  maxEventsPerRun: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RelayConfig {
  const roots = (env.CURSOR_RELAY_WORKSPACE_ROOTS ?? "")
    .split(delimiter)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => resolve(item));
  return {
    ...(env.CURSOR_API_KEY ? { apiKey: env.CURSOR_API_KEY } : {}),
    stateDir: resolve(
      env.CURSOR_RELAY_STATE_DIR ?? resolve(homedir(), ".cursor-relay-mcp"),
    ),
    workspaceRoots: roots,
    defaultTimeoutMs: positiveInt(
      env.CURSOR_RELAY_DEFAULT_TIMEOUT_MS,
      30 * 60_000,
    ),
    maxTimeoutMs: positiveInt(env.CURSOR_RELAY_MAX_TIMEOUT_MS, 4 * 60 * 60_000),
    maxEventsPerRun: positiveInt(env.CURSOR_RELAY_MAX_EVENTS, 1_000),
  };
}

function positiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export async function authorizeWorkspace(
  workspace: string,
  roots: string[],
): Promise<string> {
  if (!isAbsolute(workspace))
    throw new RelayError("WORKSPACE_NOT_ABSOLUTE", "workspace 必须是绝对路径");
  if (roots.length === 0) {
    throw new RelayError(
      "WORKSPACE_DENIED",
      "未配置 CURSOR_RELAY_WORKSPACE_ROOTS；默认拒绝所有工作区",
    );
  }
  let actual: string;
  try {
    actual = await realpath(workspace);
  } catch (cause) {
    throw new RelayError("WORKSPACE_NOT_FOUND", `工作区不存在：${workspace}`, {
      cause,
    });
  }
  for (const root of roots) {
    let actualRoot: string;
    try {
      actualRoot = await realpath(root);
    } catch {
      continue;
    }
    const candidate =
      process.platform === "win32" ? actual.toLowerCase() : actual;
    const allowed =
      process.platform === "win32" ? actualRoot.toLowerCase() : actualRoot;
    if (candidate === allowed || candidate.startsWith(`${allowed}${sep}`))
      return actual;
  }
  throw new RelayError("WORKSPACE_DENIED", `工作区不在允许根目录内：${actual}`);
}

export function permissionOptions(
  permission: PermissionPreset,
  confirmedDangerousPermission = false,
) {
  if (permission === "danger-full-access") {
    if (!confirmedDangerousPermission) {
      throw new RelayError(
        "DANGEROUS_PERMISSION_NOT_CONFIRMED",
        "danger-full-access 需要 confirmedDangerousPermission=true",
      );
    }
    return { tools: undefined, sandboxEnabled: false, autoReview: false };
  }
  if (permission === "read-only") {
    return {
      tools: ["read", "grep", "glob", "ls"],
      sandboxEnabled: true,
      autoReview: true,
    };
  }
  return {
    tools: undefined,
    disallowedTools: [
      "delete",
      "task",
      "mcp",
      "webSearch",
      "webFetch",
      "generateImage",
    ],
    sandboxEnabled: true,
    autoReview: true,
  };
}
