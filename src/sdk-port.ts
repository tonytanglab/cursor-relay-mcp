import type { ModelSelection, TokenUsage } from "./types.js";

export const CURSOR_SDK_VERSION = "1.0.28";

export interface CursorModel {
  id: string;
  displayName: string;
  description?: string;
  aliases?: string[];
  parameters?: {
    id: string;
    displayName?: string;
    values: { value: string; displayName?: string }[];
  }[];
  variants?: {
    params: { id: string; value: string }[];
    displayName: string;
    description?: string;
    isDefault?: boolean;
  }[];
}

export interface CursorEvent {
  type: string;
  [key: string]: unknown;
}
export interface CursorRunResult {
  status: "finished" | "error" | "cancelled";
  requestId?: string;
  result?: string;
  error?: { code?: string; message: string };
  model?: ModelSelection;
  durationMs?: number;
  usage?: TokenUsage;
}
export type CursorRunOperation = "stream" | "wait" | "cancel";
export interface CursorRunHandle {
  id: string;
  requestId?: string | undefined;
  agentId: string;
  createdAt?: number | undefined;
  status: "running" | "finished" | "error" | "cancelled";
  supports(operation: CursorRunOperation): boolean;
  currentResult(): CursorRunResult | undefined;
  stream(): AsyncGenerator<CursorEvent, void>;
  wait(): Promise<CursorRunResult>;
  cancel(): Promise<void>;
  release(): Promise<void>;
}

export type CursorAuthStatus =
  | { mode: "environment-api-key" }
  | { mode: "stored-login"; expiresAtMs?: number }
  | { mode: "missing" };

export interface AgentLaunchOptions {
  agentId: string;
  idempotencyKey: string;
  workspace: string;
  model: ModelSelection;
  tools?: string[];
  disallowedTools?: string[];
  sandboxEnabled: boolean;
  autoReview: boolean;
  settingSources: ("project" | "team" | "mdm")[];
}

export interface CursorSdkPort {
  authStatus(): Promise<CursorAuthStatus>;
  listModels(): Promise<CursorModel[]>;
  start(task: string, options: AgentLaunchOptions): Promise<CursorRunHandle>;
  reply(
    agentId: string,
    task: string,
    options: AgentLaunchOptions,
  ): Promise<CursorRunHandle>;
  getRun(runId: string, workspace: string): Promise<CursorRunHandle>;
  findRun(
    agentId: string,
    workspace: string,
    createdAfter: number,
  ): Promise<CursorRunHandle | undefined>;
}
