# cursor-relay-mcp

A local MCP server built on the official `@cursor/sdk`. It lets MCP clients delegate a bounded task to an explicitly selected Cursor model while keeping durable, restart-safe run state.

`@cursor/sdk` is public beta. This package pins exactly `1.0.28` and includes an SDK export contract test. See [README.zh-CN.md](./README.zh-CN.md) for the full guide.

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

Security defaults are fail-closed: unattended runs require the static workspace
allowlist. When a user explicitly authorizes Cursor Relay for a workspace in the
current conversation, `authorize_workspace` can issue a five-minute, single-use,
exact-task capability for `read-only` only. The token is never persisted and is
bound to the real path, task, idempotency key, and MCP task/session when available.
Permissions otherwise default to read-only, the Cursor sandbox is enabled, and
only project settings are loaded. `workspace-write` still requires the static
allowlist. `danger-full-access` requires both
`CURSOR_RELAY_ENABLE_DANGER_FULL_ACCESS=true` at server startup and
`confirmedDangerousPermission=true` on the request. Leave the server switch off
for normal use.

If the official SDK reports that local sandboxing is unsupported, an operator
may set `CURSOR_RELAY_READ_ONLY_SANDBOX_ENABLED=false`. This exception applies
only to the `read-only` preset; its public tool allowlist remains restricted to
`read`, `grep`, `glob`, and `ls`. The default stays `true`, and
`workspace-write` still requires SDK sandbox support.

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
