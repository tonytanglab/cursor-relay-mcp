export type PermissionPreset =
  | "read-only"
  | "workspace-write"
  | "danger-full-access";
export type CodexControlledTool = "delete" | "task" | "mcp" | "generateImage";
export type RelayRunStatus =
  | "starting"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface ModelParameter {
  id: string;
  value: string;
}
export interface ModelSelection {
  id: string;
  params?: ModelParameter[] | undefined;
}
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  reasoningTokens?: number | undefined;
}
export interface RelayEvent {
  sequence: number;
  timestamp: string;
  type: string;
  data: unknown;
}

export interface RelayRun {
  relayRunId: string;
  sdkRunId?: string | undefined;
  requestId?: string | undefined;
  agentId: string;
  workspace: string;
  task: string;
  targetLocations?: string[] | undefined;
  model: ModelSelection;
  permission: PermissionPreset;
  codexAllowedTools?: CodexControlledTool[] | undefined;
  workspaceAuthorization?: {
    source: "static-allowlist" | "conversation-capability" | "interactive-once";
    approvalId?: string | undefined;
    authorizedAt?: string | undefined;
  };
  dangerousPermissionConfirmed?: boolean | undefined;
  status: RelayRunStatus;
  createdAt: string;
  updatedAt: string;
  deadlineAt: string;
  assistantText?: string | undefined;
  effectiveModel?: ModelSelection | undefined;
  durationMs?: number | undefined;
  usage?: TokenUsage | undefined;
  error?: RelayErrorShape | undefined;
  parentRunId?: string | undefined;
  events: RelayEvent[];
}

export type RelayRunSummary = Omit<RelayRun, "events"> & {
  eventCount: number;
  connection?: {
    state: "reconnecting";
    error: RelayErrorShape;
  };
};

export interface RelayErrorShape {
  code: string;
  message: string;
  retryable: boolean;
  details?: unknown;
}

export interface PersistedState {
  schemaVersion: 1;
  runs: Record<string, RelayRun>;
  operations: Record<string, { fingerprint: string; relayRunId: string }>;
}

export interface StartRunInput {
  workspace: string;
  task: string;
  targetLocations?: string[] | undefined;
  model: ModelSelection;
  permission?: PermissionPreset | undefined;
  codexAllowedTools?: CodexControlledTool[] | undefined;
  confirmedDangerousPermission?: boolean | undefined;
  workspaceApprovalToken?: string | undefined;
  idempotencyKey: string;
  timeoutMs?: number | undefined;
  parentRunId?: string | undefined;
}

export interface AuthorizeWorkspaceInput {
  workspace: string;
  permission?: PermissionPreset | undefined;
}
