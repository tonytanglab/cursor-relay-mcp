export const RUN_PANEL_URI = "ui://cursor-relay/run-panel-v1.html";
export const RUN_PANEL_MIME_TYPE = "text/html;profile=mcp-app";

interface RunPanelEvent {
  sequence: number;
  type?: string;
  timestamp?: string;
  data?: unknown;
}

export type RunPanelTimelineEntry =
  | {
      kind: "text";
      key: string;
      label: string;
      text: string;
      firstSequence: number;
      lastSequence: number;
    }
  | {
      kind: "event";
      key: string;
      event: RunPanelEvent;
    };

export function projectRunPanelEvents(
  sourceEvents: RunPanelEvent[],
): RunPanelTimelineEntry[] {
  const entries: RunPanelTimelineEntry[] = [];
  let currentText: Extract<RunPanelTimelineEntry, { kind: "text" }> | undefined;
  let currentStreamKey: string | undefined;

  for (const event of [...sourceEvents].sort(
    (left, right) => left.sequence - right.sequence,
  )) {
    const data =
      event.data && typeof event.data === "object"
        ? (event.data as Record<string, unknown>)
        : undefined;
    let label: string | undefined;
    let fragment: string | undefined;

    if (event.type === "thinking" && typeof data?.text === "string") {
      label = "Cursor 正在处理";
      fragment = data.text;
    } else if (event.type === "assistant") {
      const message =
        data?.message && typeof data.message === "object"
          ? (data.message as Record<string, unknown>)
          : undefined;
      const content = Array.isArray(message?.content) ? message.content : [];
      const textBlocks = content.filter(
        (item): item is { type: "text"; text: string } =>
          Boolean(
            item &&
              typeof item === "object" &&
              (item as Record<string, unknown>).type === "text" &&
              typeof (item as Record<string, unknown>).text === "string",
          ),
      );
      if (textBlocks.length > 0 && textBlocks.length === content.length) {
        label = "Cursor 回复";
        fragment = textBlocks.map((item) => item.text).join("");
      }
    }

    if (label !== undefined && fragment !== undefined) {
      const streamKey = [
        event.type,
        typeof data?.agent_id === "string" ? data.agent_id : "",
        typeof data?.run_id === "string" ? data.run_id : "",
      ].join(":");
      if (currentText && currentStreamKey === streamKey) {
        currentText.text += fragment;
        currentText.lastSequence = event.sequence;
        continue;
      }
      currentText = {
        kind: "text",
        key: `text:${event.sequence}`,
        label,
        text: fragment,
        firstSequence: event.sequence,
        lastSequence: event.sequence,
      };
      currentStreamKey = streamKey;
      entries.push(currentText);
      continue;
    }

    currentText = undefined;
    currentStreamKey = undefined;
    entries.push({
      kind: "event",
      key: `event:${event.sequence}`,
      event,
    });
  }

  return entries;
}

export const RUN_PANEL_HTML = String.raw`<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light dark" />
    <title>Cursor Relay 运行状态</title>
    <style>
      :root {
        color-scheme: light dark;
        font-family:
          Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont,
          "Segoe UI", sans-serif;
        --bg: #f7f8fa;
        --panel: #ffffff;
        --panel-muted: #f0f2f5;
        --text: #17191c;
        --muted: #626973;
        --border: #dfe3e8;
        --accent: #5a4bd8;
        --success: #138a55;
        --danger: #c53d3d;
        --warning: #b36b00;
      }

      @media (prefers-color-scheme: dark) {
        :root {
          --bg: #121416;
          --panel: #191c20;
          --panel-muted: #23272c;
          --text: #f2f4f7;
          --muted: #a6adb7;
          --border: #343941;
          --accent: #a89cff;
          --success: #54c98b;
          --danger: #ff7b7b;
          --warning: #f0ad4e;
        }
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        background: var(--bg);
        color: var(--text);
      }

      main {
        display: grid;
        gap: 14px;
        padding: 16px;
      }

      header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 16px;
      }

      h1,
      h2,
      p {
        margin: 0;
      }

      h1 {
        font-size: 17px;
        line-height: 1.35;
      }

      h2 {
        font-size: 13px;
        color: var(--muted);
        letter-spacing: 0.02em;
      }

      .live {
        display: inline-flex;
        align-items: center;
        gap: 7px;
        margin-top: 5px;
        color: var(--muted);
        font-size: 12px;
      }

      .pulse {
        width: 8px;
        height: 8px;
        border-radius: 999px;
        background: var(--accent);
        box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 45%, transparent);
        animation: pulse 1.8s infinite;
      }

      .pulse[data-active="false"] {
        animation: none;
        background: var(--muted);
        box-shadow: none;
      }

      @keyframes pulse {
        70% {
          box-shadow: 0 0 0 7px transparent;
        }
        100% {
          box-shadow: 0 0 0 0 transparent;
        }
      }

      .status {
        flex: none;
        border: 1px solid var(--border);
        border-radius: 999px;
        padding: 5px 10px;
        background: var(--panel);
        color: var(--muted);
        font-size: 12px;
        font-weight: 650;
      }

      .status[data-status="succeeded"] {
        border-color: color-mix(in srgb, var(--success) 45%, var(--border));
        color: var(--success);
      }

      .status[data-status="failed"],
      .status[data-status="cancelled"] {
        border-color: color-mix(in srgb, var(--danger) 45%, var(--border));
        color: var(--danger);
      }

      .status[data-status="starting"],
      .status[data-status="running"] {
        border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
        color: var(--accent);
      }

      .card {
        min-width: 0;
        border: 1px solid var(--border);
        border-radius: 12px;
        background: var(--panel);
        padding: 13px;
      }

      .task {
        margin-top: 7px;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        line-height: 1.45;
        font-size: 13px;
      }

      dl {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(145px, 1fr));
        gap: 11px 16px;
        margin: 0;
      }

      dt {
        margin-bottom: 3px;
        color: var(--muted);
        font-size: 11px;
      }

      dd {
        margin: 0;
        overflow-wrap: anywhere;
        font-size: 12px;
        font-variant-numeric: tabular-nums;
      }

      .timeline {
        display: grid;
        gap: 8px;
        margin: 9px 0 0;
        padding: 0;
        list-style: none;
        max-height: 310px;
        overflow: auto;
      }

      .event {
        display: grid;
        grid-template-columns: auto minmax(0, 1fr);
        gap: 9px;
        padding: 9px;
        border-radius: 9px;
        background: var(--panel-muted);
      }

      .event-text {
        display: block;
      }

      .stream-text {
        margin: 6px 0 0;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        font: 13px/1.6 Inter, ui-sans-serif, system-ui, -apple-system,
          BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      .seq {
        color: var(--accent);
        font: 600 11px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace;
      }

      .event-title {
        font-size: 12px;
        font-weight: 650;
      }

      .event-time {
        margin-left: 7px;
        color: var(--muted);
        font-size: 11px;
        font-weight: 400;
      }

      .event-data,
      .output,
      .error {
        margin: 5px 0 0;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        font: 11px/1.45 ui-monospace, SFMono-Regular, Consolas, monospace;
      }

      .output {
        max-height: 260px;
        overflow: auto;
      }

      .empty {
        color: var(--muted);
        font-size: 12px;
      }

      .error {
        color: var(--danger);
      }

      [hidden] {
        display: none !important;
      }

      button { cursor: pointer; min-height: 40px; padding: 8px 14px; margin-top: 10px; }
      button:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
      .stream-text { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13px; line-height: 1.6; }
      .event-text { display: block; }
      @media (prefers-reduced-motion: reduce) { .pulse { animation: none; } }
    </style>
  </head>
  <body>
    <main>
      <header>
        <div>
          <h1>Cursor Relay 运行</h1>
          <div class="live">
            <span id="pulse" class="pulse" data-active="false"></span>
            <span id="liveText">等待运行数据</span>
          </div>
        </div>
        <span id="status" class="status" data-status="unknown">未知</span>
      </header>

      <section class="card">
        <h2>任务</h2>
        <p id="task" class="task">等待宿主传入运行数据…</p>
      </section>

      <section class="card">
        <dl>
          <div><dt>运行 ID</dt><dd id="runId">—</dd></div>
          <div><dt>模型</dt><dd id="model">—</dd></div>
          <div><dt>权限</dt><dd id="permission">—</dd></div>
          <div><dt>工作区</dt><dd id="workspace">—</dd></div>
          <div><dt>开始时间</dt><dd id="createdAt">—</dd></div>
          <div><dt>截止时间</dt><dd id="deadlineAt">—</dd></div>
          <div><dt>已用时间</dt><dd id="duration">—</dd></div>
          <div><dt>剩余预算</dt><dd id="remaining">—</dd></div>
          <div><dt>最近活动</dt><dd id="lastActivity">—</dd></div>
          <div><dt>事件</dt><dd id="eventCount">0</dd></div>
          <div><dt>Token</dt><dd id="tokens">—</dd></div>
        </dl>
      </section>

      <section class="card">
        <h2>工作流程</h2>
        <p class="empty">只读持久快照，不代表 SDK 当前连接状态；最近活动长时间不变时，请用 wait_run 核实。面板仅保留最近 200 条事件。</p>
        <ol id="timeline" class="timeline">
          <li class="empty">尚无 Cursor SDK 事件。</li>
        </ol>
      </section>

      <section id="outputCard" class="card" hidden>
        <h2>Cursor 最终输出</h2>
        <pre id="output" class="output"></pre>
      </section>

      <section id="errorCard" class="card" role="alert" hidden>
        <h2>状态读取错误</h2>
        <pre id="error" class="error"></pre>
        <p class="empty">读取失败不会取消任务。若沙箱无法加载，请调用 open_run 获取本机进度链接；不要重复启动任务。</p>
        <button id="retry" type="button">重新连接</button>
      </section>
    </main>

    <script>
      (() => {
        /* LOCAL_PROGRESS_MODE */
        const localProgress = window.cursorRelayLocalProgress === true;
        const projectRunPanelEvents = ${projectRunPanelEvents.toString()};
        const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);
        const STATUS_LABELS = {
          starting: "正在启动",
          running: "运行中",
          succeeded: "已完成",
          failed: "失败",
          cancelled: "已取消",
        };
        const pending = new Map();
        const legacyPending = new Set();
        let nextRequestId = 1;
        let postMessageReady = null;
        let renderTimer;
        let pauseTimer;
        let resumePause;
        const state = {
          run: null,
          events: new Map(),
          nextSequence: 0,
          pumping: false,
          destroyed: false,
          lastError: "",
          reconnecting: false,
          timelineDirty: true,
        };

        const byId = (id) => document.getElementById(id);
        const text = (id, value) => {
          byId(id).textContent = value == null || value === "" ? "—" : String(value);
        };
        const pause = (ms) => new Promise((resolve) => {
          resumePause = resolve;
          pauseTimer = setTimeout(resolve, ms);
        });

        function reportError(error) {
          if (state.destroyed) return;
          state.lastError = error instanceof Error ? error.message : String(error);
          render();
        }

        function ensureBridge() {
          if (!postMessageReady) postMessageReady = connectMcpApp().catch((error) => {
            postMessageReady = null;
            throw error;
          });
          return postMessageReady;
        }

        function request(method, params, timeoutMs = 35_000) {
          const id = nextRequestId++;
          return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              pending.delete(id);
              reject(new Error(method + " 请求超时"));
            }, timeoutMs);
            pending.set(id, {
              resolve: (value) => {
                clearTimeout(timer);
                resolve(value);
              },
              reject: (error) => {
                clearTimeout(timer);
                reject(error);
              },
            });
            window.parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
          });
        }

        function notify(method, params = {}) {
          window.parent.postMessage({ jsonrpc: "2.0", method, params }, "*");
        }

        async function connectMcpApp() {
          try {
            await request("ui/initialize", {
              protocolVersion: "2026-01-26",
              appInfo: {
                name: "cursor-relay-run-panel",
                title: "Cursor Relay 运行状态",
                version: "1.0.0",
              },
              appCapabilities: { availableDisplayModes: ["inline"] },
            }, 5_000);
            notify("ui/notifications/initialized");
            return true;
          } catch (error) {
            if (window.openai && typeof window.openai.callTool === "function") {
              return false;
            }
            throw error;
          }
        }

        async function callTool(name, args) {
          if (localProgress) {
            const response = await fetch("./snapshot?afterSequence=" + args.afterSequence, {
              cache: "no-store", signal: AbortSignal.timeout(10_000),
            });
            if (!response.ok) throw new Error(await response.text());
            return await response.json();
          }
          try {
            const ready = await ensureBridge();
            if (ready) return await request("tools/call", { name, arguments: args });
            if (window.openai && typeof window.openai.callTool === "function") {
              let timer;
              let cancel;
              try {
                return await Promise.race([
                  window.openai.callTool(name, args),
                  new Promise((_, reject) => {
                    cancel = () => reject(new Error("运行面板已关闭"));
                    legacyPending.add(cancel);
                    timer = setTimeout(() => reject(new Error("MCP 兼容桥接请求超时")), 35_000);
                  }),
                ]);
              } finally { clearTimeout(timer); legacyPending.delete(cancel); }
            }
            throw new Error("MCP Apps 桥接尚未初始化");
          } catch (error) {
            postMessageReady = null;
            throw error;
          }
        }

        function unwrap(result) {
          const structured = result && result.structuredContent
            ? result.structuredContent
            : result;
          if (!structured || typeof structured !== "object") return structured;
          if (structured.ok === false) {
            const detail = structured.error || {};
            throw new Error(detail.message || detail.code || "MCP 工具返回错误");
          }
          return structured.ok === true ? structured.data : structured;
        }

        function mergeEvents(data) {
          if (!data || !Array.isArray(data.events)) return;
          for (const event of data.events) {
            if (!event || !Number.isInteger(event.sequence)) continue;
            state.events.set(event.sequence, event);
            state.nextSequence = Math.max(state.nextSequence, event.sequence);
          }
          if (Number.isInteger(data.nextSequence)) {
            state.nextSequence = Math.max(state.nextSequence, data.nextSequence);
          }
          const sequences = Array.from(state.events.keys()).sort((a, b) => a - b);
          for (const sequence of sequences.slice(0, -200)) state.events.delete(sequence);
          if (data.events.length) state.timelineDirty = true;
        }

        function acceptConnection(data) {
          const connection = data && data.connection;
          if (connection && connection.state === "reconnecting") {
            state.reconnecting = true;
            const detail = connection.error || {};
            state.lastError = detail.message || detail.code || "Cursor SDK 暂时不可达，正在自动重连";
            return;
          }
          state.reconnecting = false;
          state.lastError = "";
        }

        function accept(result) {
          if (state.destroyed) return;
          const data = unwrap(result);
          if (!data || typeof data !== "object") return;
          if (data.run && typeof data.run === "object") {
            if (state.run && state.run.relayRunId !== data.run.relayRunId) return;
            state.run = data.run;
          }
          mergeEvents(data);
          acceptConnection((data.run && data.run.connection) ? data.run : data);
          render();
          if (state.run && !state.pumping) {
            void pump();
          }
        }

        function formatModel(model) {
          if (!model || typeof model !== "object") return "—";
          const params = Array.isArray(model.params)
            ? model.params.map((item) => item.id + "=" + item.value).join(", ")
            : "";
          return params ? model.id + " (" + params + ")" : model.id;
        }

        function formatDate(value) {
          if (!value) return "—";
          const parsed = new Date(value);
          return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toLocaleString();
        }

        function formatDuration(run) {
          if (!run) return "—";
          const explicit = Number(run.durationMs);
          const elapsed = Number.isFinite(explicit)
            ? explicit
            : Math.max(0, Date.now() - Date.parse(run.createdAt));
          if (!Number.isFinite(elapsed)) return "—";
          const seconds = Math.floor(elapsed / 1000);
          const hours = Math.floor(seconds / 3600);
          const minutes = Math.floor((seconds % 3600) / 60);
          const rest = seconds % 60;
          if (hours > 0) return hours + "h " + minutes + "m " + rest + "s";
          if (minutes > 0) return minutes + "m " + rest + "s";
          return rest + "s";
        }

        function formatRemaining(run) {
          if (!run || !run.deadlineAt || TERMINAL.has(run.status)) return "—";
          const remaining = Date.parse(run.deadlineAt) - Date.now();
          if (!Number.isFinite(remaining)) return "—";
          if (remaining <= 0) return "预算已到；快照尚未确认终态";
          const seconds = Math.floor(remaining / 1000);
          const hours = Math.floor(seconds / 3600);
          const minutes = Math.floor((seconds % 3600) / 60);
          return hours > 0 ? hours + "h " + minutes + "m" : minutes + "m";
        }

        function lastActivityAt(run) {
          const events = Array.from(state.events.values());
          const last = events.sort((left, right) => left.sequence - right.sequence).at(-1);
          return last && last.timestamp ? last.timestamp : run.updatedAt;
        }

        function compactJson(value) {
          if (value == null) return "";
          try {
            const serialized = JSON.stringify(value, null, 2);
            return serialized.length > 8_000
              ? serialized.slice(0, 8_000) + "\n…事件内容已在面板中截断"
              : serialized;
          } catch {
            return String(value);
          }
        }

        function renderTimeline() {
          if (!state.timelineDirty) return;
          state.timelineDirty = false;
          const timeline = byId("timeline");
          const events = Array.from(state.events.values())
            .sort((left, right) => left.sequence - right.sequence)
            .slice(-200);
          if (events.length === 0) {
            timeline.replaceChildren();
            const empty = document.createElement("li");
            empty.className = "empty";
            empty.textContent = "尚无 Cursor SDK 事件。";
            timeline.append(empty);
            return;
          }
          const stickToBottom =
            timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 32;
          const existing = new Map(
            Array.from(timeline.children).map((item) => [item.dataset.key, item]),
          );
          const fragment = document.createDocumentFragment();
          for (const entry of projectRunPanelEvents(events)) {
            let item = existing.get(entry.key);
            if (!item || item.dataset.kind !== entry.kind) {
              item = document.createElement("li");
              item.dataset.key = entry.key;
              item.dataset.kind = entry.kind;
              if (entry.kind === "text") {
                item.className = "event event-text";
                const title = document.createElement("div");
                title.className = "event-title";
                const content = document.createElement("div");
                content.className = "stream-text";
                item.append(title, content);
              } else {
                item.className = "event";
                const sequence = document.createElement("span");
                sequence.className = "seq";
                const body = document.createElement("div");
                const title = document.createElement("div");
                title.className = "event-title";
                const kind = document.createElement("span");
                kind.className = "event-kind";
                const time = document.createElement("span");
                time.className = "event-time";
                title.append(kind, time);
                const detail = document.createElement("pre");
                detail.className = "event-data";
                body.append(title, detail);
                item.append(sequence, body);
              }
            }
            if (entry.kind === "text") {
              item.querySelector(".event-title").textContent = entry.label;
              const content = item.querySelector(".stream-text");
              if (content.textContent !== entry.text) content.textContent = entry.text;
            } else {
              const event = entry.event;
              item.querySelector(".seq").textContent = "#" + event.sequence;
              const title = item.querySelector(".event-title");
              title.querySelector(".event-kind").textContent = event.type || "event";
              title.querySelector(".event-time").textContent = formatDate(event.timestamp);
              const detail = item.querySelector(".event-data");
              const serialized = compactJson(event.data);
              detail.hidden = !serialized;
              detail.textContent = serialized;
            }
            fragment.append(item);
          }
          timeline.replaceChildren(fragment);
          if (stickToBottom) timeline.scrollTop = timeline.scrollHeight;
        }

        function render() {
          const run = state.run;
          const active = Boolean(run && !TERMINAL.has(run.status));
          byId("pulse").dataset.active = String(active);
          text(
            "liveText",
            state.lastError
              ? "进度读取暂时失败；任务未被取消"
              : state.reconnecting
              ? "Cursor SDK 暂时不可达，正在自动重连"
              : active
                ? "正在刷新只读进度快照"
                : run
                  ? "实时读取已停止"
                  : "等待运行数据",
          );
          const status = byId("status");
          status.dataset.status = run ? run.status : "unknown";
          status.textContent = run ? STATUS_LABELS[run.status] || run.status : "未知";
          const errorMessage = state.lastError || (run && run.error && run.error.message) || "";
          byId("errorCard").hidden = !errorMessage;
          text("error", errorMessage);
          if (!run) return;

          text("task", run.task);
          text("runId", run.relayRunId);
          text("model", formatModel(run.effectiveModel || run.model));
          text("permission", run.permission);
          text("workspace", run.workspace);
          text("createdAt", formatDate(run.createdAt));
          text("deadlineAt", formatDate(run.deadlineAt));
          text("duration", formatDuration(run));
          text("remaining", formatRemaining(run));
          text("lastActivity", formatDate(lastActivityAt(run)));
          text("eventCount", Math.max(Number(run.eventCount) || 0, state.events.size));
          text("tokens", run.usage && Number.isFinite(run.usage.totalTokens)
            ? run.usage.totalTokens.toLocaleString()
            : "—");
          renderTimeline();

          const outputCard = byId("outputCard");
          outputCard.hidden = !run.assistantText;
          text("output", run.assistantText || "");
        }

        async function pump() {
          if (state.pumping || state.destroyed || (!state.run && !localProgress)) return;
          state.pumping = true;
          try {
            while (!state.destroyed) {
              try {
                const result = await callTool("read_run_progress", {
                  relayRunId: state.run && state.run.relayRunId,
                  afterSequence: state.nextSequence,
                });
                if (state.destroyed) break;
                accept(result);
                if (state.run && TERMINAL.has(state.run.status)) break;
              } catch (error) {
                if (state.destroyed) break;
                reportError(error);
              }
              await pause(2_000);
            }
          } finally {
            state.pumping = false;
            if (!state.destroyed) render();
          }
        }

        function teardown() {
          state.destroyed = true;
          clearInterval(renderTimer);
          clearTimeout(pauseTimer);
          if (resumePause) resumePause();
          for (const item of pending.values()) item.reject(new Error("运行面板已关闭"));
          pending.clear();
          for (const cancel of legacyPending) cancel();
          legacyPending.clear();
        }

        window.addEventListener("message", (event) => {
          if (event.source !== window.parent) return;
          const message = event.data;
          if (!message || message.jsonrpc !== "2.0") return;
          if (!message.method && message.id !== undefined && pending.has(message.id)) {
            const item = pending.get(message.id);
            pending.delete(message.id);
            if (message.error) item.reject(new Error(message.error.message || "MCP Apps 请求失败"));
            else item.resolve(message.result);
            return;
          }
          if (message.method === "ui/notifications/tool-result") {
            try {
              accept(message.params);
            } catch (error) {
              state.lastError = error instanceof Error ? error.message : String(error);
              render();
            }
            return;
          }
          if (message.method === "ui/resource-teardown" || message.method === "ping") {
            if (message.method === "ui/resource-teardown") teardown();
            if (message.id !== undefined) {
              window.parent.postMessage(
                { jsonrpc: "2.0", id: message.id, result: {} },
                "*",
              );
            }
          }
        }, { passive: true });

        window.addEventListener("pagehide", () => {
          teardown();
        }, { once: true });

        byId("retry").addEventListener("click", () => {
          postMessageReady = null;
          if (resumePause) { clearTimeout(pauseTimer); resumePause(); }
          if (localProgress || state.run) void pump();
          else void ensureBridge().catch(reportError);
        });

        if (!localProgress) void ensureBridge().catch(reportError);

        if (window.openai && window.openai.toolOutput) {
          try {
            accept({ structuredContent: window.openai.toolOutput });
          } catch (error) {
            state.lastError = error instanceof Error ? error.message : String(error);
            render();
          }
        }
        render();
        if (localProgress) void pump();
        renderTimer = window.setInterval(() => {
          if (state.run && !TERMINAL.has(state.run.status)) render();
        }, 1_000);
      })();
    </script>
  </body>
</html>`;
