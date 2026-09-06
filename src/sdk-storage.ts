import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { JsonlLocalAgentStore, type LocalAgentStore } from "@cursor/sdk";
import { SqliteLocalAgentStore } from "@cursor/sdk/sqlite";
import { RelayError } from "./errors.js";

export interface StoreLease {
  store: LocalAgentStore;
  release(): Promise<void>;
}

/** Adapter-owned leases keep a workspace database alive only while in use. */
export class SdkStorage {
  readonly legacy: LocalAgentStore;
  private readonly entries = new Map<
    string,
    {
      opening: Promise<SqliteLocalAgentStore>;
      refs: number;
    }
  >();
  private disposed = false;

  constructor(private readonly stateDir: string) {
    this.legacy = readOnlyStore(
      new JsonlLocalAgentStore(resolve(stateDir, "cursor-sdk")),
    );
  }

  async acquire(workspace: string): Promise<StoreLease> {
    if (this.disposed)
      throw new RelayError(
        "SDK_STORAGE_CLOSED",
        "Cursor 存储已关闭，不能启动新操作",
      );
    const absolute = resolve(workspace);
    const key =
      process.platform === "win32" ? absolute.toLowerCase() : absolute;
    let entry = this.entries.get(key);
    if (!entry) {
      const hash = createHash("sha256").update(key, "utf8").digest("hex");
      entry = {
        opening: SqliteLocalAgentStore.open({
          workspaceRef: absolute,
          stateRoot: resolve(this.stateDir, "cursor-sdk-sqlite-v1", hash),
        }),
        refs: 0,
      };
      this.entries.set(key, entry);
    }
    entry.refs += 1;
    const owned = entry;
    let store: SqliteLocalAgentStore;
    try {
      store = await owned.opening;
    } catch (error) {
      owned.refs -= 1;
      if (this.entries.get(key) === owned) this.entries.delete(key);
      throw error;
    }
    let released: Promise<void> | undefined;
    return {
      store,
      release: () =>
        (released ??= (async () => {
          owned.refs -= 1;
          if (owned.refs === 0) {
            if (this.entries.get(key) === owned) this.entries.delete(key);
            await store.dispose();
          }
        })()),
    };
  }

  /** Refuse new work; active run/observer leases drain without interruption. */
  dispose(): void {
    this.disposed = true;
  }
}

function readOnlyStore(store: LocalAgentStore): LocalAgentStore {
  const deny = (): Promise<never> =>
    Promise.reject(
      new RelayError(
        "SDK_LEGACY_STORE_READ_ONLY",
        "旧 Cursor 存储仅支持历史读取；继续会话需先安全迁移，不能丢失上下文重建",
      ),
    );
  return {
    agents: {
      get: (input) => store.agents.get(input),
      list: (input) => store.agents.list(input),
      create: deny,
      update: deny,
      delete: deny,
    },
    runs: {
      get: (input) => store.runs.get(input),
      list: (input) => store.runs.list(input),
      create: deny,
      update: deny,
      delete: deny,
    },
    checkpoints: {
      get: (input) => store.checkpoints.get(input),
      list: (input) => store.checkpoints.list(input),
      create: deny,
      update: deny,
      delete: deny,
    },
    runEvents: {
      list: (input) => store.runEvents.list(input),
      append: deny,
      delete: deny,
    },
  };
}
