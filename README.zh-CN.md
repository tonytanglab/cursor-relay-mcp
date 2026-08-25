# cursor-relay-mcp

基于官方 `@cursor/sdk` 的本地 MCP 服务，让 Codex、Claude Code 或其他 MCP 客户端把一个明确子任务交给指定 Cursor 模型，同时保留可恢复的运行状态。

> `@cursor/sdk` 仍为 public beta。本项目把它精确锁定为 `1.0.28`，并提供 SDK 导出契约测试；升级前请先修改版本并运行完整兼容测试。

## 能力

- 通过 Cursor 账户实时发现模型、别名和可选参数，不维护易过期的静态模型表。
- 幂等 `start_run` / `reply_run`，相同键和相同请求返回原运行；不同请求返回结构化冲突。
- Relay 状态采用原子 UTF-8 JSON，Cursor SDK 状态采用官方 `JsonlLocalAgentStore`；进程重启后可通过 `Agent.getRun` 重连。
- `wait_run` 每次最多等待 30 秒，未结束时明确返回 `mustCallAgain=true`。
- 总运行超时、取消、有限事件缓冲、敏感字段脱敏以及统一结构化错误。
- 安全默认值：无工作区白名单时拒绝运行、默认只读、Cursor 沙箱启用、只加载项目设置。

## 要求与安装

- Node.js `>=22.13`
- Cursor API Key

```powershell
npm install
npm run build
$env:CURSOR_API_KEY = "..."
$env:CURSOR_RELAY_WORKSPACE_ROOTS = "D:\app\git"
node .\dist\index.js
```

不要把 API Key 写进 `.mcp.json` 或仓库。服务只从进程环境读取它，也不会持久化它。

可选环境变量：

| 变量                              | 默认值                | 说明                                                    |
| --------------------------------- | --------------------- | ------------------------------------------------------- |
| `CURSOR_API_KEY`                  | 无                    | 必需的 Cursor API Key                                   |
| `CURSOR_RELAY_WORKSPACE_ROOTS`    | 空                    | `path.delimiter` 分隔的允许根目录；为空时拒绝所有工作区 |
| `CURSOR_RELAY_STATE_DIR`          | `~/.cursor-relay-mcp` | Relay 与 Cursor SDK 持久状态目录                        |
| `CURSOR_RELAY_DEFAULT_TIMEOUT_MS` | `1800000`             | 默认总运行超时                                          |
| `CURSOR_RELAY_MAX_TIMEOUT_MS`     | `14400000`            | 允许的最大总超时                                        |
| `CURSOR_RELAY_MAX_EVENTS`         | `1000`                | 每个运行保留的最大事件数                                |

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

让启动 MCP 客户端的父进程提供 `CURSOR_API_KEY`，不要把它放入可提交配置。

## 工具合约

| 工具          | 用途                                         |
| ------------- | -------------------------------------------- |
| `doctor`      | 检查认证、状态目录和工作区白名单，不请求模型 |
| `list_models` | 发现当前账户可用模型和参数                   |
| `start_run`   | 启动模型明确、权限明确且有幂等键的运行       |
| `reply_run`   | 续接已结束的 Agent 会话                      |
| `get_run`     | 读取状态并在重启后重连                       |
| `wait_run`    | 最多等待 30 秒，直到 `terminal=true`         |
| `cancel_run`  | 取消运行                                     |
| `list_runs`   | 查看持久运行                                 |
| `read_events` | 增量读取有限流事件                           |

推荐调用顺序：`doctor` → `list_models` → `start_run` → 重复 `wait_run` → 验证 `assistantText`。

### 权限预设

- `read-only`（默认）：只开放 `read`、`grep`、`glob`、`ls`，沙箱和 Auto-review 开启。
- `workspace-write`：沙箱和 Auto-review 开启，并禁止删除、子代理、MCP、联网和图片生成能力。
- `danger-full-access`：关闭沙箱和 Auto-review；必须同时传 `confirmedDangerousPermission=true`。

Relay 只把 `project` 作为 Cursor 设置来源，不加载用户设置、团队设置或 Cursor 插件，以降低嵌套 MCP 和递归委派风险。

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
- SDK 是 public beta；模型目录和运行事件形状由当前账户和 SDK 版本决定。
