import { randomBytes } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { RelayService } from "./relay-service.js";
import { RUN_PANEL_HTML } from "./run-panel.js";

type ProgressReader = Pick<RelayService, "getRunProgressSnapshot">;

/** Process-local, read-only capability links; never accepts workspace paths. */
export class RunProgressServer {
  private server: Server | undefined;
  private origin: string | undefined;
  private starting: Promise<void> | undefined;
  private closed = false;
  private readonly grants = new Map<
    string,
    { runId: string; expiresAt: number }
  >();

  constructor(private readonly reader: ProgressReader) {}

  async open(relayRunId: string) {
    const { run } = await this.reader.getRunProgressSnapshot(relayRunId);
    this.assertOpen();
    this.starting ??= this.listen().catch((error: unknown) => {
      this.starting = undefined;
      throw error;
    });
    await this.starting;
    this.assertOpen();
    for (const [token, grant] of this.grants) {
      if (grant.expiresAt <= Date.now()) this.grants.delete(token);
      else if (grant.runId === relayRunId) return this.link(token, run);
    }
    if (this.grants.size >= 256) throw new Error("本机进度链接数量已达上限");
    const token = randomBytes(32).toString("hex");
    this.grants.set(token, {
      runId: relayRunId,
      expiresAt: Date.now() + 86_400_000,
    });
    return this.link(token, run);
  }

  private assertOpen() {
    if (this.closed) throw new Error("运行进度服务已关闭");
  }

  private link(token: string, run: unknown) {
    return {
      run,
      progressUrl: `${this.origin}/runs/${token}/`,
      instruction:
        "请向用户展示可点击的本机进度链接。页面只读持久快照，不启动或取消任务；继续用 wait_run 监控。链接仅在本机、当前 MCP 进程内有效，最长 24 小时；失效后重新调用 open_run，勿重发任务。",
    };
  }

  private async listen() {
    const server = createServer((request, response) => {
      void (async () => {
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("Referrer-Policy", "no-referrer");
        response.setHeader("X-Content-Type-Options", "nosniff");
        response.setHeader(
          "Content-Security-Policy",
          "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
        );
        const origin = this.origin;
        if (
          !origin ||
          request.headers.host !== new URL(origin).host ||
          (request.headers.origin && request.headers.origin !== origin)
        ) {
          return this.respond(response, 403, "禁止跨站访问");
        }
        if (request.method !== "GET")
          return this.respond(response, 405, "仅支持只读访问");
        const url = new URL(request.url ?? "/", origin);
        const match = /^\/runs\/([a-f0-9]{64})\/(snapshot)?$/u.exec(
          url.pathname,
        );
        const grant = match?.[1] ? this.grants.get(match[1]) : undefined;
        if (!grant || grant.expiresAt <= Date.now())
          return this.respond(
            response,
            404,
            "链接已失效，请重新调用 open_run；不要重发任务。",
          );
        if (!match?.[2]) {
          return this.respond(
            response,
            200,
            RUN_PANEL_HTML.replace(
              "/* LOCAL_PROGRESS_MODE */",
              "window.cursorRelayLocalProgress = true;",
            ),
            "text/html; charset=utf-8",
          );
        }
        if (request.headers["sec-fetch-site"] === "cross-site")
          return this.respond(response, 403, "禁止跨站访问");
        const cursor = url.searchParams.get("afterSequence") ?? "0";
        if (!/^\d{1,15}$/u.test(cursor))
          return this.respond(response, 400, "无效事件游标");
        const data = await this.reader.getRunProgressSnapshot(
          grant.runId,
          Number(cursor),
        );
        this.respond(
          response,
          200,
          JSON.stringify({ ok: true, data }),
          "application/json; charset=utf-8",
        );
      })().catch(() =>
        this.respond(
          response,
          503,
          "进度暂时不可读，请稍后重试；任务未被取消。",
        ),
      );
    });
    this.server = server;
    server.requestTimeout = 10_000;
    server.headersTimeout = 10_000;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        const address = server.address();
        if (!address || typeof address === "string")
          return reject(new Error("无法创建本机进度入口"));
        this.origin = `http://127.0.0.1:${address.port}`;
        server.unref();
        resolve();
      });
    });
  }

  private respond(
    response: ServerResponse,
    status: number,
    body: string,
    contentType = "text/plain; charset=utf-8",
  ) {
    if (response.destroyed || response.writableEnded) return;
    response.writeHead(status, { "Content-Type": contentType });
    response.end(body, "utf8");
  }

  async close() {
    this.closed = true;
    await this.starting?.catch(() => undefined);
    this.grants.clear();
    const server = this.server;
    if (server?.listening) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    }
  }
}
