import type { ModelSelection } from "./types.js";

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
}

export interface CursorEvent {
  type: string;
  [key: string]: unknown;
}
export interface CursorRunResult {
  status: "finished" | "error" | "cancelled";
  result?: string;
  error?: { code?: string; message: string };
}
export interface CursorRunHandle {
  id: string;
  agentId: string;
  createdAt?: number | undefined;
  status: "running" | "finished" | "error" | "cancelled";
  stream(): AsyncGenerator<CursorEvent, void>;
  wait(): Promise<CursorRunResult>;
  cancel(): Promise<void>;
}

export interface AgentLaunchOptions {
  agentId: string;
  idempotencyKey: string;
  workspace: string;
  model: ModelSelection;
  tools?: string[];
  disallowedTools?: string[];
  sandboxEnabled: boolean;
  autoReview: boolean;
}

export interface CursorSdkPort {
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
