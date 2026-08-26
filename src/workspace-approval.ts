import { createHash, randomBytes, randomUUID } from "node:crypto";
import { RelayError } from "./errors.js";

const DEFAULT_APPROVAL_TTL_MS = 5 * 60_000;

export interface WorkspaceApprovalRequest {
  workspace: string;
  task: string;
  idempotencyKey: string;
  callerScope: string;
}

export interface WorkspaceApprovalGrant {
  approvalId: string;
  token: string;
  expiresAt: string;
}

export interface WorkspaceApprovalClaim {
  approvalId: string;
  authorizedAt: string;
}

interface ApprovalRecord extends WorkspaceApprovalRequest {
  approvalId: string;
  authorizedAt: string;
  expiresAtMs: number;
}

export class WorkspaceApprovalBroker {
  private readonly approvals = new Map<string, ApprovalRecord>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs = DEFAULT_APPROVAL_TTL_MS,
  ) {}

  issue(request: WorkspaceApprovalRequest): WorkspaceApprovalGrant {
    this.pruneExpired();
    const token = randomBytes(32).toString("base64url");
    const now = this.now();
    const record: ApprovalRecord = {
      ...request,
      approvalId: randomUUID(),
      authorizedAt: new Date(now).toISOString(),
      expiresAtMs: now + this.ttlMs,
    };
    this.approvals.set(tokenHash(token), record);
    return {
      approvalId: record.approvalId,
      token,
      expiresAt: new Date(record.expiresAtMs).toISOString(),
    };
  }

  validate(
    token: string | undefined,
    request: WorkspaceApprovalRequest,
  ): WorkspaceApprovalClaim {
    if (!token) {
      throw new RelayError(
        "WORKSPACE_APPROVAL_REQUIRED",
        "工作区不在静态白名单内；当前对话须先调用 authorize_workspace 获取一次性只读授权",
      );
    }
    const key = tokenHash(token);
    const record = this.approvals.get(key);
    if (!record) {
      throw new RelayError(
        "WORKSPACE_APPROVAL_INVALID",
        "工作区授权令牌无效、已使用或服务已重启",
      );
    }
    if (record.expiresAtMs <= this.now()) {
      this.approvals.delete(key);
      throw new RelayError(
        "WORKSPACE_APPROVAL_EXPIRED",
        "工作区授权令牌已过期，请重新取得当前对话授权",
      );
    }
    if (
      record.workspace !== request.workspace ||
      record.task !== request.task ||
      record.idempotencyKey !== request.idempotencyKey ||
      record.callerScope !== request.callerScope
    ) {
      throw new RelayError(
        "WORKSPACE_APPROVAL_MISMATCH",
        "工作区授权令牌与路径、任务、幂等键或 MCP 调用范围不匹配",
      );
    }
    return {
      approvalId: record.approvalId,
      authorizedAt: record.authorizedAt,
    };
  }

  consume(token: string, approvalId: string): void {
    const key = tokenHash(token);
    const record = this.approvals.get(key);
    if (!record || record.approvalId !== approvalId) {
      throw new RelayError(
        "WORKSPACE_APPROVAL_INVALID",
        "工作区授权令牌已被其他运行使用",
      );
    }
    this.approvals.delete(key);
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [key, record] of this.approvals) {
      if (record.expiresAtMs <= now) this.approvals.delete(key);
    }
  }
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
