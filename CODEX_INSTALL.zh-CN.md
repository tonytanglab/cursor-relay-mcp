# Codex Windows 快速安装与避坑手册

本文用于在一台新的 Windows 电脑上，把 `cursor-relay-mcp` 安装为 Codex 个人插件，并完成一次真实 Cursor 模型调用。内容基于 2026-08-26 的本机实测；Codex 内部 CLI 路径可能随桌面版升级变化，因此优先使用系统可执行的 `codex` 命令，只在它被 WindowsApps 拒绝时使用文中的备用路径。

## 最短结论

推荐把仓库直接克隆到：

```text
%USERPROFILE%\plugins\cursor-relay-mcp
```

个人 marketplace 清单位于：

```text
%USERPROFILE%\.agents\plugins\marketplace.json
```

但清单中的 `./plugins/cursor-relay-mcp` 不是相对 `marketplace.json` 所在目录解析，而是对应：

```text
%USERPROFILE%\plugins\cursor-relay-mcp
```

不要把插件仓库克隆到 `%USERPROFILE%\.agents\plugins\cursor-relay-mcp`。那不是 Codex `plugin list` 显示的插件源路径，会造成“清单存在但版本为空、插件未安装”的假象。

## 交给 Codex 一次完成

在新电脑的 Codex 中打开一个 PowerShell 工作区，把下面这段提示词完整交给 Codex：

```text
请从 https://github.com/tonytanglab/cursor-relay-mcp 安装 cursor-relay-mcp。

要求：
1. 先阅读仓库根目录 AGENTS.md 与 AI-CDL Spec.md。
2. 仓库必须位于 %USERPROFILE%\plugins\cursor-relay-mcp；不要放到 .agents\plugins 下。
3. 使用 Node.js >=22.13，执行 npm ci、npm run build 和项目规定的验证。
4. 使用 Cursor.auth.login() 完成当前 Windows 用户的 stored login，不读取或输出 API Key。
5. 使用 Codex 的 plugin-creator 规范注册到默认 personal marketplace，不手改 marketplace.json；确认 source.path 为 ./plugins/cursor-relay-mcp。
6. 如果 WindowsApps 中的 codex.exe 拒绝访问，检查并使用 %USERPROFILE%\.codex\plugins\.plugin-appserver\codex.exe。
7. 执行 codex plugin add cursor-relay-mcp@personal，并确认 plugin list 显示 installed, enabled。
8. 调用 doctor 和 list_models。Windows 强制关闭当前 SDK 不支持的 local sandbox，即使遗留环境变量为 true 也会钳制为 false，但始终保留 Relay 的权限预设与工具限制；其他平台只有在 SDK 明确报告不支持时才显式关闭对应的 read-only 或 workspace-write sandbox。
9. 新建任务后，按 doctor → list_models → authorize_workspace（如需要）→ start_run → 重复 wait_run 的顺序，用账户实际返回的 grok-4.6 canonical ID 完成一次只读测试。
10. 核对插件 manifest 使用 "mcpServers": "./.mcp.json"，且内置 .mcp.json 以 cwd "." 启动 node ./dist/index.js；不要把开发机绝对路径或 Codex 版本缓存路径写进去，也不要在用户 config.toml 重复注册同名 MCP。
11. 不写入 CURSOR_API_KEY，不提交 node_modules、dist、状态文件或本地凭据。
```

## 一、安装前检查

需要：

- Windows 10/11 与 PowerShell 7。
- Git。
- Node.js `>=22.13`。
- 已安装 Codex 桌面版。
- 可登录的 Cursor 账户。
- Python 3 仅用于 Codex `plugin-creator` 的 marketplace 辅助脚本；由 Codex 自动执行时可使用其 bundled Python。

在 PowerShell 中检查：

```powershell
git --version
node --version
npm --version
Get-Command codex -All
```

如果 Node.js 低于 `22.13`，先升级 Node.js。不要在旧版本上继续，因为构建和 Cursor SDK 行为没有保证。

所有脚本、JSON 和 Markdown 必须使用 UTF-8 无 BOM。PowerShell 读取文件时显式使用 `-Encoding UTF8`；Python 辅助脚本使用 `-X utf8`；Node.js 文件 API 显式传入 `utf8`。

## 二、克隆或更新正确的插件源

新安装：

```powershell
$PluginSource = Join-Path $env:USERPROFILE 'plugins\cursor-relay-mcp'
git clone https://github.com/tonytanglab/cursor-relay-mcp $PluginSource
Set-Location -LiteralPath $PluginSource
git status --short --branch
```

已有仓库时，不要直接覆盖本地改动：

```powershell
$PluginSource = Join-Path $env:USERPROFILE 'plugins\cursor-relay-mcp'
git -C $PluginSource status --short --branch
git -C $PluginSource fetch origin --prune
git -C $PluginSource pull --ff-only
```

如果 `git status` 显示未提交改动，先确认其来源；不要使用 `git reset --hard` 或强制覆盖。

若希望把开发仓库保留在其他磁盘，可以在 `%USERPROFILE%\plugins\cursor-relay-mcp` 建立指向开发仓库的目录联接。必须先确认目标目录不存在：

```powershell
$PluginSource = Join-Path $env:USERPROFILE 'plugins\cursor-relay-mcp'
New-Item -ItemType Junction -Path $PluginSource -Target 'D:\AI\cursor-relay-mcp'
```

直接克隆到 `%USERPROFILE%\plugins` 最简单，也最不容易产生重复副本。

## 三、安装依赖并构建

```powershell
Set-Location -LiteralPath $PluginSource
npm ci
npm run build
```

使用 `npm ci`，让安装严格遵循 `package-lock.json`。首次部署至少执行：

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

`npm audit` 发现漏洞不等于构建失败，但必须记录并评估；不要为了消除提示而擅自升级锁定的 `@cursor/sdk`。

## 四、完成 Cursor stored login

在插件仓库根目录执行：

```powershell
node --input-type=module --eval 'import { Cursor } from "@cursor/sdk"; await Cursor.auth.login({ apiKeyName: "cursor-relay-mcp" })'
```

浏览器会打开 Cursor 官方授权页。授权完成后检查状态：

```powershell
node --input-type=module --eval 'import { Cursor } from "@cursor/sdk"; console.log((await Cursor.auth.status()).status)'
```

必须看到：

```text
logged-in
```

注意：

- 登录必须由将来启动 Codex/MCP 的同一个 Windows 用户完成。
- Relay 不读取、不返回 stored login 中的 Key。
- 不要把 `CURSOR_API_KEY` 写入 `.mcp.json`、仓库、命令历史或日志。
- 使用 stored login 时完全省略 `CURSOR_API_KEY`；不要设置为空字符串。

## 五、注册 personal marketplace

默认个人 marketplace 文件是：

```text
%USERPROFILE%\.agents\plugins\marketplace.json
```

推荐让 Codex 使用系统 `plugin-creator` 完成注册，不要手工编辑 `marketplace.json`。新条目应满足：

```json
{
  "name": "cursor-relay-mcp",
  "source": {
    "source": "local",
    "path": "./plugins/cursor-relay-mcp"
  },
  "policy": {
    "installation": "AVAILABLE",
    "authentication": "ON_INSTALL"
  },
  "category": "Developer Tools"
}
```

这是用于核对的期望形状，不建议手改。注册后运行 `codex plugin list`，它必须把该条目解析为：

```text
%USERPROFILE%\plugins\cursor-relay-mcp
```

如果解析成其他路径，先修正插件源和 marketplace 关系，不要继续安装。

默认 personal marketplace 会被 Codex 隐式发现，不需要执行 `codex plugin marketplace add`。该命令只用于显式的非默认 marketplace。

## 六、找到可执行的 Codex CLI

优先尝试：

```powershell
codex --version
codex plugin list
```

某些 Codex 桌面版会让 `Get-Command codex` 指向 WindowsApps 内部文件，但终端启动时报“拒绝访问”。这时检查备用 CLI：

```powershell
$CodexCli = Join-Path $env:USERPROFILE '.codex\plugins\.plugin-appserver\codex.exe'
Test-Path -LiteralPath $CodexCli
& $CodexCli --version
& $CodexCli plugin list
```

如果备用路径不存在，先更新或重启 Codex 桌面版，再让 Codex 检查当前版本实际提供的插件 CLI；不要复制 WindowsApps 中受保护的可执行文件，也不要通过 UI 自动化绕过权限。

## 七、正式安装插件

系统 `codex` 可执行时：

```powershell
codex plugin add 'cursor-relay-mcp@personal'
codex plugin list
```

使用备用 CLI 时：

```powershell
& $CodexCli plugin add 'cursor-relay-mcp@personal'
& $CodexCli plugin list
```

成功标准：

```text
cursor-relay-mcp@personal    installed, enabled
```

安装缓存通常位于：

```text
%USERPROFILE%\.codex\plugins\cache\personal\cursor-relay-mcp\<version>
```

不要把“marketplace 中可见”误认为“已安装”。必须同时确认 `installed, enabled` 和缓存目录存在。

### Codex 内置 MCP 生成模板

生成或复核 Codex 插件时，`.codex-plugin/plugin.json` 必须引用包内 MCP 声明：

```json
{
  "skills": "./skills/",
  "mcpServers": "./.mcp.json"
}
```

仓库根目录 `.mcp.json` 的入口必须保持为插件相对路径：

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

Codex 会把 `cwd: "."` 解析为已安装版本的插件根目录。不要写开发仓库绝对路径，不要写 `%USERPROFILE%\.codex\plugins\cache\personal\cursor-relay-mcp\<version>`，也不要在用户 `config.toml` 再注册同名 MCP；这些做法会造成升级后入口失效或双进程争用状态文件。内置 MCP 使用当前 Windows 用户的 Cursor stored login，`.mcp.json` 不应包含 `CURSOR_API_KEY`。

插件生效后的语义也必须写进生成提示词：Codex 只传 workspace、任务、模型、权限、幂等键和必要的对话授权 token，Cursor Agent 在授权工作区内自行读取或修改源码。明确审核请求使用 `read-only`；明确修改、修复、实现或重构请求使用 `workspace-write`，不能静默降级成分析。写任务提示应要求 Cursor 直接实施、执行相称验证，并报告每个修改文件及用途；Codex 通过 `wait_run`、`read_events` 和本地变更清单了解进度，不向 Cursor 复制源码。白名单外工作区由 `authorize_workspace` 签发绑定当前对话和精确工作区的可复用 capability，同一对话内多次修改无需重复授权。

## 八、处理本机不支持 SDK sandbox

插件采用平台兼容的安全保护：Windows 强制关闭当前 SDK 不支持的 local sandbox，其他平台默认开启。两种情况下 Relay 的 `read-only` 预设都只开放 `read`、`grep`、`glob` 和 `ls`，`workspace-write` 仍禁止删除、子代理、MCP、联网和图片生成工具。插件升级或重装后必须新建 Codex 任务，因为已存在任务绑定的 MCP 子进程不会热加载新构建；在新任务调用 `doctor`，确认 `readOnlySandboxEnabled`、`workspaceWriteSandboxEnabled` 与平台预期一致。

若非 Windows 主机出现类似错误，再显式启用兼容开关：

```text
Local SDK sandboxing was requested, but sandboxing is not supported in this environment.
```

为启动 Codex 的当前用户设置：

```powershell
[Environment]::SetEnvironmentVariable(
  'CURSOR_RELAY_READ_ONLY_SANDBOX_ENABLED',
  'false',
  'User'
)
[Environment]::SetEnvironmentVariable(
  'CURSOR_RELAY_WORKSPACE_WRITE_SANDBOX_ENABLED',
  'false',
  'User'
)
```

然后完全退出并重新打开 Codex。仅新进程会继承用户环境变量。

这些开关只关闭 Cursor SDK 的本地 sandbox；Relay 的 `read-only` 预设仍只允许 `read`、`grep`、`glob` 和 `ls`，`workspace-write` 仍应用禁止工具列表。不要因为 sandbox 失败就启用 `danger-full-access`。

如果本机支持 SDK sandbox，保留非 Windows 默认值 `true` 更安全。撤销显式覆盖：

```powershell
[Environment]::SetEnvironmentVariable(
  'CURSOR_RELAY_READ_ONLY_SANDBOX_ENABLED',
  $null,
  'User'
)
[Environment]::SetEnvironmentVariable(
  'CURSOR_RELAY_WORKSPACE_WRITE_SANDBOX_ENABLED',
  $null,
  'User'
)
```

## 九、新任务中完成 Grok 4.6 冒烟测试

插件安装或重装后必须新建 Codex 任务。旧任务不会动态获得新插件的 skills 和 MCP 工具。

在新任务中输入：

```text
使用 Cursor Relay 做一次只读冒烟测试：
1. 调用 doctor；
2. 调用 list_models，确认账户实际返回的 Grok 4.6 canonical ID；
3. 对当前工作区签发当前对话可复用的 read-only 授权（如工作区不在静态白名单）；
4. 使用 Grok 4.6 读取 package.json，只回复 package name 和锁定的 @cursor/sdk 版本；
5. 重复调用 wait_run，直到 terminal=true；
6. 返回 effectiveModel.id、status 和 assistantText，禁止修改任何文件。
```

模型目录来自当前 Cursor 账户，可能变化。必须先调用 `list_models`，不要仅凭文档硬编码模型 ID。2026-08-26 的实测 canonical ID 是 `grok-4.6`，默认有效参数组合包括：

```json
{
  "id": "grok-4.6",
  "params": [
    { "id": "effort", "value": "high" },
    { "id": "fast", "value": "true" }
  ]
}
```

成功标准：

- `doctor.data.ok=true`。
- `doctor.data.authentication=stored-login`。
- `start_run` 返回 `relayRunId`。
- `wait_run` 最终返回 `terminal=true`、`status=succeeded`。
- `effectiveModel.id=grok-4.6`。
- `assistantText` 与只读任务相符。
- 运行前后 `git status --short` 没有新增改动。

若要做持久层故障复测，不要复用已有的大体量用户状态。先完全退出 Codex，再给测试进程设置一个位于本地 NTFS、且不在 OneDrive/Dropbox 等同步目录内的独立 `CURSOR_RELAY_STATE_DIR`。正式日常使用可以保留默认目录；独立目录的目的，是让复测结论不受旧运行、孤儿临时文件或其他 MCP 进程干扰。

## 十、调用链关键约束

推荐顺序：

```text
doctor → list_models → authorize_workspace（按需）→ start_run → wait_run（循环）
```

避坑：

- `authorize_workspace` 的 token 绑定当前 MCP task/session 与规范化工作区，可在本对话的多次运行中复用，作用域或 MCP 进程结束后失效。
- `workspace-write` capability 同时允许读写与只读运行；`read-only` capability 不能提升为写入。
- 每次 `start_run` / `reply_run` 仍需使用具体任务和独立幂等键；Codex 不复制源码，只跟踪事件和变更文件清单。
- `wait_run` 最多等待 30 秒；当 `mustCallAgain=true` 时必须继续调用，不能把一次超时当成运行失败。
- 重试同一个逻辑请求必须复用原 `idempotencyKey`；不同任务必须使用新键。
- 不要把授权 token 或任何密钥写入日志、状态说明或仓库。

## 十一、升级与重新安装

先检查工作树，再拉取：

```powershell
git -C $PluginSource status --short --branch
git -C $PluginSource fetch origin --prune
git -C $PluginSource pull --ff-only
Set-Location -LiteralPath $PluginSource
npm ci
npm run build
```

Codex 本地插件按 manifest version 缓存。同版本内容变化时，单纯再次执行 `plugin add` 可能继续使用旧缓存。应让 Codex 使用 `plugin-creator` 的更新流程：

1. 用 `read_marketplace_name.py` 验证 marketplace 名称。
2. 用 `update_plugin_cachebuster.py` 为 `.codex-plugin/plugin.json` 生成单个 `+codex.local-...` 后缀。
3. 执行 `codex plugin add cursor-relay-mcp@personal`。
4. 确认新的版本缓存目录存在。
5. 新建 Codex 任务测试。

cachebuster 是本地重装标识，不应叠加多个后缀，也不应为了刷新缓存随意递增正式版本。不要手改 `marketplace.json` 或 Codex `config.toml` 来绕过缓存。

## 十二、故障速查

| 现象                                                  | 原因                                                                                  | 处理                                                            |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `plugin list` 显示版本为空                            | marketplace 条目存在，但 `%USERPROFILE%\plugins\cursor-relay-mcp` 不存在或无 manifest | 把仓库放到正确路径，或建立目录联接                              |
| 误把仓库放进 `.agents\plugins`                        | 混淆 marketplace 清单目录与插件源目录                                                 | 移到 `%USERPROFILE%\plugins`；清理重复副本前先核验路径          |
| `codex.exe` 拒绝访问                                  | 命中 WindowsApps 受保护的桌面版内部路径                                               | 使用 `.codex\plugins\.plugin-appserver\codex.exe`，或更新 Codex |
| `logged-out`                                          | 当前 Windows 用户没有 Cursor stored login                                             | 在插件目录执行 `Cursor.auth.login()`                            |
| `CURSOR_CONFIGURATION_ERROR` 提到 sandbox unsupported | 旧版插件仍在 Windows 强制启用 sandbox，或非 Windows 主机不支持                        | 更新并重装插件；非 Windows 仅为只读模式设置兼容环境变量         |
| 安装后当前任务没有工具                                | 插件工具只在任务创建时加载                                                            | 新建 Codex 任务                                                 |
| 再次安装仍运行旧内容                                  | manifest version 未变化，命中旧缓存                                                   | 使用单一 cachebuster 后缀重装                                   |
| `WORKSPACE_APPROVAL_REQUIRED`                         | 工作区不在静态白名单且当前对话尚未签发 capability                                     | 当前对话明确授权后调用 `authorize_workspace`                    |
| `WORKSPACE_APPROVAL_MISMATCH`                         | 工作区、权限上限或 MCP 对话 scope 不一致                                              | 使用本对话为该精确工作区签发的匹配 token                        |
| `wait_run` 返回 `terminal=false`                      | 运行尚未结束，不是失败                                                                | 按 `mustCallAgain` 继续轮询                                     |
| stored login 存在但仍认证失败                         | MCP 由不同 Windows 用户启动，或传了空 `CURSOR_API_KEY`                                | 使用同一用户并完全省略空 Key                                    |
| `STATE_UPDATE_FAILED` 且系统码为 `EPERM/EACCES/EBUSY` | 旧版 Relay 单次原子替换失败，或目标状态文件被同步软件、杀毒软件等长时间占用           | 更新并重装插件；把状态目录放在本地非同步磁盘，再新建 Codex 任务 |
| 状态目录遗留多个 `relay-state.json.*.tmp`             | 旧版进程在写完临时快照后未能替换目标，或在替换窗口退出                                | 先退出全部 Codex/Relay 进程，再把孤儿文件移动到备份目录         |

Windows 状态持久层避坑：

- 新版会让跨进程锁覆盖完整的 `read → mutate → atomic rename` 事务，不能只锁最后一次 `rename`，否则仍可能出现后写覆盖先写。
- 对 `EPERM`、`EACCES`、`EBUSY` 的重试是有界的；持续占用最终会返回结构化、可重试错误，不会无限等待。
- 不要手动删除仍在使用的 `relay-state.json.lock`。持锁 PID 已退出时，新版会安全回收陈旧锁；PID 仍存活时会保守超时，避免误删活锁。
- 不要用“先删除 `relay-state.json` 再重命名”或直接覆盖写来规避 Windows 锁；前者制造文件缺失窗口，后者可能在崩溃时留下半截 JSON。
- 排障时只检查状态文件大小、时间、PID 和错误码即可，不要把状态正文或 Cursor 凭据粘贴进提示词和日志。

## 三分钟验收清单

- [ ] 仓库在 `%USERPROFILE%\plugins\cursor-relay-mcp`。
- [ ] `node --version` 满足 `>=22.13`。
- [ ] `npm ci` 与 `npm run build` 成功。
- [ ] Cursor auth 状态为 `logged-in`。
- [ ] personal marketplace 将 `./plugins/cursor-relay-mcp` 解析到正确路径。
- [ ] `plugin list` 显示 `installed, enabled`。
- [ ] 如本机不支持 SDK sandbox，已设置兼容变量并重启 Codex。
- [ ] 已在新任务运行 `doctor` 与 `list_models`。
- [ ] Grok 4.6 测试最终 `status=succeeded`。
- [ ] 测试前后工作树无新增改动。
