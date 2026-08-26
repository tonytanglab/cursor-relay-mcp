---
name: delegate-to-cursor-agent
description: Delegate a scoped local coding, analysis, review, or testing subtask to a user-selected Cursor model through cursor-relay-mcp. Use when the user explicitly asks to call Cursor, use a Cursor model as a subtask, or requests Cursor Relay. Keep destructive actions and final decisions with the calling agent.
---

# Delegate to Cursor Agent

1. Call `doctor`. If authentication is missing, report the exact configuration problem. Empty or non-matching static workspace roots do not block an explicitly user-requested interactive read-only run.
2. Call `list_models`; never guess a model ID or parameter. Match the user's requested model to the returned catalog.
3. Choose the absolute workspace, concrete bounded task, selected model and stable unique idempotency key before authorization. If the workspace is outside `doctor.workspaceRoots` and the user explicitly named Cursor Relay/Cursor plus that workspace in the current conversation, call `authorize_workspace` with the exact workspace, task, idempotency key and `read-only`. Never call it from model inference alone or for an unrelated workspace.
4. Call `start_run` with the exact same values and the returned `workspaceApprovalToken`. The capability is five-minute, one-time, process-local and read-only. For repository-wide review or analysis, omit `timeoutMs` to use the configured default (30 minutes) or set a budget of at least 30 minutes; never use a 180-second total timeout for that workload.
5. If edits are authorized, use `workspace-write`, which still requires the workspace to be inside the static allowlist. Use `danger-full-access` only after explicit user confirmation and set `confirmedDangerousPermission=true`.
6. Call `wait_run` repeatedly while `terminal=false` or `mustCallAgain=true`. Do not treat a poll timeout as run completion.
7. On completion, consume `run.assistantText` and relevant persisted events. Independently verify important conclusions or changes before reporting them.
8. Use `reply_run` only for a genuine continuation of a terminal run. A reply outside static roots needs a new exact authorization. Use `cancel_run` when the user stops the task.

Never place credentials in prompts, tool arguments, idempotency keys, or status reports.
