# cursor-relay-mcp

A local MCP server built on the official `@cursor/sdk`. It lets MCP clients delegate a bounded task to an explicitly selected Cursor model while keeping durable, restart-safe run state.

`@cursor/sdk` is public beta. This package pins exactly `1.0.28` and includes an SDK export contract test. See [README.zh-CN.md](./README.zh-CN.md) for the full guide.

## Quick start

Requirements: Node.js `>=22.13` and a Cursor API key.

```powershell
npm install
npm run build
$env:CURSOR_API_KEY = "..."
$env:CURSOR_RELAY_WORKSPACE_ROOTS = "D:\app\git"
node .\dist\index.js
```

Do not commit the API key. The relay reads it only from the process environment and never persists it.

The normal tool flow is `doctor` → `list_models` → `start_run` → repeated `wait_run` calls until `terminal=true`. Runs are idempotent, persisted, bounded by a total timeout, and recoverable after process restart.

Security defaults are fail-closed: an empty workspace allowlist denies all runs, permissions default to read-only, the Cursor sandbox is enabled, and only project settings are loaded.

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
