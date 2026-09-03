import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { RUN_PANEL_HTML } from "../src/run-panel.js";

class Element {
  textContent = "";
  className = "";
  hidden = true;
  dataset: Record<string, string> = {};
  children: Element[] = [];
  scrollHeight = 0;
  scrollTop = 0;
  clientHeight = 0;
  listeners = new Map<string, () => void>();
  constructor(readonly fragment = false) {}
  append(...items: Element[]) {
    for (const item of items)
      this.children.push(...(item.fragment ? item.children : [item]));
  }
  replaceChildren(...items: Element[]) {
    this.children = [];
    this.append(...items);
  }
  querySelector(selector: string): Element | undefined {
    for (const child of this.children) {
      if (child.className.split(" ").includes(selector.slice(1))) return child;
      const nested = child.querySelector(selector);
      if (nested) return nested;
    }
    return undefined;
  }
  addEventListener(name: string, listener: () => void) {
    this.listeners.set(name, listener);
  }
}

const run = {
  relayRunId: "panel-run",
  status: "running",
  task: "只读进度",
  createdAt: new Date().toISOString(),
};
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function harness(options: {
  initial?: unknown;
  local?: boolean;
  failInitialize?: boolean;
  legacy?: boolean;
  tool: (call: number) => unknown;
}) {
  const elements = new Map<string, Element>();
  const get = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Element());
    const element = elements.get(id);
    assert.ok(element);
    return element;
  };
  const listeners = new Map<string, (event: unknown) => void>();
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let timerId = 0;
  let calls = 0;
  let initializations = 0;
  const schedule = (fn: () => void, ms: number) => {
    timers.set(++timerId, { fn, ms });
    return timerId;
  };
  const clear = (id: number) => {
    timers.delete(id);
  };
  const messages: Record<string, unknown>[] = [];
  const parent = {
    postMessage(message: Record<string, unknown>) {
      messages.push(message);
      if (message.method === "ui/initialize") {
        initializations++;
        if (!options.failInitialize)
          queueMicrotask(() => reply({ id: message.id, result: {} }));
      } else if (message.method === "tools/call") {
        const params = message.params as { name: string };
        assert.equal(params.name, "read_run_progress");
        void Promise.resolve()
          .then(() => options.tool(++calls))
          .then(
            (result) => reply({ id: message.id, result }),
            (error: unknown) =>
              reply({
                id: message.id,
                error: {
                  message:
                    error instanceof Error ? error.message : String(error),
                },
              }),
          );
      }
    },
  };
  const reply = (message: Record<string, unknown>) =>
    listeners.get("message")?.({
      source: parent,
      data: { jsonrpc: "2.0", ...message },
    });
  const script = /<script>([\s\S]*?)<\/script>/u.exec(RUN_PANEL_HTML)?.[1];
  assert.ok(script);
  runInNewContext(script, {
    window: {
      parent,
      cursorRelayLocalProgress: options.local,
      openai: options.initial
        ? {
            toolOutput: options.initial,
            ...(options.legacy
              ? { callTool: () => options.tool(++calls) }
              : {}),
          }
        : undefined,
      addEventListener: (name: string, listener: (event: unknown) => void) =>
        listeners.set(name, listener),
      setInterval: schedule,
    },
    document: {
      getElementById: get,
      createElement: () => new Element(),
      createDocumentFragment: () => new Element(true),
    },
    setTimeout: schedule,
    clearTimeout: clear,
    clearInterval: clear,
    fetch: async () => ({ ok: true, json: () => options.tool(++calls) }),
    AbortSignal,
    // tsx preserves function names inside the injected projector.
    __name: (fn: unknown) => fn,
  });
  return {
    get,
    messages,
    timers,
    options,
    get calls() {
      return calls;
    },
    get initializations() {
      return initializations;
    },
    reply,
    async fire(ms: number) {
      for (const [id, timer] of [...timers])
        if (timer.ms === ms) {
          clear(id);
          timer.fn();
        }
      await flush();
    },
    close() {
      listeners.get("pagehide")?.({});
    },
  };
}

test("first read failure retries and terminal runs fetch their events before stopping", async () => {
  const app = harness({
    initial: { run: { ...run, status: "succeeded" } },
    tool(call) {
      if (call === 1) throw new Error("temporary disconnect");
      return {
        run: { ...run, status: "succeeded", assistantText: "已完成" },
        events: [
          { sequence: 1, type: "thinking", data: { text: "恢复后的正文" } },
        ],
      };
    },
  });
  try {
    await flush();
    assert.equal(app.calls, 1);
    assert.equal(app.get("errorCard").hidden, false);
    assert.match(app.get("error").textContent, /temporary disconnect/u);
    await app.fire(2_000);
    assert.equal(app.calls, 2);
    assert.equal(app.get("errorCard").hidden, true);
    assert.equal(app.get("output").textContent, "已完成");
    assert.equal(
      app.get("timeline").querySelector(".stream-text")?.textContent,
      "恢复后的正文",
    );
    await app.fire(2_000);
    assert.equal(app.calls, 2);
  } finally {
    app.close();
  }
});

test("handshake error is visible before run data and retry reinitializes the bridge", async () => {
  const app = harness({ failInitialize: true, tool: () => ({ run }) });
  try {
    await app.fire(5_000);
    assert.equal(app.get("errorCard").hidden, false);
    assert.match(app.get("error").textContent, /ui\/initialize/u);
    app.options.failInitialize = false;
    app.get("retry").listeners.get("click")?.();
    await flush();
    assert.equal(app.initializations, 2);
    app.reply({ method: "ui/notifications/tool-result", params: { run } });
    await flush();
    assert.equal(app.calls, 1);
    assert.equal(app.get("errorCard").hidden, true);
  } finally {
    app.close();
  }
});

test("local viewer bypasses sandbox, bounds event memory/display, and tears down timers", async () => {
  const app = harness({
    local: true,
    tool: (call) => ({
      run,
      events: Array.from({ length: 200 }, (_, i) => ({
        sequence: (call - 1) * 200 + i + 1,
        type: "status",
        data: {},
      })),
    }),
  });
  await flush();
  await app.fire(2_000);
  assert.equal(app.initializations, 0);
  assert.equal(app.calls, 2);
  assert.equal(app.get("timeline").children.length, 200);
  assert.equal(
    app.get("eventCount").textContent,
    "200",
    "old events are released from memory",
  );
  assert.equal(app.get("timeline").children[0]?.dataset.key, "event:201");
  app.close();
  await flush();
  assert.equal(app.timers.size, 0);
});

test("teardown answers host and ignores late tool output without restarting polling", async () => {
  let finish!: (result: unknown) => void;
  const app = harness({
    initial: { run },
    tool: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  await flush();
  app.reply({ id: 77, method: "ping" });
  assert.ok(
    app.messages.some((message) => message.id === 77 && message.result),
  );
  app.reply({ id: 78, method: "ui/resource-teardown" });
  finish({ run: { ...run, status: "succeeded" } });
  await flush();
  assert.equal(app.get("status").dataset.status, "running");
  assert.equal(app.timers.size, 0);
  assert.equal(app.calls, 1);
});

test("standard bridge takes priority; legacy calls are bounded and released on teardown", async () => {
  const standard = harness({
    initial: { run },
    legacy: true,
    tool: () => ({ run: { ...run, status: "succeeded" } }),
  });
  await flush();
  assert.ok(
    standard.messages.some((message) => message.method === "tools/call"),
  );
  standard.close();
  const legacy = harness({
    initial: { run },
    legacy: true,
    failInitialize: true,
    tool: () => new Promise(() => undefined),
  });
  await legacy.fire(5_000);
  assert.equal(legacy.calls, 1);
  await legacy.fire(35_000);
  assert.match(legacy.get("error").textContent, /兼容桥接请求超时/u);
  await legacy.fire(2_000);
  await legacy.fire(5_000);
  assert.equal(legacy.calls, 2);
  legacy.close();
  await flush();
  assert.equal(legacy.timers.size, 0);
});
