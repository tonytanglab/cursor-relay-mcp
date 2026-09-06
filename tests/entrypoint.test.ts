import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CursorSdkAdapter } from "../src/cursor-sdk-adapter.js";
import { isDirectExecution, main } from "../src/index.js";
import { RunProgressServer } from "../src/run-progress-server.js";

test("bin entrypoint resolves a package-manager symlink before comparison", async () => {
  const realEntry = "C:\\package\\dist\\index.js";
  const linkedEntry = "C:\\bin\\cursor-relay-mcp";
  assert.equal(
    await isDirectExecution(
      linkedEntry,
      pathToFileURL(realEntry).href,
      async () => realEntry,
    ),
    true,
  );
});

test("entrypoint preserves progress cleanup when disposing SDK on MCP close", async (t) => {
  t.mock.method(CursorSdkAdapter.prototype, "warmup", async () => undefined);
  const dispose = t.mock.method(
    CursorSdkAdapter.prototype,
    "dispose",
    () => undefined,
  );
  const progressClose = t.mock.method(
    RunProgressServer.prototype,
    "close",
    async () => undefined,
  );
  let closeServer: (() => void) | undefined;
  t.mock.method(
    McpServer.prototype,
    "connect",
    async function (this: McpServer) {
      closeServer = this.server.onclose;
    },
  );

  await main();
  assert.ok(closeServer);
  assert.equal(progressClose.mock.callCount(), 0);
  assert.equal(dispose.mock.callCount(), 0);
  closeServer();
  assert.equal(progressClose.mock.callCount(), 1);
  assert.equal(dispose.mock.callCount(), 1);
});
