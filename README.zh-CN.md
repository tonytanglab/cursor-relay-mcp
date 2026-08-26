# cursor-relay-mcp

基于官方 `@cursor/sdk` 的本地 MCP 服务，让 Codex、Claude Code 或其他 MCP 客户端把一个明确子任务交给指定 Cursor 模型，同时保留可恢复的运行状态。

> `@cursor/sdk` 仍为 public beta。本项目把它精确锁定为 `1.0.28`，并提供 SDK 导出契约测试；升级前请先修改版本并运行完整兼容测试。

## 能力

- 通过 Cursor 账户实时发现模型、别名和可选参数，不维护易过期的静态模型表。
- 幂等 `start_run` / `reply_run`，相同键和相同请求返回原运行；不同请求返回结构化冲突。
- Relay 状态采用原子 UTF-8 JSON，Cursor SDK 状态采用官方 `JsonlLocalAgentStore`；进程重启后可通过 `Agent.getRun` 重连。
- `wait_run` 每次最多等待 30 秒，未结束时明确返回 `mustCallAgain=true`。
- 总运行超时、取消、有限事件缓冲、8 KiB 单事件上限、敏感字段名脱敏以及统一结构化错误。
- 安全默认值：无人值守运行必须命中静态工作区白名单；当前对话明确授权时可签发短时一次性只读 capability；默认只读并只加载项目设置；支持的非 Windows 主机默认启用 Cursor 沙箱，Windows 因当前 SDK 本地运行时不支持而默认关闭沙箱，但仍强制只读工具白名单。
- SDK Agent 句柄在运行终态后释放；模型、requestId、耗时和 token usage 使用官方公开结果字段持久化。

## 要求与安装

需要在 Codex Windows 桌面版中完成 personal marketplace 注册、缓存安装和真实模型验收时，请直接使用 [Codex Windows 快速安装与避坑手册](./CODEX_INSTALL.zh-CN.md)。该手册包含正确目录布局、WindowsApps CLI 备用路径、Cursor stored login、SDK sandbox 兼容、缓存重装和 Grok 4.6 冒烟测试流程。

- Git、Node.js `>=22.13`
- 可登录的 Cursor 账户

推荐使用官方 `Cursor.auth.login()` stored login。每台电脑、每个启动 MCP 服务的操作系统用户执行一次：

```powershell
git clone https://github.com/tonytanglab/cursor-relay-mcp.git
cd cursor-relay-mcp
npm install

# 打开系统默认浏览器，完成 Cursor 官方 SDK 登录。
node --input-type=module --eval 'import { Cursor } from "@cursor/sdk"; await Cursor.auth.login({ apiKeyName: "cursor-relay-mcp" })'

npm run build
$env:CURSOR_RELAY_WORKSPACE_ROOTS = "D:\app\git"
node .\dist\index.js
```

官方 SDK 会打开系统默认浏览器，创建一个具名、可过期、可撤销的 API Key，并保存到该操作系统用户的官方 SDK 凭据目录。Relay 不读取、不返回 Key 值。可用以下命令检查登录状态，不会输出凭据：

```powershell
node --input-type=module --eval 'import { Cursor } from "@cursor/sdk"; console.log((await Cursor.auth.status()).status)'
```

输出 `logged-in` 表示 MCP 进程可以使用 stored login。`CURSOR_API_KEY` 仍可作为自动化场景的可选替代方案，但不要把它写进 `.mcp.json`、命令历史、日志或仓库。使用 stored login 时应完全省略 `CURSOR_API_KEY`，不要传空字符串。

可选环境变量：

| 变量                                     | 默认值                | 说明                                                                                                   |
| ---------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------ |
| `CURSOR_API_KEY`                         | 无                    | 可选环境 Key；未设置时使用官方 stored login                                                            |
| `CURSOR_RELAY_WORKSPACE_ROOTS`           | 空                    | `path.delimiter` 分隔的无人值守允许根目录；为空时仍可使用当前对话的一次性只读授权                      |
| `CURSOR_RELAY_STATE_DIR`                 | `~/.cursor-relay-mcp` | Relay 与 Cursor SDK 持久状态目录                                                                       |
| `CURSOR_RELAY_DEFAULT_TIMEOUT_MS`        | `1800000`             | 默认总运行超时                                                                                         |
| `CURSOR_RELAY_MAX_TIMEOUT_MS`            | `14400000`            | 允许的最大总超时                                                                                       |
| `CURSOR_RELAY_MAX_EVENTS`                | `1000`                | 每个运行保留的最大事件数                                                                               |
| `CURSOR_RELAY_ENABLE_DANGER_FULL_ACCESS` | `false`               | 服务端危险权限总开关；仅接受严格的 `true`/`false`                                                      |
| `CURSOR_RELAY_READ_ONLY_SANDBOX_ENABLED` | 平台自适应            | 只读预设是否启用 SDK 沙箱；Windows 因当前 SDK 不兼容而强制为 `false`，其他平台默认 `true` 且可显式关闭 |
| `CURSOR_RELAY_SETTING_SOURCES`           | `project`             | 逗号分隔的设置层，仅允许 `project`、`team`、`mdm`                                                      |

所有已设置的数字和布尔配置必须合法，否则服务启动失败；不会静默回退。默认超时不能大于最大超时。

## MCP 配置

本仓库本身是 Codex 插件，构建后可从仓库根目录加载。通用 MCP 客户端可以使用绝对路径：

```json
{
  "mcpServers": {
    "cursor-relay-mcp": {
      "command": "node",
      "args": ["D:\\app\\git\\cursor-relay-mcp\\dist\\index.js"],
      "env": {
        "CURSOR_RELAY_WORKSPACE_ROOTS": "D:\\app\\git"
      }
    }
  }
}
```

上述配置默认使用执行 `Cursor.auth.login()` 的同一操作系统用户所保存的官方 stored login，因此不需要在 MCP 配置中放置 Key。只有明确选择环境 Key 方案时，才由启动 MCP 客户端的父进程提供 `CURSOR_API_KEY`。

## 工具合约

| 工具                  | 用途                                                          |
| --------------------- | ------------------------------------------------------------- |
| `doctor`              | 检查认证、状态目录和工作区白名单，不请求模型                  |
| `list_models`         | 发现当前账户可用模型和参数                                    |
| `authorize_workspace` | 为当前对话的精确任务签发五分钟、一次性、只读工作区 capability |
| `start_run`           | 启动模型明确、权限明确且有幂等键的运行                        |
| `reply_run`           | 续接已结束的 Agent 会话                                       |
| `get_run`             | 读取状态并在重启后重连                                        |
| `wait_run`            | 最多等待 30 秒，直到 `terminal=true`                          |
| `cancel_run`          | 取消运行                                                      |
| `list_runs`           | 查看持久运行                                                  |
| `read_events`         | 增量读取有限流事件                                            |

静态白名单内的推荐调用顺序：`doctor` → `list_models` → `start_run` → 重复 `wait_run` → 验证 `assistantText`。静态白名单外，仅当用户在当前对话明确要求 Cursor Relay 使用该工作区时，在 `start_run` 前调用 `authorize_workspace`，并原样复用 workspace、task、idempotencyKey 和返回的 `workspaceApprovalToken`。

一次性 capability 不持久化令牌，只在 MCP 进程内保存其 SHA-256 摘要；五分钟后过期，成功创建一个新运行后立即消费，并绑定规范化真实路径、完整任务文本、幂等键与 MCP task/session（可用时）。运行状态只持久化授权 ID、来源和时间作为审计证据。它只能授予 `read-only`；`workspace-write` 与 `danger-full-access` 仍必须命中静态白名单，危险权限继续执行服务端总开关与请求二次确认。

### 权限预设

- `read-only`（默认）：只开放 `read`、`grep`、`glob`、`ls`，Auto-review 开启。支持的非 Windows 主机默认启用沙箱并可显式关闭；Windows 因当前 Cursor SDK 本地运行时不支持而强制关闭，避免遗留环境变量重新进入不兼容路径。工具白名单始终保持不变。
- `workspace-write`：沙箱和 Auto-review 开启，并禁止删除、子代理、MCP、联网和图片生成能力。
- `danger-full-access`：关闭沙箱和 Auto-review；必须由服务启动环境显式设置 `CURSOR_RELAY_ENABLE_DANGER_FULL_ACCESS=true`，请求还必须传 `confirmedDangerousPermission=true`。默认关闭。

Relay 默认只把 `project` 作为 Cursor 设置来源。可显式加入 `team`、`mdm`；拒绝 `user`、`plugins`、`all`，以降低环境漂移、嵌套 MCP 和递归委派风险。

`get_run`、`list_runs` 和等待结果返回不含事件正文的摘要，并提供 `eventCount`；事件只能通过 `read_events` 分页读取。序列化后的单事件数据超过 8 KiB 时会替换成含 `truncated=true`、原始字节数和有限预览的元数据。递归脱敏只识别敏感字段名，不是通用密钥扫描器，因此状态目录应保持私有，任务提示中也不应包含密钥。

本项目只使用锁定 SDK 包根公开导出，包括模型发现、`Agent.create` / `resume` / `listRuns` / `getRun`、`Run.stream` / `wait` / `cancel` 和官方认证状态；不读取 Cursor IDE 会话、数据库或内部 token，也不调用私有端点。本地 SDK Agent 循环运行在 Node.js 进程中，正常使用不需要重启 Cursor IDE。

## 开发与兼容检查

```powershell
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm run test:mcp
npm run check:package
npm run test:sdk-contract
```

测试默认不访问真实 Cursor API，也不会修改真实工作区。真实账户兼容测试必须由操作者显式提供凭据和专用测试目录。

## 已知边界

- 当前版本仅封装 Cursor SDK 的本地 Agent 运行，不创建 Cursor Cloud Agent 或 PR。
- Relay 状态文件适合单服务进程；多进程同时写同一状态目录不在支持范围内。
- SDK 是 public beta；模型目录和运行事件形状由当前账户和 SDK 版本决定。模型别名会规范化为目录中的 canonical ID，参数组合必须属于官方目录列出的值/variant。
