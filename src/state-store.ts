import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import * as z from "zod/v4";
import { RelayError } from "./errors.js";
import type { PersistedState } from "./types.js";

const EMPTY_STATE: PersistedState = {
  schemaVersion: 1,
  runs: {},
  operations: {},
};

export class StateStore {
  readonly path: string;
  private queue: Promise<void> = Promise.resolve();

  constructor(stateDir: string) {
    this.path = resolve(stateDir, "relay-state.json");
  }

  async read(): Promise<PersistedState> {
    try {
      const text = await readFile(this.path, "utf8");
      const parsed: unknown = JSON.parse(text);
      return structuredClone(parseState(parsed));
    } catch (error) {
      if (isNotFound(error)) return structuredClone(EMPTY_STATE);
      if (error instanceof RelayError && error.code === "STATE_CORRUPT")
        throw error;
      throw new RelayError("STATE_CORRUPT", `无法读取运行状态：${this.path}`, {
        details: String(error),
        cause: error,
      });
    }
  }

  async update<T>(
    mutator: (state: PersistedState) => T | Promise<T>,
  ): Promise<T> {
    let result!: T;
    let caught: unknown;
    this.queue = this.queue.then(async () => {
      try {
        const state = await this.read();
        result = await mutator(state);
        await this.write(state);
      } catch (error) {
        caught = error;
      }
    });
    await this.queue;
    if (caught !== undefined) {
      throw caught instanceof Error
        ? caught
        : new RelayError("STATE_UPDATE_FAILED", JSON.stringify(caught));
    }
    return result;
  }

  private async write(state: PersistedState): Promise<void> {
    parseState(state);
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    await rename(temporary, this.path);
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u)
  .refine((value) => !Number.isNaN(Date.parse(value)), {
    message: "必须是有效 ISO 8601 UTC 日期",
  });
const modelSelection = z.object({
  id: z.string().min(1),
  params: z
    .array(z.object({ id: z.string().min(1), value: z.string().min(1) }))
    .optional(),
});
const usage = z.object({
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  cacheReadTokens: z.number().nonnegative(),
  cacheWriteTokens: z.number().nonnegative(),
  totalTokens: z.number().nonnegative(),
  reasoningTokens: z.number().nonnegative().optional(),
});
const relayError = z.object({
  code: z.string().min(1),
  message: z.string(),
  retryable: z.boolean(),
  details: z.unknown().optional(),
});
const relayEvent = z.object({
  sequence: z.number().int().positive(),
  timestamp: isoDate,
  type: z.string().min(1),
  data: z.unknown(),
});
const relayRun = z.object({
  relayRunId: z.string().min(1),
  sdkRunId: z.string().min(1).optional(),
  requestId: z.string().min(1).optional(),
  agentId: z.string().min(1),
  workspace: z.string().min(1),
  task: z.string().min(1),
  model: modelSelection,
  permission: z.enum(["read-only", "workspace-write", "danger-full-access"]),
  workspaceAuthorization: z
    .object({
      source: z.enum(["static-allowlist", "interactive-once"]),
      approvalId: z.string().min(1).optional(),
      authorizedAt: isoDate.optional(),
    })
    .optional(),
  dangerousPermissionConfirmed: z.boolean().optional(),
  status: z.enum(["starting", "running", "succeeded", "failed", "cancelled"]),
  createdAt: isoDate,
  updatedAt: isoDate,
  deadlineAt: isoDate,
  assistantText: z.string().optional(),
  effectiveModel: modelSelection.optional(),
  durationMs: z.number().nonnegative().optional(),
  usage: usage.optional(),
  error: relayError.optional(),
  parentRunId: z.string().min(1).optional(),
  events: z.array(relayEvent),
});
const persistedState = z.object({
  schemaVersion: z.literal(1),
  runs: z.record(z.string(), relayRun),
  operations: z.record(
    z.string(),
    z.object({ fingerprint: z.string().min(1), relayRunId: z.string().min(1) }),
  ),
});

function parseState(value: unknown): PersistedState {
  const parsed = persistedState.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const recordKey =
      issue && issue.path.length > 0
        ? issue.path.map(String).join(".")
        : "root";
    throw new RelayError("STATE_CORRUPT", `运行状态记录无效：${recordKey}`, {
      details: issue?.message,
    });
  }
  for (const [key, run] of Object.entries(parsed.data.runs)) {
    if (key !== run.relayRunId) {
      throw new RelayError(
        "STATE_CORRUPT",
        `运行状态记录键不匹配：runs.${key}`,
      );
    }
  }
  for (const [key, operation] of Object.entries(parsed.data.operations)) {
    if (!parsed.data.runs[operation.relayRunId]) {
      throw new RelayError(
        "STATE_CORRUPT",
        `幂等索引引用不存在的运行：operations.${key}`,
      );
    }
  }
  return parsed.data as PersistedState;
}
