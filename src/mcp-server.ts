import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { asRelayError } from "./errors.js";
import type { RelayService } from "./relay-service.js";

const modelSchema = z.object({
  id: z.string().min(1),
  params: z
    .array(z.object({ id: z.string().min(1), value: z.string().min(1) }))
    .optional(),
});
const permissionSchema = z.enum([
  "read-only",
  "workspace-write",
  "danger-full-access",
]);

export function createMcpServer(service: RelayService): McpServer {
  const server = new McpServer({ name: "cursor-relay-mcp", version: "0.1.0" });

  server.registerTool(
    "doctor",
    {
      description:
        "检查 Cursor Relay 配置、认证与持久目录；不调用 Cursor 模型。",
      inputSchema: {},
      annotations: readOnlyAnnotations(false),
    },
    guarded(() => service.doctor()),
  );

  server.registerTool(
    "list_models",
    {
      description:
        "从当前 Cursor 账户发现可用模型、别名与参数；start_run 前应调用。",
      inputSchema: {},
      annotations: readOnlyAnnotations(true),
    },
    guarded(async () => service.listModels()),
  );

  server.registerTool(
    "authorize_workspace",
    {
      description:
        "仅当用户在当前对话明确要求 Cursor Relay 读取或修改该工作区时调用。签发绑定当前 MCP 对话与精确工作区的可复用授权；支持 read-only 与 workspace-write，不授予危险权限，进程结束即失效。",
      inputSchema: {
        workspace: z.string().min(1),
        permission: z.enum(["read-only", "workspace-write"]).optional(),
      },
      annotations: approvalAnnotations(),
    },
    guarded(async (input, extra) =>
      service.authorizeConversationWorkspace(input, callerScope(extra)),
    ),
  );

  server.registerTool(
    "start_run",
    {
      description:
        "在允许的本地工作区启动持久 Cursor Agent 运行。默认只读；修改任务使用 workspace-write，并要求 Cursor 自行检查工作区、直接修改、验证并报告变更文件；必须显式选择模型和幂等键。",
      inputSchema: {
        workspace: z.string().min(1),
        task: z.string().min(1),
        model: modelSchema,
        permission: permissionSchema.optional(),
        confirmedDangerousPermission: z.boolean().optional(),
        workspaceApprovalToken: z.string().min(32).max(200).optional(),
        idempotencyKey: z.string().min(8).max(200),
        timeoutMs: z.number().int().optional(),
      },
      annotations: mutatingAnnotations(true),
    },
    guarded(async (input, extra) =>
      service.startRun(input, callerScope(extra)),
    ),
  );

  server.registerTool(
    "reply_run",
    {
      description:
        "在一个已结束的 Cursor Agent 会话中发起后续运行，并保留同一 agentId。",
      inputSchema: {
        parentRunId: z.string().min(1),
        task: z.string().min(1),
        model: modelSchema.optional(),
        permission: permissionSchema.optional(),
        confirmedDangerousPermission: z.boolean().optional(),
        workspaceApprovalToken: z.string().min(32).max(200).optional(),
        idempotencyKey: z.string().min(8).max(200),
        timeoutMs: z.number().int().optional(),
      },
      annotations: mutatingAnnotations(true),
    },
    guarded(async (input, extra) =>
      service.replyRun(input, callerScope(extra)),
    ),
  );

  server.registerTool(
    "get_run",
    {
      description:
        "读取一个持久运行的当前状态，并在进程重启后自动重连 Cursor SDK 运行。",
      inputSchema: { relayRunId: z.string().min(1) },
      annotations: readOnlyAnnotations(true),
    },
    guarded(async ({ relayRunId }) => ({
      run: await service.getRun(relayRunId),
    })),
  );

  server.registerTool(
    "wait_run",
    {
      description:
        "最多等待 30 秒。terminal=false 时 mustCallAgain=true，调用方必须继续轮询。",
      inputSchema: {
        relayRunId: z.string().min(1),
        waitMs: z.number().int().min(0).max(30_000).optional(),
      },
      annotations: readOnlyAnnotations(true),
    },
    guarded(async ({ relayRunId, waitMs }) =>
      service.waitRun(relayRunId, waitMs),
    ),
  );

  server.registerTool(
    "cancel_run",
    {
      description: "取消仍在执行的 Cursor SDK 运行；重复取消具有稳定结果。",
      inputSchema: { relayRunId: z.string().min(1) },
      annotations: mutatingAnnotations(true),
    },
    guarded(async ({ relayRunId }) => service.cancelRun(relayRunId)),
  );

  server.registerTool(
    "list_runs",
    {
      description: "按创建时间倒序列出 Relay 持久运行。",
      inputSchema: { limit: z.number().int().min(1).max(200).optional() },
      annotations: readOnlyAnnotations(false),
    },
    guarded(async ({ limit }) => service.listRuns(limit)),
  );

  server.registerTool(
    "read_events",
    {
      description:
        "按递增序号读取已持久化的 Cursor SDK 流事件。事件数量有上限。",
      inputSchema: {
        relayRunId: z.string().min(1),
        afterSequence: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(500).optional(),
      },
      annotations: readOnlyAnnotations(true),
    },
    guarded(async ({ relayRunId, afterSequence, limit }) =>
      service.readEvents(relayRunId, afterSequence, limit),
    ),
  );

  return server;
}

function readOnlyAnnotations(openWorldHint: boolean) {
  return {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint,
  };
}

function mutatingAnnotations(openWorldHint: boolean) {
  return {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint,
  };
}

function approvalAnnotations() {
  return {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  };
}

interface ToolContext {
  sessionId?: string;
  taskId?: string;
}

function callerScope(extra: ToolContext): string {
  if (extra.taskId) return `task:${extra.taskId}`;
  if (extra.sessionId) return `session:${extra.sessionId}`;
  return "stdio-process";
}

function guarded<TInput extends Record<string, unknown>>(
  handler: (input: TInput, extra: ToolContext) => unknown,
) {
  return async (input: TInput, extra: ToolContext) => {
    try {
      const data = await handler(input, extra);
      const structuredContent = { ok: true, data } as Record<string, unknown>;
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(structuredContent, null, 2),
          },
        ],
        structuredContent,
      };
    } catch (error) {
      const relayError = asRelayError(error);
      const structuredContent = {
        ok: false,
        error: relayError.toJSON(),
      } as Record<string, unknown>;
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(structuredContent, null, 2),
          },
        ],
        structuredContent,
      };
    }
  };
}
