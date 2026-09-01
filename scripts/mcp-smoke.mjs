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
const client = new Client({ name: "cursor-relay-smoke", version: "0.1.1" });
try {
  await client.connect(transport);
  const tools = await client.listTools();
  if (!tools.tools.some((tool) => tool.name === "wait_run"))
    throw new Error("wait_run missing");
  const doctorTool = tools.tools.find((tool) => tool.name === "doctor");
  const reauthenticateTool = tools.tools.find(
    (tool) => tool.name === "reauthenticate_cursor",
  );
  const authorizeTool = tools.tools.find(
    (tool) => tool.name === "authorize_workspace",
  );
  const startTool = tools.tools.find((tool) => tool.name === "start_run");
  const viewTool = tools.tools.find((tool) => tool.name === "view_run");
  const waitTool = tools.tools.find((tool) => tool.name === "wait_run");
  const eventsTool = tools.tools.find((tool) => tool.name === "read_events");
  const startProperties = startTool?.inputSchema?.properties;
  if (
    doctorTool?.annotations?.readOnlyHint !== true ||
    reauthenticateTool?.annotations?.destructiveHint !== true ||
    authorizeTool?.annotations?.readOnlyHint !== false ||
    authorizeTool.annotations.destructiveHint !== false ||
    startTool?.annotations?.destructiveHint !== true ||
    startTool.annotations.idempotentHint !== true ||
    viewTool?.annotations?.readOnlyHint !== true ||
    startTool._meta?.ui?.resourceUri !==
      "ui://cursor-relay/run-panel-v1.html" ||
    viewTool._meta?.ui?.resourceUri !== "ui://cursor-relay/run-panel-v1.html" ||
    waitTool?._meta?.["openai/widgetAccessible"] !== true ||
    eventsTool?._meta?.["openai/widgetAccessible"] !== true
  )
    throw new Error("tool annotations missing");
  if (
    typeof startProperties !== "object" ||
    startProperties === null ||
    !("targetLocations" in startProperties) ||
    !("task" in startProperties) ||
    "sourceContent" in startProperties
  )
    throw new Error("location-only task contract missing");
  const resources = await client.listResources();
  const panel = resources.resources.find(
    (resource) => resource.uri === "ui://cursor-relay/run-panel-v1.html",
  );
  if (panel?.mimeType !== "text/html;profile=mcp-app")
    throw new Error("run panel resource missing");
  const rendered = await client.readResource({ uri: panel.uri });
  const panelText = rendered.contents[0]?.text;
  if (
    rendered.contents[0]?.mimeType !== "text/html;profile=mcp-app" ||
    typeof panelText !== "string" ||
    !panelText.includes("Cursor Relay 运行") ||
    !panelText.includes('request("ui/initialize"') ||
    !panelText.includes('notify("ui/notifications/initialized"') ||
    !panelText.includes('callTool("wait_run"') ||
    !panelText.includes('callTool("read_events"')
  )
    throw new Error("run panel payload invalid");
  const result = await client.callTool({ name: "doctor", arguments: {} });
  if (result.isError) throw new Error("doctor returned error");
  const structured = result.structuredContent;
  if (!structured || typeof structured.ok !== "boolean")
    throw new Error("doctor structured output missing");
  const doctorData = structured.data;
  if (
    typeof doctorData !== "object" ||
    doctorData === null ||
    !("defaultTimeoutMs" in doctorData) ||
    doctorData.defaultTimeoutMs !== 86_400_000 ||
    !("maxTimeoutMs" in doctorData) ||
    doctorData.maxTimeoutMs !== 86_400_000 ||
    !("capabilities" in doctorData) ||
    typeof doctorData.capabilities !== "object" ||
    doctorData.capabilities === null ||
    !("liveRunPanel" in doctorData.capabilities) ||
    doctorData.capabilities.liveRunPanel !== true ||
    !("workspaceReadsSourceDirectly" in doctorData.capabilities) ||
    doctorData.capabilities.workspaceReadsSourceDirectly !== true ||
    !("embeddedSourceArgumentsRejected" in doctorData.capabilities) ||
    doctorData.capabilities.embeddedSourceArgumentsRejected !== true ||
    !("activeRunSteering" in doctorData.capabilities) ||
    doctorData.capabilities.activeRunSteering !== false
  )
    throw new Error("doctor capabilities or timeout policy missing");
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
    approvalData.source !== "conversation-capability" ||
    !("instruction" in approvalData) ||
    typeof approvalData.instruction !== "string" ||
    !approvalData.instruction.includes("禁止嵌入源码正文")
  )
    throw new Error("authorize_workspace capability missing");
  process.stdout.write(`MCP smoke passed (${tools.tools.length} tools)\n`);
} finally {
  await client.close();
  await rm(stateDir, { recursive: true, force: true });
}
