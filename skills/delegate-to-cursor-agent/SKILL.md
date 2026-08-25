---
name: delegate-to-cursor-agent
description: Delegate a scoped local coding, analysis, review, or testing subtask to a user-selected Cursor model through cursor-relay-mcp. Use when the user explicitly asks to call Cursor, use a Cursor model as a subtask, or requests Cursor Relay. Keep destructive actions and final decisions with the calling agent.
---

# Delegate to Cursor Agent

1. Call `doctor`. If authentication or workspace roots are missing, report the exact configuration problem.
2. Call `list_models`; never guess a model ID or parameter. Match the user's requested model to the returned catalog.
3. Call `start_run` with an absolute workspace, a concrete bounded task, the selected model, a stable unique idempotency key, and `read-only` unless the user explicitly authorized edits.
4. If edits are authorized, use `workspace-write`. Use `danger-full-access` only after explicit user confirmation and set `confirmedDangerousPermission=true`.
5. Call `wait_run` repeatedly while `terminal=false` or `mustCallAgain=true`. Do not treat a poll timeout as run completion.
6. On completion, consume `run.assistantText` and relevant persisted events. Independently verify important conclusions or changes before reporting them.
7. Use `reply_run` only for a genuine continuation of a terminal run. Use `cancel_run` when the user stops the task.

Never place credentials in prompts, tool arguments, idempotency keys, or status reports.
