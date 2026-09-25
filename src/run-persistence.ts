import { asRelayError } from "./errors.js";
import { StateUpdateCommittedError } from "./state-store.js";
import type { RelayPersistenceHealth } from "./types.js";

const RETRY_DELAYS_MS = [100, 250, 500, 1_000, 2_000, 5_000] as const;

/** Keeps the current write alive without buffering more events or restarting an executor. */
export class RunPersistence {
  // Only failing in-flight operations are retained; success removes their entries.
  private readonly failures = new Map<
    string,
    Map<symbol, RelayPersistenceHealth>
  >();
  private readonly listeners = new Map<string, Set<() => void>>();

  constructor(
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
    private readonly report: (
      health: RelayPersistenceHealth,
      runId: string,
    ) => void = (health, runId) => {
      process.stderr.write(
        `${JSON.stringify({ type: "relay_persistence_error", runId, ...health })}\n`,
      );
    },
  ) {}

  snapshot(runId: string): RelayPersistenceHealth | undefined {
    const health = this.failures.get(runId)?.values().next().value;
    return health ? structuredClone(health) : undefined;
  }

  waitForFailure(runId: string): {
    promise: Promise<void>;
    dispose: () => void;
  } {
    if (this.snapshot(runId))
      return { promise: Promise.resolve(), dispose: () => undefined };
    let notify!: () => void;
    const promise = new Promise<void>((resolve) => {
      notify = resolve;
    });
    const listeners = this.listeners.get(runId) ?? new Set<() => void>();
    this.listeners.set(runId, listeners);
    listeners.add(notify);
    return {
      promise,
      dispose: () => {
        listeners.delete(notify);
        if (listeners.size === 0) this.listeners.delete(runId);
      },
    };
  }

  async run<T>(
    runId: string,
    operation: string,
    action: () => Promise<T>,
  ): Promise<T> {
    const key = Symbol(operation);
    let attempt = action;
    let attempts = 0;
    let firstFailureAt: string | undefined;
    try {
      for (;;) {
        try {
          return await attempt();
        } catch (error) {
          const failure = asRelayError(error);
          if (!failure.code.startsWith("STATE_")) throw error;
          if (error instanceof StateUpdateCommittedError) {
            // Commit already happened: retry only lock cleanup, never the mutator.
            attempt = async () => {
              await error.retryCleanup();
              return error.committedResult as T;
            };
          }
          const now = new Date().toISOString();
          firstFailureAt ??= now;
          attempts += 1;
          const health: RelayPersistenceHealth = {
            state: "retrying",
            operation,
            firstFailureAt,
            lastFailureAt: now,
            attempts,
            error: failure.toJSON(),
          };
          const failures =
            this.failures.get(runId) ??
            new Map<symbol, RelayPersistenceHealth>();
          this.failures.set(runId, failures);
          failures.set(key, health);
          for (const notify of this.listeners.get(runId) ?? []) notify();
          if (attempts === 1) this.report(health, runId);
          await this.sleep(
            RETRY_DELAYS_MS[
              Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1)
            ] ?? 5_000,
          );
        }
      }
    } finally {
      const failures = this.failures.get(runId);
      failures?.delete(key);
      if (failures?.size === 0) this.failures.delete(runId);
    }
  }
}
