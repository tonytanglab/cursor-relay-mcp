import { RelayError } from "./errors.js";
import type { PermissionPreset } from "./types.js";

export const TASK_SCOPE_MAX_CHARS = 4_000;
export const TARGET_LOCATION_MAX_CHARS = 500;
export const TARGET_LOCATIONS_MAX_ITEMS = 100;

const CODE_FENCE = /(?:^|\n)\s*(?:```|~~~)/u;
const UNIFIED_DIFF = /(?:^|\n)(?:diff --git |@@\s|\+\+\+\s|---\s)/u;
const SOURCE_LINE =
  /^\s*(?:(?:import|export|const|let|var|function|class|interface|type|enum|namespace|def|async\s+def|public|private|protected|package|using)\b|#include\b|<\/?[A-Za-z][^>]*>|(?:\[|\]|\{|\})\s*[,;]?$|"[^"]+"\s*:\s*.+[,}]?\s*$)/u;

export function taskScopeContainsEmbeddedSource(value: string): boolean {
  if (CODE_FENCE.test(value) || UNIFIED_DIFF.test(value)) return true;
  const lines = value.split(/\r?\n/u);
  const sourceLines = lines.filter((line) => SOURCE_LINE.test(line)).length;
  return sourceLines >= 3 || (lines.length >= 8 && sourceLines >= 2);
}

export function normalizeTaskScope(value: string): string {
  const scope = value.trim();
  if (!scope || scope.length > TASK_SCOPE_MAX_CHARS) {
    throw new RelayError(
      "TASK_CONTRACT_VIOLATION",
      `task 只能描述审查、修改与验收范围，长度必须在 1 到 ${TASK_SCOPE_MAX_CHARS} 字符之间`,
    );
  }
  if (taskScopeContainsEmbeddedSource(scope)) {
    throw new RelayError(
      "TASK_CONTRACT_VIOLATION",
      "task 只能包含目标范围与验收要求，禁止嵌入源码正文、代码块或补丁；Cursor 会在获授权工作区自行读取",
    );
  }
  return scope;
}

export function targetLocationIsAllowed(value: string): boolean {
  const location = value.trim();
  const pathWithoutLineRange = location.replace(/:\d+(?:-\d+)?$/u, "");
  return (
    location.length > 0 &&
    location.length <= TARGET_LOCATION_MAX_CHARS &&
    !/[\r\n\0]/u.test(location) &&
    !CODE_FENCE.test(location) &&
    !UNIFIED_DIFF.test(location) &&
    !/^(?:[A-Za-z]:[\\/]|[\\/])/u.test(pathWithoutLineRange) &&
    !pathWithoutLineRange.split(/[\\/]/u).includes("..")
  );
}

export function normalizeTargetLocations(
  values: readonly string[] | undefined,
): string[] {
  if (values === undefined) return [];
  if (values.length > TARGET_LOCATIONS_MAX_ITEMS) {
    throw new RelayError(
      "TASK_CONTRACT_VIOLATION",
      `targetLocations 最多允许 ${TARGET_LOCATIONS_MAX_ITEMS} 个文件、目录或行号位置`,
    );
  }
  const normalized: string[] = [];
  for (const value of values) {
    if (!targetLocationIsAllowed(value)) {
      throw new RelayError(
        "TASK_CONTRACT_VIOLATION",
        "targetLocations 只能传工作区内的文件、目录或行号位置，禁止传多行文本或源码正文",
      );
    }
    const location = value.trim();
    if (!normalized.includes(location)) normalized.push(location);
  }
  return normalized;
}

export function buildCursorWorkspaceTask(
  scope: string,
  targetLocations: readonly string[],
  permission: PermissionPreset,
): string {
  const normalizedScope = normalizeTaskScope(scope);
  const normalizedTargets = normalizeTargetLocations([...targetLocations]);
  const targets = normalizedTargets.length > 0 ? normalizedTargets : ["."];
  const operation =
    permission === "read-only"
      ? "仅审查和分析，不修改工作区。"
      : "按范围直接修改获授权工作区，并运行必要验证；不要扩大到未列出的目标。";
  return [
    "任务契约（必须遵守）：",
    "- 当前运行已获授权访问工作区。请自行使用工具读取所需文件；调用参数未包含、也不应要求主任务粘贴源码正文。",
    `- ${operation}`,
    "- 最终报告读取或修改的文件、关键结论与验证状态。",
    "",
    "目标位置：",
    ...targets.map((target) => `- ${target}`),
    "",
    "任务范围：",
    normalizedScope,
  ].join("\n");
}
