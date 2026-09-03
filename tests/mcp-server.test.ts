import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp-server.js";
import type { RelayService } from "../src/relay-service.js";
import {
  projectRunPanelEvents,
  RUN_PANEL_HTML,
  RUN_PANEL_MIME_TYPE,
  RUN_PANEL_URI,
} from "../src/run-panel.js";

test("run panel merges continuous text fragments into stable incremental blocks", () => {
  const projected = projectRunPanelEvents([
    {
      sequence: 1,
      type: "thinking",
      timestamp: "2026-08-31T00:00:01.000Z",
      data: { agent_id: "agent-1", run_id: "run-1", text: "先分析" },
    },
    {
      sequence: 2,
      type: "thinking",
      timestamp: "2026-08-31T00:00:02.000Z",
      data: { agent_id: "agent-1", run_id: "run-1", text: "，再执行。" },
    },
    {
      sequence: 3,
      type: "tool_call",
      timestamp: "2026-08-31T00:00:03.000Z",
      data: { name: "read_file" },
    },
    {
      sequence: 4,
      type: "assistant",
      timestamp: "2026-08-31T00:00:04.000Z",
      data: {
        agent_id: "agent-1",
        run_id: "run-1",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "已经" }],
        },
      },
    },
    {
      sequence: 5,
      type: "assistant",
      timestamp: "2026-08-31T00:00:05.000Z",
      data: {
        agent_id: "agent-1",
        run_id: "run-1",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "完成。" }],
        },
      },
    },
  ]);

  assert.deepEqual(projected, [
    {
      kind: "text",
      key: "text:1",
      label: "Cursor 正在处理",
      text: "先分析，再执行。",
      firstSequence: 1,
      lastSequence: 2,
    },
    {
      kind: "event",
      key: "event:3",
      event: {
        sequence: 3,
        type: "tool_call",
        timestamp: "2026-08-31T00:00:03.000Z",
        data: { name: "read_file" },
      },
    },
    {
      kind: "text",
      key: "text:4",
      label: "Cursor 回复",
      text: "已经完成。",
      firstSequence: 4,
      lastSequence: 5,
    },
  ]);
});

const run = {
  relayRunId: "relay-panel-test",
  sdkRunId: "sdk-panel-test",
  agentId: "agent-panel-test",
  workspace: "C:\\workspace",
  task: "验证实时面板",
  model: { id: "cursor-test" },
  permission: "read-only" as const,
  status: "running" as const,
  createdAt: "2026-08-27T00:00:00.000Z",
  updatedAt: "2026-08-27T00:00:01.000Z",
  deadlineAt: "2026-08-27T00:30:00.000Z",
  eventCount: 1,
};

test("MCP exposes a read-only live run panel backed by real status tools", async () => {
  const calls: string[] = [];
  const service = {
    getRunSnapshot: async (relayRunId: string) => {
      calls.push(relayRunId);
      return run;
    },
    getRunProgressSnapshot: async (relayRunId: string, afterSequence = 0) => {
      calls.push(relayRunId);
      return {
        run,
        events: [],
        nextSequence: afterSequence,
        snapshotOnly: true,
      };
    },
  } as unknown as RelayService;
  const server = createMcpServer(service);
  const client = new Client({ name: "panel-test", version: "0.1.1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const resources = await client.listResources();
    const panelResource = resources.resources.find(
      (resource) => resource.uri === RUN_PANEL_URI,
    );
    assert.equal(panelResource?.mimeType, RUN_PANEL_MIME_TYPE);

    const resource = await client.readResource({ uri: RUN_PANEL_URI });
    assert.equal(resource.contents.length, 1);
    const content = resource.contents[0];
    assert.ok(content);
    assert.equal(content.mimeType, RUN_PANEL_MIME_TYPE);
    assert.equal("text" in content, true);
    assert.match("text" in content ? content.text : "", /Cursor Relay 运行/);

    const tools = await client.listTools();
    for (const name of ["view_run"]) {
      const tool = tools.tools.find((item) => item.name === name);
      const ui = tool?._meta?.ui as { resourceUri?: unknown } | undefined;
      assert.equal(ui?.resourceUri, RUN_PANEL_URI);
      assert.equal(tool?._meta?.["openai/outputTemplate"], RUN_PANEL_URI);
    }
    for (const name of ["start_run", "reply_run"]) {
      const tool = tools.tools.find((item) => item.name === name);
      assert.equal(
        tool?._meta?.ui,
        undefined,
        "data tools must not create sandbox frames",
      );
      const properties = (tool?.inputSchema.properties ?? {}) as Record<
        string,
        { description?: unknown }
      >;
      const timeout = tool?.inputSchema.properties?.timeoutMs as
        | { maximum?: unknown; description?: unknown }
        | undefined;
      assert.equal(timeout?.maximum, 86_400_000);
      assert.match(String(timeout.description), /24 小时/u);
      assert.match(String(properties.task?.description), /禁止传源码正文/u);
      assert.match(
        String(properties.targetLocations?.description),
        /仅传位置不传内容/u,
      );
      assert.equal("sourceContent" in properties, false);
    }
    for (const name of [
      "get_run",
      "wait_run",
      "read_events",
      "read_run_progress",
    ]) {
      const tool = tools.tools.find((item) => item.name === name);
      const ui = tool?._meta?.ui as { visibility?: unknown } | undefined;
      assert.deepEqual(ui?.visibility, ["model", "app"]);
      assert.equal(tool?._meta?.["openai/widgetAccessible"], true);
    }
    const viewTool = tools.tools.find((item) => item.name === "view_run");
    assert.ok(viewTool);
    assert.equal(viewTool.annotations?.readOnlyHint, true);
    assert.equal(viewTool.annotations.destructiveHint, false);

    const viewed = await client.callTool({
      name: "view_run",
      arguments: { relayRunId: run.relayRunId },
    });
    assert.equal(viewed.isError, undefined);
    assert.deepEqual(viewed.structuredContent, {
      ok: true,
      data: { run },
    });
    assert.deepEqual(calls, [run.relayRunId]);
    const progress = await client.callTool({
      name: "read_run_progress",
      arguments: { relayRunId: run.relayRunId, afterSequence: 42 },
    });
    assert.deepEqual(progress.structuredContent, {
      ok: true,
      data: { run, events: [], nextSequence: 42, snapshotOnly: true },
    });
    const opened = await client.callTool({
      name: "open_run",
      arguments: { relayRunId: run.relayRunId },
    });
    const link = (opened.structuredContent as { data: { progressUrl: string } })
      .data.progressUrl;
    assert.equal((await fetch(link)).status, 200);
    assert.equal(
      tools.tools.find((item) => item.name === "open_run")?._meta,
      undefined,
    );
  } finally {
    await client.close();
    await server.close();
  }
});

test("run panel polls actual Relay data without mutating a run", () => {
  assert.equal(RUN_PANEL_HTML.includes('callTool("read_run_progress"'), true);
  assert.equal(RUN_PANEL_HTML.includes('request("tools/call"'), true);
  assert.equal(RUN_PANEL_HTML.includes('request("ui/initialize"'), true);
  assert.equal(
    RUN_PANEL_HTML.includes('notify("ui/notifications/initialized"'),
    true,
  );
  assert.equal(
    RUN_PANEL_HTML.includes('method === "ui/resource-teardown"'),
    true,
  );
  assert.equal(RUN_PANEL_HTML.includes("afterSequence"), true);
  assert.equal(RUN_PANEL_HTML.includes("projectRunPanelEvents(events)"), true);
  assert.equal(
    RUN_PANEL_HTML.includes('item.className = "event event-text"'),
    true,
  );
  for (const mutatingTool of [
    "start_run",
    "reply_run",
    "cancel_run",
    "authorize_workspace",
    "wait_run",
    "read_events",
    "get_run",
  ]) {
    assert.equal(
      RUN_PANEL_HTML.includes(`callTool("${mutatingTool}"`),
      false,
      `panel must not call ${mutatingTool}`,
    );
  }
});
