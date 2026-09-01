# cursor-relay-mcp

A local MCP server built on the official `@cursor/sdk`. It lets MCP clients delegate a bounded task to an explicitly selected Cursor model while keeping durable, restart-safe run state.

`@cursor/sdk` is public beta. This package pins exactly `1.0.28` and includes an SDK export contract test. See [README.zh-CN.md](./README.zh-CN.md) for the full guide.

For a tested Codex Desktop installation workflow on Windows, including personal marketplace layout, CLI fallback, sandbox compatibility, cache refresh, and a Grok 4.6 smoke test, see [CODEX_INSTALL.zh-CN.md](./CODEX_INSTALL.zh-CN.md).

## Codex built-in MCP contract

The Codex plugin manifest references the packaged MCP declaration with
`"mcpServers": "./.mcp.json"`. The packaged `.mcp.json` must start
`node ./dist/index.js` with `cwd: "."`. Codex resolves that working directory
against the installed plugin version root. Do not hard-code a development checkout
or a versioned Codex cache path, duplicate the same server in user `config.toml`, or
put `CURSOR_API_KEY` in the MCP declaration.

After installing or reinstalling the plugin, create a new Codex task. Codex loads
the bundled Skill and starts the built-in MCP automatically. It sends only the
workspace path, `targetLocations` (files, directories, or line locations), a
bounded `task` scope, model, permission, and idempotency data. The Cursor Agent
reads the authorized workspace itself. Both `read-only` and `workspace-write`
reject source text, code fences, file contents, and diffs in MCP arguments. An
explicit request for Cursor to review a current or named
workspace authorizes in-scope reading, not secrets, unrelated paths, or edits. An
explicit request to modify or fix must map to `workspace-write`, not be silently
downgraded to analysis. Outside the static allowlist, `authorize_workspace`
issues a reusable capability bound to the current Codex conversation and exact
workspace; it supports both `read-only` and `workspace-write`.

The plugin ships its Codex Skill inside the original package at
`skills/delegate-to-cursor-agent/SKILL.md`. The manifest declares
`"skills": "./skills/"`, and the npm package includes `skills/`, so installing
or reinstalling the plugin makes Codex load the Skill automatically in newly
created tasks; no install-time Skill generation is needed.

## Quick start

Requirements: Git, Node.js `>=22.13`, and a Cursor account. The recommended
authentication method is the official `Cursor.auth.login()` stored login.

```powershell
git clone https://github.com/tonytanglab/cursor-relay-mcp.git
cd cursor-relay-mcp
npm install

# Opens the system default browser and stores an official SDK login for this OS user.
node --input-type=module --eval 'import { Cursor } from "@cursor/sdk"; await Cursor.auth.login({ apiKeyName: "cursor-relay-mcp" })'

npm run build
$env:CURSOR_RELAY_WORKSPACE_ROOTS = "D:\app\git"
node .\dist\index.js
```

Run the login once on each computer and OS user account that starts the MCP
server. The official SDK opens the system default browser, mints a named,
expiring and revocable API key, and stores it in its official credential store;
the relay never reads or returns the key value. Check the login without exposing
credentials:

```powershell
node --input-type=module --eval 'import { Cursor } from "@cursor/sdk"; console.log((await Cursor.auth.status()).status)'
```

`logged-in` means the MCP process can use stored login. `CURSOR_API_KEY` remains
an optional alternative for automation, but do not put it in `.mcp.json`, shell
history, logs, or the repository. When using stored login, omit
`CURSOR_API_KEY` entirely instead of setting it to an empty string.

The normal tool flow is `doctor` → `list_models` → `start_run` → repeated `wait_run` calls until `terminal=true`. Runs are idempotent, persisted, bounded by a total timeout, and recoverable after process restart.

For `start_run` and `reply_run`, `task` means review/implementation scope and
acceptance requirements, never file contents. Use `targetLocations` for
workspace-relative files, directories, or line locations. If a reply omits them,
it inherits the parent locations. The Relay builds the Cursor instruction so the
agent reads the authorized workspace directly; authorization does not relax this
contract for either read-only or read/write runs.

`doctor` reports the effective `defaultTimeoutMs` and `maxTimeoutMs`. Ordinary
repository work should normally omit `timeoutMs` and use the configured default
(24 hours by default and also the hard maximum). Callers may request a shorter
explicit budget when appropriate, but cannot raise a run above 24 hours. A
`wait_run` timeout is only a polling slice. Retryable SDK reconnects are returned as
`connection.state=reconnecting` and remain non-terminal.
While status and events show healthy progress, callers should keep waiting within
the run budget instead of cancelling or creating short continuation runs.

`start_run` and `reply_run` attach an MCP Apps read-only panel that shows the
current status, selected model and permission, elapsed time, incremental Cursor
SDK event timeline, token usage, error, and final output. `view_run` opens the
same panel for an existing Relay run. The panel calls only `wait_run` and
`read_events`; it cannot authorize, start, reply to, or cancel a run. Hosts that
do not render MCP Apps keep the existing structured tool-result fallback.

The pinned public Cursor SDK has no operation for injecting a new instruction
into an active local Agent run. The relay therefore reports
`doctor.capabilities.activeRunSteering=false` and never treats an internal event
append as successful steering. A caller must not cancel merely to redirect: it
should keep observing and use `reply_run` after terminal state. Cancellation is
reserved for an explicit stop request or a concrete safety boundary.

Security defaults are fail-closed: unattended runs require the static workspace
allowlist. When a user explicitly authorizes Cursor Relay for a workspace in the
current conversation, `authorize_workspace` can issue a reusable read-only or
workspace-write capability. The token is never persisted and is bound to the
real path, granted permission ceiling, and MCP task/session when available. A
workspace-write capability can also run read-only tasks; a read-only capability
cannot be elevated. It expires when that conversation scope or MCP process ends.
Permissions otherwise default to read-only, the Cursor sandbox is enabled by
default on supported non-Windows hosts, and only project settings are loaded.
Windows defaults the SDK sandbox off because the current local runtime reports
it as unsupported; the read-only tool allowlist remains enforced. Both normal
presets expose Cursor's official `webSearch` and `webFetch` tools so Cursor can
decide whether network research is relevant.
`danger-full-access` still requires the static allowlist plus both
`CURSOR_RELAY_ENABLE_DANGER_FULL_ACCESS=true` at server startup and
`confirmedDangerousPermission=true` on the request. Leave the server switch off
for normal use.

`CURSOR_RELAY_READ_ONLY_SANDBOX_ENABLED` can explicitly disable the sandbox on
supported non-Windows hosts. Windows always clamps this setting off because the
current Cursor SDK local runtime does not support that sandbox path. This switch
applies only to the `read-only` preset; its public tool allowlist remains
restricted to `read`, `grep`, `glob`, `ls`, `webSearch`, and `webFetch` by
default.
The workspace-write sandbox follows the same platform compatibility rule: it is
enabled by default on supported non-Windows hosts and clamped off on Windows,
while the exact workspace authorization and disallowed-tool list remain enforced.

`delete`, `task`, `mcp`, and `generateImage` are controlled by the Codex main
process rather than being permanently unavailable. `start_run` and `reply_run`
accept `codexAllowedTools`; omitted reply values inherit the parent policy and
an empty array revokes it. Read-only runs may additionally allow only
`generateImage`; the other controlled tools require `workspace-write`. Ordinary,
reversible actions already covered by the user's request need no separate prompt.
Human confirmation is reserved for materially destructive, broad, irreversible,
out-of-scope, externally consequential, or `danger-full-access` actions.

`CURSOR_RELAY_SETTING_SOURCES` is an optional comma-separated list restricted
to the public `project`, `team`, and `mdm` setting layers. It defaults to
`project`; `user`, `plugins`, and `all` are deliberately rejected to avoid
ambient or recursive MCP behavior.

Run summaries omit streamed events and report `eventCount`; use `read_events`
for event pages. Event data larger than 8 KiB is replaced with explicit
truncation metadata. Redaction is based on sensitive field names and is not a
general secret scanner, so use a private state directory and avoid secrets in
prompts.

The relay uses only public exports from the pinned SDK: model discovery,
`Agent.create`/`resume`/`listRuns`/`getRun`, `Run.stream`/`wait`/`cancel`, and
official authentication status. It does not inspect Cursor IDE state or private
endpoints. Restarting the Cursor IDE is not required for local SDK runs.

## Verification

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

The default tests do not call the real Cursor API or modify a real workspace.
