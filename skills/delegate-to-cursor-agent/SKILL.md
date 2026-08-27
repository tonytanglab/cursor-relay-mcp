---
name: delegate-to-cursor-agent
description: Delegate a scoped local coding, analysis, review, or testing subtask to a user-selected Cursor model through cursor-relay-mcp. Use when the user explicitly asks to call Cursor, use a Cursor model as a subtask, or requests Cursor Relay. Keep destructive actions and final decisions with the calling agent.
---

# Delegate to Cursor Agent

1. Call `doctor`. If authentication is missing, report the exact configuration problem. Empty or non-matching static workspace roots do not block an explicitly user-requested interactive read-only or workspace-write run.
2. Call `list_models`; never guess a model ID or parameter. Match the user's requested model to the returned catalog.
3. Treat an explicit request for Cursor or a named Cursor model to review the current or named workspace as authorization to read that exact workspace. Treat an explicit request to modify, fix, implement, refactor or test code as authorization to read and write that exact workspace. This never authorizes credentials, secrets, unrelated paths, deletion or dangerous full access.
4. Codex sends only the absolute workspace path, a concrete bounded task, the selected model, the matching permission and a stable unique idempotency key through the plugin's built-in MCP. Do not paste repository source into MCP arguments: Cursor Agent reads and edits the authorized workspace itself.
5. Select `read-only` for review or analysis and `workspace-write` for requested code changes. If the workspace is outside `doctor.workspaceRoots`, call `authorize_workspace` only when the user explicitly selected Cursor for that workspace in the current conversation. Pass the exact workspace and chosen permission. Never authorize from model inference alone or for an unrelated workspace.
6. Reuse the returned `workspaceApprovalToken` for subsequent `start_run` and `reply_run` calls on that exact workspace in the current Codex conversation. A workspace-write capability also permits read-only runs; a read-only capability cannot be elevated. The token is process-local, scoped to the current MCP task/session, and invalid after that scope or process ends. Each run still needs its own concrete task and stable unique idempotency key. For a write task, tell Cursor to inspect the repository itself, implement the requested change, run proportionate verification, and report each modified file with its purpose and current verification status. Use `danger-full-access` only after explicit user confirmation, only for a statically allowlisted workspace, and set `confirmedDangerousPermission=true`.
7. Call `wait_run` repeatedly while `terminal=false` or `mustCallAgain=true`. Do not treat a poll timeout as completion. During a longer workspace-write run, use `read_events` with an advancing sequence cursor to follow file-edit and verification events; summarize changed-file progress without interrupting the run or uploading source.
8. On completion, consume `run.assistantText` and relevant persisted events. Verify the reported changed files and important results from the local workspace before reporting them.
9. Use `reply_run` only for a genuine continuation of a terminal run. A reply outside static roots needs a new exact authorization. Use `cancel_run` when the user stops the task.

Never place credentials in prompts, tool arguments, idempotency keys, or status reports.
