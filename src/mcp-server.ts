import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { CURSOR_RELAY_HARD_MAX_TIMEOUT_MS } from "./config.js";
import { asRelayError } from "./errors.js";
import type { RelayService } from "./relay-service.js";
import {
  TARGET_LOCATION_MAX_CHARS,
  TARGET_LOCATIONS_MAX_ITEMS,
  TASK_SCOPE_MAX_CHARS,
  targetLocationIsAllowed,
  taskScopeContainsEmbeddedSource,
} from "./task-contract.js";
import {
  RUN_PANEL_HTML,
  RUN_PANEL_MIME_TYPE,
  RUN_PANEL_URI,
} from "./run-panel.js";

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
const codexControlledToolSchema = z.enum([
  "delete",
  "task",
  "mcp",
  "generateImage",
]);
const timeoutSchema = z
  .number()
  .int()
  .min(1_000)
  .max(CURSOR_RELAY_HARD_MAX_TIMEOUT_MS)
  .optional()
  .describe(
    "Cursor 任务总预算（毫秒）；普通任务省略即可使用 24 小时默认值，硬上限同为 24 小时。",
  );
const taskScopeSchema = z
  .string()
  .trim()
  .min(1)
  .max(TASK_SCOPE_MAX_CHARS)
  .refine((value) => !taskScopeContainsEmbeddedSource(value), {
    message:
      "task 只能描述审查、修改与验收范围，禁止嵌入源码正文、代码块或补丁；Cursor 会自行读取工作区",
  })
  .describe(
    "任务或审查范围与验收要求；禁止传源码正文、代码块或补丁，由 Cursor 在获授权工作区自行读取。",
  );
const targetLocationsSchema = z
  .array(
    z
      .string()
      .trim()
      .min(1)
      .max(TARGET_LOCATION_MAX_CHARS)
      .refine(targetLocationIsAllowed, {
        message: "只能传工作区内文件、目录或行号位置，禁止多行文本或源码正文",
      }),
  )
  .max(TARGET_LOCATIONS_MAX_ITEMS)
  .optional()
  .describe(
    "工作区内的文件、目录或行号位置列表，仅传位置不传内容；省略表示由 Cursor 按任务范围在工作区内定位。",
  );

export function createMcpServer(service: RelayService): McpServer {
  const server = new McpServer({ name: "cursor-relay-mcp", version: "0.1.1" });

  server.registerResource(
    "cursor-relay-run-panel",
    RUN_PANEL_URI,
    {
      title: "Cursor Relay 运行状态",
      description: "只读展示 Cursor Relay 运行状态与增量事件。",
      mimeType: RUN_PANEL_MIME_TYPE,
    },
    () => ({
      contents: [
        {
          uri: RUN_PANEL_URI,
          mimeType: RUN_PANEL_MIME_TYPE,
          text: RUN_PANEL_HTML,
          _meta: {
            ui: { prefersBorder: true },
            "openai/widgetDescription":
              "实时展示 Cursor Relay 的运行状态、模型、权限、事件时间线与最终输出。",
            "openai/widgetPrefersBorder": true,
          },
        },
      ],
    }),
  );

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
        "仅当用户在当前对话明确要求 Cursor Relay 读取或修改该工作区时调用。签发绑定当前 MCP 对话与精确工作区的可复用授权；read-only 与 workspace-write 均只传位置和范围，禁止传源码正文，由 Cursor 自行读取；不授予危险权限，进程结束即失效。",
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
        "在允许的本地工作区启动持久 Cursor Agent 运行。read-only 与 workspace-write 均只接受工作区、目标位置和任务范围，禁止嵌入源码正文；Cursor 自行读取所需文件。必须显式选择模型和幂等键。",
      inputSchema: {
        workspace: z.string().min(1),
        task: taskScopeSchema,
        targetLocations: targetLocationsSchema,
        model: modelSchema,
        permission: permissionSchema.optional(),
        codexAllowedTools: z
          .array(codexControlledToolSchema)
          .max(4)
          .optional()
          .describe(
            "仅由 Codex 主进程按任务范围决定的额外工具放行；高风险且超出用户既有授权时应先人工确认。",
          ),
        confirmedDangerousPermission: z.boolean().optional(),
        workspaceApprovalToken: z.string().min(32).max(200).optional(),
        idempotencyKey: z.string().min(8).max(200),
        timeoutMs: timeoutSchema,
      },
      annotations: mutatingAnnotations(true),
      _meta: runPanelMeta("正在启动 Cursor…", "Cursor 运行已启动"),
    },
    guarded(async (input, extra) =>
      service.startRun(input, callerScope(extra)),
    ),
  );

  server.registerTool(
    "reply_run",
    {
      description:
        "在已结束的 Cursor Agent 会话中续接运行并保留 agentId；只传目标位置与任务范围，禁止源码正文，由 Cursor 自行读取。",
      inputSchema: {
        parentRunId: z.string().min(1),
        task: taskScopeSchema,
        targetLocations: targetLocationsSchema,
        model: modelSchema.optional(),
        permission: permissionSchema.optional(),
        codexAllowedTools: z
          .array(codexControlledToolSchema)
          .max(4)
          .optional()
          .describe(
            "本次续接由 Codex 主进程决定的额外工具放行；省略时继承父运行，传空数组可撤销。",
          ),
        confirmedDangerousPermission: z.boolean().optional(),
        workspaceApprovalToken: z.string().min(32).max(200).optional(),
        idempotencyKey: z.string().min(8).max(200),
        timeoutMs: timeoutSchema,
      },
      annotations: mutatingAnnotations(true),
      _meta: runPanelMeta("正在续接 Cursor…", "Cursor 后续运行已启动"),
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
      _meta: appCallableMeta(),
    },
    guarded(async ({ relayRunId }) => ({
      run: await service.getRun(relayRunId),
    })),
  );

  server.registerTool(
    "view_run",
    {
      description:
        "打开一个只读实时面板，展示指定 Cursor Relay 运行的状态、事件时间线与最终输出；不启动、续接、取消或修改运行。",
      inputSchema: { relayRunId: z.string().min(1) },
      annotations: readOnlyAnnotations(false),
      _meta: runPanelMeta("正在打开 Cursor 运行面板…", "Cursor 运行面板已打开"),
    },
    guarded(async ({ relayRunId }) => ({
      run: await service.getRunSnapshot(relayRunId),
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
      _meta: appCallableMeta(),
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
      _meta: appCallableMeta(),
    },
    guarded(async ({ relayRunId, afterSequence, limit }) =>
      service.readEvents(relayRunId, afterSequence, limit),
    ),
  );

  return server;
}

function runPanelMeta(invoking: string, invoked: string) {
  return {
    ui: { resourceUri: RUN_PANEL_URI },
    "openai/outputTemplate": RUN_PANEL_URI,
    "openai/toolInvocation/invoking": invoking,
    "openai/toolInvocation/invoked": invoked,
  };
}

function appCallableMeta() {
  return {
    ui: { visibility: ["model", "app"] },
    "openai/widgetAccessible": true,
  };
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
