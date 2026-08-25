export type PermissionPreset =
  | "read-only"
  | "workspace-write"
  | "danger-full-access";
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
export interface RelayEvent {
  sequence: number;
  timestamp: string;
  type: string;
  data: unknown;
}

export interface RelayRun {
  relayRunId: string;
  sdkRunId?: string | undefined;
  agentId: string;
  workspace: string;
  task: string;
  model: ModelSelection;
  permission: PermissionPreset;
  dangerousPermissionConfirmed?: boolean | undefined;
  status: RelayRunStatus;
  createdAt: string;
  updatedAt: string;
  deadlineAt: string;
  assistantText?: string | undefined;
  error?: RelayErrorShape | undefined;
  parentRunId?: string | undefined;
  events: RelayEvent[];
}

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
  model: ModelSelection;
  permission?: PermissionPreset | undefined;
  confirmedDangerousPermission?: boolean | undefined;
  idempotencyKey: string;
  timeoutMs?: number | undefined;
  parentRunId?: string | undefined;
}
