import {
  Cursor,
  createAgentPlatform,
  type AgentOptions,
  type CursorAgentPlatform,
  type CursorAgentPlatformOptions,
  type LocalAgentStore,
} from "@cursor/sdk";

type CreateAgentPlatform = (
  options: CursorAgentPlatformOptions,
) => Promise<Pick<CursorAgentPlatform, "prewarmLocalWorkspace">>;
type ListModels = (options: { apiKey?: string }) => Promise<unknown>;
const INVALID_HEADER_WARMUP_KEY = "cursor-relay\nwarmup";

export async function warmCursorSdkRuntime(
  store: LocalAgentStore,
  cwd: string,
  createPlatform: CreateAgentPlatform = (options) =>
    createAgentPlatform(options),
  listModels: ListModels = (options) => Cursor.models.list(options),
): Promise<void> {
  const platform = await createPlatform({ localStore: store });
  const release = await platform.prewarmLocalWorkspace(
    localWarmupOptions(store, cwd),
  );
  await release();
  try {
    await listModels({ apiKey: INVALID_HEADER_WARMUP_KEY });
  } catch (error) {
    if (!isExpectedLocalHeaderError(error)) throw error;
  }
}

function localWarmupOptions(store: LocalAgentStore, cwd: string): AgentOptions {
  return {
    model: { id: "default" },
    local: {
      cwd,
      store,
      settingSources: [],
      sandboxOptions: { enabled: false },
      enableAgentRetries: true,
    },
  };
}

function isExpectedLocalHeaderError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.name === "NetworkError" &&
    error.message === "Network request failed"
  );
}
