import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
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
      if (!isState(parsed)) throw new Error("schema mismatch");
      return structuredClone(parsed);
    } catch (error) {
      if (isNotFound(error)) return structuredClone(EMPTY_STATE);
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

function isState(value: unknown): value is PersistedState {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.schemaVersion === 1 &&
    isRecord(record.runs) &&
    isRecord(record.operations)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
