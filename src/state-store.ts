import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import * as z from "zod/v4";
import { RelayError } from "./errors.js";
import type { PersistedState } from "./types.js";

const LOCK_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 2_000;
const LOCK_RETRY_DELAY_MS = 25;
const RENAME_RETRY_DELAYS_MS = [25, 50, 100, 200, 400, 800] as const;
const TRANSIENT_FILE_CODES = new Set(["EACCES", "EBUSY", "EPERM"]);

interface StateStoreDependencies {
  mkdir?: typeof mkdir;
  readFile?: typeof readFile;
  rename?: typeof rename;
  rm?: typeof rm;
  stat?: typeof stat;
  writeFile?: typeof writeFile;
  randomUUID?: typeof randomUUID;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  processIsAlive?: (pid: number) => boolean;
  pid?: number;
  platform?: NodeJS.Platform;
  lockTimeoutMs?: number;
  lockStaleMs?: number;
}

interface StateStoreRuntime {
  mkdir: typeof mkdir;
  readFile: typeof readFile;
  rename: typeof rename;
  rm: typeof rm;
  stat: typeof stat;
  writeFile: typeof writeFile;
  randomUUID: typeof randomUUID;
  sleep: (milliseconds: number) => Promise<void>;
  now: () => number;
  processIsAlive: (pid: number) => boolean;
  pid: number;
  platform: NodeJS.Platform;
  lockTimeoutMs: number;
  lockStaleMs: number;
}

interface LockOwner {
  pid: number;
  token: string;
  acquiredAt: string;
}

interface HeldLock {
  path: string;
  ownerPath: string;
  token: string;
}

class RenameFailure extends Error {
  constructor(
    readonly original: unknown,
    readonly attempts: number,
  ) {
    super("状态文件原子替换失败", { cause: original });
  }
}

const EMPTY_STATE: PersistedState = {
  schemaVersion: 1,
  runs: {},
  operations: {},
};

export class StateStore {
  readonly path: string;
  private queue: Promise<void> = Promise.resolve();
  private readonly runtime: StateStoreRuntime;

  constructor(stateDir: string, dependencies: StateStoreDependencies = {}) {
    this.path = resolve(stateDir, "relay-state.json");
    this.runtime = {
      mkdir: dependencies.mkdir ?? mkdir,
      readFile: dependencies.readFile ?? readFile,
      rename: dependencies.rename ?? rename,
      rm: dependencies.rm ?? rm,
      stat: dependencies.stat ?? stat,
      writeFile: dependencies.writeFile ?? writeFile,
      randomUUID: dependencies.randomUUID ?? randomUUID,
      sleep: dependencies.sleep ?? delay,
      now: dependencies.now ?? Date.now,
      processIsAlive: dependencies.processIsAlive ?? processIsAlive,
      pid: dependencies.pid ?? process.pid,
      platform: dependencies.platform ?? process.platform,
      lockTimeoutMs: dependencies.lockTimeoutMs ?? LOCK_TIMEOUT_MS,
      lockStaleMs: dependencies.lockStaleMs ?? LOCK_STALE_MS,
    };
  }

  async read(): Promise<PersistedState> {
    let text: string;
    try {
      text = await this.runtime.readFile(this.path, "utf8");
    } catch (error) {
      if (isNotFound(error)) return structuredClone(EMPTY_STATE);
      throw stateFileError(
        "STATE_READ_FAILED",
        `无法读取运行状态：${this.path}`,
        error,
        this.path,
      );
    }
    try {
      const parsed: unknown = JSON.parse(text);
      return structuredClone(parseState(parsed));
    } catch (error) {
      if (error instanceof RelayError && error.code === "STATE_CORRUPT")
        throw error;
      throw new RelayError("STATE_CORRUPT", `无法读取运行状态：${this.path}`, {
        details: error instanceof Error ? error.message : String(error),
        cause: error,
      });
    }
  }

  async update<T>(
    mutator: (state: PersistedState) => T | Promise<T>,
  ): Promise<T> {
    const operation = this.queue.then(async () => {
      const lock = await this.acquireLock();
      let result!: T;
      let failure: unknown;
      let operationFailed = false;
      try {
        const state = await this.read();
        result = await mutator(state);
        await this.write(state);
      } catch (error) {
        operationFailed = true;
        failure = error;
      }
      try {
        await this.releaseLock(lock);
      } catch (error) {
        if (!operationFailed) {
          operationFailed = true;
          failure = stateFileError(
            "STATE_LOCK_RELEASE_FAILED",
            `无法释放运行状态锁：${lock.path}`,
            error,
            lock.path,
          );
        }
      }
      if (operationFailed) throw failure;
      return result;
    });
    this.queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return await operation;
  }

  private async write(state: PersistedState): Promise<void> {
    parseState(state);
    const temporary = `${this.path}.${this.runtime.pid}.${this.runtime.randomUUID()}.tmp`;
    let attempts = 0;
    try {
      await this.runtime.mkdir(dirname(this.path), { recursive: true });
      await this.runtime.writeFile(
        temporary,
        `${JSON.stringify(state, null, 2)}\n`,
        {
          encoding: "utf8",
          flag: "wx",
        },
      );
      attempts = await this.replaceWithRetry(temporary);
    } catch (error) {
      if (error instanceof RelayError) throw error;
      const failure = error instanceof RenameFailure ? error : undefined;
      const original = failure?.original ?? error;
      const systemCode = errorCode(original);
      throw new RelayError(
        "STATE_UPDATE_FAILED",
        `无法写入运行状态：${this.path}`,
        {
          retryable: isTransientFileError(original),
          details: {
            systemCode,
            attempts: failure?.attempts ?? attempts,
            path: this.path,
          },
          cause: original,
        },
      );
    } finally {
      try {
        await this.runtime.rm(temporary, { force: true });
      } catch {
        /* Temporary cleanup is best-effort and must not hide the write result. */
      }
    }
  }

  private async replaceWithRetry(temporary: string): Promise<number> {
    const maximumAttempts = RENAME_RETRY_DELAYS_MS.length + 1;
    for (let attempts = 1; attempts <= maximumAttempts; attempts += 1) {
      try {
        await this.runtime.rename(temporary, this.path);
        return attempts;
      } catch (error) {
        const retryDelay = RENAME_RETRY_DELAYS_MS[attempts - 1];
        if (
          this.runtime.platform !== "win32" ||
          !isTransientFileError(error) ||
          retryDelay === undefined
        ) {
          throw new RenameFailure(error, attempts);
        }
        await this.runtime.sleep(retryDelay);
      }
    }
    throw new Error("状态文件原子替换重试循环异常退出");
  }

  private async acquireLock(): Promise<HeldLock> {
    await this.runtime.mkdir(dirname(this.path), { recursive: true });
    const lockPath = `${this.path}.lock`;
    const ownerPath = join(lockPath, "owner.json");
    const startedAt = this.runtime.now();
    let elapsed = 0;
    do {
      const token = this.runtime.randomUUID();
      try {
        await this.runtime.mkdir(lockPath);
        try {
          const owner: LockOwner = {
            pid: this.runtime.pid,
            token,
            acquiredAt: new Date(this.runtime.now()).toISOString(),
          };
          await this.runtime.writeFile(
            ownerPath,
            `${JSON.stringify(owner)}\n`,
            {
              encoding: "utf8",
              flag: "wx",
            },
          );
          return { path: lockPath, ownerPath, token };
        } catch (error) {
          try {
            await this.runtime.rm(lockPath, { recursive: true, force: true });
          } catch {
            /* The acquisition error remains authoritative. */
          }
          throw stateFileError(
            "STATE_LOCK_FAILED",
            `无法初始化运行状态锁：${lockPath}`,
            error,
            lockPath,
          );
        }
      } catch (error) {
        if (error instanceof RelayError) throw error;
        if (!isAlreadyExists(error)) {
          throw stateFileError(
            "STATE_LOCK_FAILED",
            `无法获取运行状态锁：${lockPath}`,
            error,
            lockPath,
          );
        }
      }

      if (await this.recoverStaleLock(lockPath, ownerPath)) continue;
      elapsed = this.runtime.now() - startedAt;
      if (elapsed >= this.runtime.lockTimeoutMs) {
        throw new RelayError(
          "STATE_LOCK_TIMEOUT",
          `等待运行状态锁超时：${lockPath}`,
          {
            retryable: true,
            details: {
              path: lockPath,
              waitMs: Math.max(0, elapsed),
            },
          },
        );
      }
      await this.runtime.sleep(
        Math.min(
          LOCK_RETRY_DELAY_MS,
          Math.max(0, this.runtime.lockTimeoutMs - elapsed),
        ),
      );
      elapsed = this.runtime.now() - startedAt;
    } while (elapsed < this.runtime.lockTimeoutMs);
    throw new RelayError(
      "STATE_LOCK_TIMEOUT",
      `等待运行状态锁超时：${lockPath}`,
      {
        retryable: true,
        details: { path: lockPath, waitMs: Math.max(0, elapsed) },
      },
    );
  }

  private async recoverStaleLock(
    lockPath: string,
    ownerPath: string,
  ): Promise<boolean> {
    let lockAge: number;
    try {
      const lockStat = await this.runtime.stat(lockPath);
      lockAge = Math.max(0, this.runtime.now() - lockStat.mtimeMs);
    } catch (error) {
      return isNotFound(error);
    }
    if (lockAge < this.runtime.lockStaleMs) return false;

    const owner = await this.readLockOwner(ownerPath);
    if (owner && this.safeProcessIsAlive(owner.pid)) return false;
    const quarantine = `${lockPath}.stale.${this.runtime.pid}.${this.runtime.randomUUID()}`;
    try {
      await this.runtime.rename(lockPath, quarantine);
    } catch (error) {
      return isNotFound(error);
    }
    try {
      await this.runtime.rm(quarantine, { recursive: true, force: true });
    } catch {
      /* The detached stale lock no longer blocks acquisition. */
    }
    return true;
  }

  private async readLockOwner(
    ownerPath: string,
  ): Promise<LockOwner | undefined> {
    try {
      const value: unknown = JSON.parse(
        await this.runtime.readFile(ownerPath, "utf8"),
      );
      if (
        typeof value === "object" &&
        value !== null &&
        "pid" in value &&
        Number.isSafeInteger(value.pid) &&
        Number(value.pid) > 0 &&
        "token" in value &&
        typeof value.token === "string" &&
        value.token.length > 0 &&
        "acquiredAt" in value &&
        typeof value.acquiredAt === "string"
      ) {
        return value as LockOwner;
      }
    } catch {
      /* Missing or malformed owner metadata is recoverable only after staleness. */
    }
    return undefined;
  }

  private safeProcessIsAlive(pid: number): boolean {
    try {
      return this.runtime.processIsAlive(pid);
    } catch {
      return true;
    }
  }

  private async releaseLock(lock: HeldLock): Promise<void> {
    const owner = await this.readLockOwner(lock.ownerPath);
    if (!owner || owner.token !== lock.token) return;
    await this.runtime.rm(lock.path, { recursive: true, force: true });
  }
}

function isNotFound(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return errorCode(error) === "EEXIST";
}

function isTransientFileError(error: unknown): boolean {
  const code = errorCode(error);
  return code !== undefined && TRANSIENT_FILE_CODES.has(code);
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}

function stateFileError(
  code: string,
  message: string,
  cause: unknown,
  path: string,
): RelayError {
  return new RelayError(code, message, {
    retryable: isTransientFileError(cause),
    details: { systemCode: errorCode(cause), path },
    cause,
  });
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
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
