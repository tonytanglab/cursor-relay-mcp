import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const stateDir = await mkdtemp(join(tmpdir(), "cursor-relay-mcp-smoke-"));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve("dist/index.js")],
  env: { ...process.env, CURSOR_API_KEY: "", CURSOR_RELAY_STATE_DIR: stateDir },
  stderr: "pipe",
});
const client = new Client({ name: "cursor-relay-smoke", version: "0.1.0" });
try {
  await client.connect(transport);
  const tools = await client.listTools();
  if (!tools.tools.some((tool) => tool.name === "wait_run"))
    throw new Error("wait_run missing");
  const doctorTool = tools.tools.find((tool) => tool.name === "doctor");
  const authorizeTool = tools.tools.find(
    (tool) => tool.name === "authorize_workspace",
  );
  const startTool = tools.tools.find((tool) => tool.name === "start_run");
  if (
    doctorTool?.annotations?.readOnlyHint !== true ||
    authorizeTool?.annotations?.readOnlyHint !== false ||
    authorizeTool.annotations.destructiveHint !== false ||
    startTool?.annotations?.destructiveHint !== true ||
    startTool.annotations.idempotentHint !== true
  )
    throw new Error("tool annotations missing");
  const result = await client.callTool({ name: "doctor", arguments: {} });
  if (result.isError) throw new Error("doctor returned error");
  const structured = result.structuredContent;
  if (!structured || typeof structured.ok !== "boolean")
    throw new Error("doctor structured output missing");
  const approval = await client.callTool({
    name: "authorize_workspace",
    arguments: {
      workspace: stateDir,
      permission: "workspace-write",
    },
  });
  if (approval.isError) throw new Error("authorize_workspace returned error");
  const approvalData = approval.structuredContent?.data;
  if (
    typeof approvalData !== "object" ||
    approvalData === null ||
    !("token" in approvalData) ||
    typeof approvalData.token !== "string" ||
    !("permission" in approvalData) ||
    approvalData.permission !== "workspace-write" ||
    !("source" in approvalData) ||
    approvalData.source !== "conversation-capability"
  )
    throw new Error("authorize_workspace capability missing");
  process.stdout.write(`MCP smoke passed (${tools.tools.length} tools)\n`);
} finally {
  await client.close();
  await rm(stateDir, { recursive: true, force: true });
}
