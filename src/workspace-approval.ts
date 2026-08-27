import { createHash, randomBytes, randomUUID } from "node:crypto";
import { RelayError } from "./errors.js";
import type { PermissionPreset } from "./types.js";

export interface WorkspaceApprovalRequest {
  workspace: string;
  permission: Exclude<PermissionPreset, "danger-full-access">;
  callerScope: string;
}

export interface WorkspaceApprovalGrant {
  approvalId: string;
  token: string;
}

export interface WorkspaceApprovalClaim {
  approvalId: string;
  authorizedAt: string;
}

interface ApprovalRecord extends WorkspaceApprovalRequest {
  approvalId: string;
  authorizedAt: string;
}

export class WorkspaceApprovalBroker {
  private readonly approvals = new Map<string, ApprovalRecord>();

  issue(request: WorkspaceApprovalRequest): WorkspaceApprovalGrant {
    const token = randomBytes(32).toString("base64url");
    const record: ApprovalRecord = {
      ...request,
      approvalId: randomUUID(),
      authorizedAt: new Date().toISOString(),
    };
    this.approvals.set(tokenHash(token), record);
    return {
      approvalId: record.approvalId,
      token,
    };
  }

  validate(
    token: string | undefined,
    request: WorkspaceApprovalRequest,
  ): WorkspaceApprovalClaim {
    if (!token) {
      throw new RelayError(
        "WORKSPACE_APPROVAL_REQUIRED",
        "工作区不在静态白名单内；当前对话须先调用 authorize_workspace 获取对话级精确权限授权",
      );
    }
    const key = tokenHash(token);
    const record = this.approvals.get(key);
    if (!record) {
      throw new RelayError(
        "WORKSPACE_APPROVAL_INVALID",
        "工作区授权令牌无效或服务已重启",
      );
    }
    if (
      record.workspace !== request.workspace ||
      record.callerScope !== request.callerScope ||
      !permissionAllows(record.permission, request.permission)
    ) {
      throw new RelayError(
        "WORKSPACE_APPROVAL_MISMATCH",
        "工作区授权令牌与路径、权限或 MCP 对话范围不匹配",
      );
    }
    return {
      approvalId: record.approvalId,
      authorizedAt: record.authorizedAt,
    };
  }
}

function permissionAllows(
  granted: Exclude<PermissionPreset, "danger-full-access">,
  requested: Exclude<PermissionPreset, "danger-full-access">,
): boolean {
  return granted === "workspace-write" || requested === "read-only";
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
