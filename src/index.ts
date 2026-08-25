#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { realpath } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.js";
import { CursorSdkAdapter } from "./cursor-sdk-adapter.js";
import { createMcpServer } from "./mcp-server.js";
import { RelayService } from "./relay-service.js";
import { StateStore } from "./state-store.js";

export { loadConfig } from "./config.js";
export { CursorSdkAdapter } from "./cursor-sdk-adapter.js";
export { RelayError } from "./errors.js";
export { createMcpServer } from "./mcp-server.js";
export { RelayService } from "./relay-service.js";
export { StateStore } from "./state-store.js";
export type * from "./sdk-port.js";
export type * from "./types.js";

export async function main() {
  const config = loadConfig();
  const service = new RelayService(
    config,
    new StateStore(config.stateDir),
    new CursorSdkAdapter(config.stateDir, config.apiKey),
  );
  await createMcpServer(service).connect(new StdioServerTransport());
}

export async function isDirectExecution(
  argvPath: string | undefined,
  moduleUrl: string,
  resolvePath: (path: string) => Promise<string> = realpath,
): Promise<boolean> {
  if (!argvPath) return false;
  try {
    return moduleUrl === pathToFileURL(await resolvePath(argvPath)).href;
  } catch {
    return moduleUrl === pathToFileURL(argvPath).href;
  }
}

if (await isDirectExecution(process.argv[1], import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `cursor-relay-mcp fatal: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
