import {
  Agent,
  Cursor,
  JsonlLocalAgentStore,
  type AgentOptions,
  type SDKMessage,
} from "@cursor/sdk";
import { resolve } from "node:path";
import type {
  AgentLaunchOptions,
  CursorEvent,
  CursorRunHandle,
  CursorSdkPort,
} from "./sdk-port.js";

export class CursorSdkAdapter implements CursorSdkPort {
  private readonly store: JsonlLocalAgentStore;
  private readonly apiKey: string | undefined;

  constructor(stateDir: string, apiKey?: string) {
    this.store = new JsonlLocalAgentStore(resolve(stateDir, "cursor-sdk"));
    this.apiKey = apiKey;
  }

  async listModels() {
    return await Cursor.models.list(
      this.apiKey ? { apiKey: this.apiKey } : undefined,
    );
  }

  async start(
    task: string,
    options: AgentLaunchOptions,
  ): Promise<CursorRunHandle> {
    const agent = await Agent.create(this.agentOptions(options));
    const run = await agent.send(task, {
      idempotencyKey: options.idempotencyKey,
    });
    return wrapRun(run);
  }

  async reply(
    agentId: string,
    task: string,
    options: AgentLaunchOptions,
  ): Promise<CursorRunHandle> {
    const agent = await Agent.resume(agentId, this.agentOptions(options));
    const run = await agent.send(task, {
      idempotencyKey: options.idempotencyKey,
    });
    return wrapRun(run);
  }

  async getRun(runId: string, workspace: string): Promise<CursorRunHandle> {
    const run = await Agent.getRun(runId, {
      runtime: "local",
      cwd: workspace,
      store: this.store,
    });
    return wrapRun(run);
  }

  async findRun(
    agentId: string,
    workspace: string,
    createdAfter: number,
  ): Promise<CursorRunHandle | undefined> {
    const result = await Agent.listRuns(agentId, {
      runtime: "local",
      cwd: workspace,
      store: this.store,
      limit: 20,
    });
    const candidate = result.items.find(
      (run) =>
        (run.createdAt === undefined && run.status === "running") ||
        (run.createdAt !== undefined && run.createdAt >= createdAfter - 1_000),
    );
    return candidate ? wrapRun(candidate) : undefined;
  }

  private agentOptions(options: AgentLaunchOptions): AgentOptions {
    return {
      agentId: options.agentId,
      idempotencyKey: options.idempotencyKey,
      model: {
        id: options.model.id,
        ...(options.model.params ? { params: options.model.params } : {}),
      },
      ...(this.apiKey ? { apiKey: this.apiKey } : {}),
      ...(options.tools ? { tools: options.tools } : {}),
      ...(options.disallowedTools
        ? { disallowedTools: options.disallowedTools }
        : {}),
      local: {
        cwd: options.workspace,
        store: this.store,
        settingSources: ["project"],
        autoReview: options.autoReview,
        sandboxOptions: { enabled: options.sandboxEnabled },
        enableAgentRetries: true,
      },
    };
  }
}

function wrapRun(
  run: Awaited<ReturnType<typeof Agent.getRun>>,
): CursorRunHandle {
  return {
    id: run.id,
    agentId: run.agentId,
    createdAt: run.createdAt,
    get status() {
      return run.status;
    },
    async *stream() {
      for await (const event of run.stream())
        yield event as SDKMessage & CursorEvent;
    },
    wait: () => run.wait(),
    cancel: () => run.cancel(),
  };
}
