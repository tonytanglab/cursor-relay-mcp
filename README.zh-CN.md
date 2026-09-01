# cursor-relay-mcp

基于官方 `@cursor/sdk` 的本地 MCP 服务，让 Codex、Claude Code 或其他 MCP 客户端把一个明确子任务交给指定 Cursor 模型，同时保留可恢复的运行状态。

> `@cursor/sdk` 仍为 public beta。本项目把它精确锁定为 `1.0.30`，并提供 SDK 导出契约测试；升级前请先修改版本并运行完整兼容测试。

## 能力

- 通过 Cursor 账户实时发现模型、别名和可选参数，不维护易过期的静态模型表。
- 幂等 `start_run` / `reply_run`，相同键和相同请求返回原运行；不同请求返回结构化冲突。
- Relay 状态采用原子 UTF-8 JSON，Cursor SDK 状态采用官方 `JsonlLocalAgentStore`；进程重启后可通过 `Agent.getRun` 重连。
- `wait_run` 每次最多等待 30 秒，未结束时明确返回 `mustCallAgain=true`。
- `start_run` / `reply_run` 自动附带只读实时面板；也可用 `view_run` 打开既有运行，查看状态、事件时间线和最终输出。
- 总运行超时、取消、有限事件缓冲、8 KiB 单事件上限、敏感字段名脱敏以及统一结构化错误。
- 安全默认值：无人值守运行必须命中静态工作区白名单；当前对话明确授权时可为精确工作区签发对话级、可复用的只读或读写 capability；默认只读并只加载项目设置；支持的非 Windows 主机默认启用 Cursor 沙箱，Windows 因当前 SDK 本地运行时不支持而关闭沙箱，但仍强制权限预设和工具限制。
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

| 变量                                           | 默认值                | 说明                                                                                                   |
| ---------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------ |
| `CURSOR_API_KEY`                               | 无                    | 可选环境 Key；未设置时使用官方 stored login                                                            |
| `CURSOR_RELAY_WORKSPACE_ROOTS`                 | 空                    | `path.delimiter` 分隔的无人值守允许根目录；为空时仍可使用当前对话的精确工作区读写授权                  |
| `CURSOR_RELAY_STATE_DIR`                       | `~/.cursor-relay-mcp` | Relay 与 Cursor SDK 持久状态目录                                                                       |
| `CURSOR_RELAY_DEFAULT_TIMEOUT_MS`              | `86400000`            | 默认总运行超时（24 小时）                                                                              |
| `CURSOR_RELAY_MAX_TIMEOUT_MS`                  | `86400000`            | 允许的最大总超时；可配置得更短，但硬上限为 24 小时                                                     |
| `CURSOR_RELAY_MAX_EVENTS`                      | `1000`                | 每个运行保留的最大事件数                                                                               |
| `CURSOR_RELAY_ENABLE_DANGER_FULL_ACCESS`       | `false`               | 服务端危险权限总开关；仅接受严格的 `true`/`false`                                                      |
| `CURSOR_RELAY_READ_ONLY_SANDBOX_ENABLED`       | 平台自适应            | 只读预设是否启用 SDK 沙箱；Windows 因当前 SDK 不兼容而强制为 `false`，其他平台默认 `true` 且可显式关闭 |
| `CURSOR_RELAY_WORKSPACE_WRITE_SANDBOX_ENABLED` | 平台自适应            | 读写预设是否启用 SDK 沙箱；Windows 因当前 SDK 不兼容而强制为 `false`，其他平台默认 `true` 且可显式关闭 |
| `CURSOR_RELAY_SETTING_SOURCES`                 | `project`             | 逗号分隔的设置层，仅允许 `project`、`team`、`mdm`                                                      |

所有已设置的数字和布尔配置必须合法，否则服务启动失败；不会静默回退。默认超时不能大于最大超时，最大超时不能超过 24 小时。

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

### Codex 插件的内置 MCP 必须这样写

Codex 插件不是把 MCP 配置复制进用户 `config.toml`。插件 manifest 只引用随包分发的 `.mcp.json`：

```json
{
  "skills": "./skills/",
  "mcpServers": "./.mcp.json"
}
```

仓库根目录的 `.mcp.json` 使用插件内相对路径：

```json
{
  "mcpServers": {
    "cursor-relay-mcp": {
      "command": "node",
      "args": ["./dist/index.js"],
      "cwd": "."
    }
  }
}
```

`cwd: "."` 由 Codex 解析为已安装插件的版本缓存根目录，因此这里不能写开发机的绝对仓库路径，也不能写 `%USERPROFILE%\.codex\plugins\cache\...` 这种会随版本变化的缓存路径。不要再给 Codex 手工添加第二份同名 MCP 配置，否则可能同时启动两个 Relay 进程并读写同一状态目录。不要把 `CURSOR_API_KEY` 写进 `.mcp.json`；内置 MCP 使用启动 Codex 的同一操作系统用户的 Cursor stored login。

安装或重装后必须新建 Codex 任务。Codex 会从 manifest 加载 Skill，并从 `.mcp.json` 启动 MCP；界面里的工具名可能带规范化前缀，逻辑工具包括 `doctor`、`list_models`、`reauthenticate_cursor`、`authorize_workspace`、`start_run`、`reply_run`、`view_run` 和 `wait_run`。`start_run` / `reply_run` 会附带进度卡片，也可随时调用 `view_run` 重开。正确链路是：

本插件的 Codex Skill 已作为原始包内容内置在 `skills/delegate-to-cursor-agent/SKILL.md`。manifest 通过 `"skills": "./skills/"` 声明它，`package.json` 也把整个 `skills/` 纳入发布文件。因此安装或重装插件后，Codex 会在新建任务中自动加载该 Skill，不需要、也不应在安装时动态生成另一份副本。

```text
用户点名 Cursor/模型和工作区
  → Codex 调用内置 MCP（只传 workspace、targetLocations、任务范围、模型、权限和幂等键）
  → Cursor Agent 在该工作区内自行读取或修改
  → Codex 循环 wait_run、增量读取 read_events、跟踪变更文件并核验结果
```

`task` 只描述审查/实现范围与验收要求，`targetLocations` 只列工作区内文件、目录或行号位置。无论 `read-only` 还是 `workspace-write`，都禁止把源码正文、代码块、文件内容或 diff 放进任何 MCP 参数；Relay 会拒绝违规请求，并让 Cursor 在获授权工作区自行读取。续接运行省略 `targetLocations` 时继承父运行的位置。

用户明确要求 Cursor 审查当前或指定工作区，表示允许 Cursor 在该范围内自行读取；用户明确说“让 Cursor 修改/修复/实现”时，表示允许 Cursor 在该精确工作区内自行读写，应选择 `workspace-write`，不能擅自降成只读分析。白名单外由 `authorize_workspace` 签发当前对话可复用的 capability；授权只绑定工作区与权限上限，不会放宽“仅位置与范围”的任务契约。

## 工具合约

| 工具                    | 用途                                                    |
| ----------------------- | ------------------------------------------------------- |
| `doctor`                | 检查认证、状态目录和工作区白名单，不请求模型            |
| `list_models`           | 发现当前账户可用模型和参数                              |
| `reauthenticate_cursor` | 浏览器重新登录并替换 SDK stored login，不返回 API key   |
| `authorize_workspace`   | 为当前对话和精确工作区签发可复用的只读或读写 capability |
| `start_run`             | 仅用目标位置、任务范围、明确权限和幂等键启动运行        |
| `reply_run`             | 仅用目标位置与任务范围续接已结束的 Agent 会话           |
| `get_run`               | 读取状态并在重启后重连                                  |
| `view_run`              | 打开只读实时面板查看既有运行                            |
| `wait_run`              | 最多等待 30 秒，直到 `terminal=true`                    |
| `cancel_run`            | 取消运行                                                |
| `list_runs`             | 查看持久运行                                            |
| `read_events`           | 增量读取有限流事件                                      |

静态白名单内的推荐调用顺序：`doctor` → `list_models` → `start_run` → 重复 `wait_run` → 验证 `assistantText`。静态白名单外，仅当用户在当前对话明确要求 Cursor Relay 使用该工作区时调用一次 `authorize_workspace`，后续在同一对话、同一工作区的多次 `start_run` / `reply_run` 中复用返回的 `workspaceApprovalToken`；每个新运行仍使用独立任务文本和幂等键。

### 实时面板与运行中纠偏边界

`start_run` 与 `reply_run` 返回结果会绑定同一个 MCP Apps 只读面板；`view_run` 可按 `relayRunId` 再次打开。面板只调用 `wait_run` 和 `read_events`，展示真实 Relay 状态、模型、权限、耗时、Cursor SDK 增量事件、token 使用量、错误和最终输出，不会授权、启动、续接或取消运行。不支持 MCP Apps 的宿主仍可使用原有结构化工具结果。

`doctor` 会返回实际生效的 `defaultTimeoutMs` 与 `maxTimeoutMs`。普通仓库任务必须省略 `timeoutMs`，使用默认 24 小时总预算；只有用户或任务确实要求更短预算时才显式传入，任何运行都不能超过 24 小时硬上限。单次 `wait_run` 超时只是轮询切片；可重试的 SDK 重连异常会返回 `connection.state=reconnecting` 并保持运行非终态。只要运行状态与事件持续正常推进，就应在总预算内继续等待，不应因已等待 10 分钟、2 小时或 4 小时而取消或拆成多个短续接运行；真正达到 24 小时总预算才是执行超时，不代表任务推理在语义上失败。

锁定的公开 Cursor SDK 当前没有向正在执行的本地 Agent run 注入新指令的操作；`doctor.capabilities.activeRunSteering` 因此明确为 `false`。Relay 不会把内部事件追加伪装成“纠偏指令已送达”。调用方也不应仅为调整方向就取消活动运行：应继续观察至终态，再用 `reply_run` 续接；只有用户明确要求停止，或继续执行将跨越具体安全边界时才取消。

Cursor SDK stored login 与 Cursor 桌面端登录彼此独立。若 `doctor.authentication=stored-login` 但 `list_models` 返回 `CURSOR_ACCOUNT_PLAN_REQUIRED`，先核对 `doctor.authenticationEmail`；只有用户明确同意替换 SDK 登录时才调用 `reauthenticate_cursor`（参数 `confirmed=true`），完成后必须重新运行 `doctor` 与 `list_models`。重新登录成功本身不等于套餐权限已经验证。

对话级 capability 不持久化令牌，只在 MCP 进程内保存其 SHA-256 摘要，并绑定规范化真实路径、权限上限与 MCP task/session（可用时）；作用域或进程结束后立即失效。运行状态只持久化授权 ID、来源和时间作为审计证据。`workspace-write` capability 可用于同一工作区的读写或只读运行，只读 capability 不能提权；`danger-full-access` 仍必须命中静态白名单，并继续执行服务端总开关与请求二次确认。

### 权限预设

- `read-only`（默认）：开放 `read`、`grep`、`glob`、`ls`、`webSearch` 和 `webFetch`，由 Cursor 自行判断是否需要联网；Auto-review 开启。支持的非 Windows 主机默认启用沙箱并可显式关闭；Windows 因当前 Cursor SDK 本地运行时不支持而强制关闭，避免遗留环境变量重新进入不兼容路径。
- `workspace-write`：Auto-review 开启，并默认禁止 `delete`、`task`、`mcp` 和 `generateImage`；`webSearch`、`webFetch` 正常可用，由 Cursor 自行判断是否需要。支持的非 Windows 主机默认启用沙箱，Windows 因当前 SDK 不兼容而关闭沙箱。
- `danger-full-access`：关闭沙箱和 Auto-review；必须由服务启动环境显式设置 `CURSOR_RELAY_ENABLE_DANGER_FULL_ACCESS=true`，请求还必须传 `confirmedDangerousPermission=true`。默认关闭。

`delete`、`task`、`mcp` 和 `generateImage` 不是绝对禁用项，而是由 Codex 主进程在启动或续接前通过 `codexAllowedTools` 选择性放行，Cursor 无法自行提权。`reply_run` 省略该字段时继承父运行，传 `[]` 可撤销；`read-only` 只兼容额外放行 `generateImage`，其余受控工具要求 `workspace-write`。用户请求已明确涵盖的普通、可回滚操作无需再次询问；仅当操作具有实质破坏性、范围广、不可逆、明显外部副作用、超出既有授权，或需要 `danger-full-access` 时转人工确认。

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
