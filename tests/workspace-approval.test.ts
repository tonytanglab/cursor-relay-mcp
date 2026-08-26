import assert from "node:assert/strict";
import test from "node:test";
import { RelayError } from "../src/errors.js";
import { WorkspaceApprovalBroker } from "../src/workspace-approval.js";

const request = {
  workspace: "C:\\work\\repo",
  task: "只读评估 CLI/MCP",
  idempotencyKey: "approval-test-operation",
  callerScope: "task:test",
};

test("workspace approval is exact, expiring and single-use", () => {
  let now = Date.parse("2026-08-26T06:00:00.000Z");
  const broker = new WorkspaceApprovalBroker(() => now, 1_000);
  const grant = broker.issue(request);
  const claim = broker.validate(grant.token, request);
  assert.equal(claim.approvalId, grant.approvalId);
  assert.throws(
    () => broker.validate(grant.token, { ...request, task: "不同任务" }),
    (error: unknown) =>
      error instanceof RelayError &&
      error.code === "WORKSPACE_APPROVAL_MISMATCH",
  );
  broker.consume(grant.token, claim.approvalId);
  assert.throws(
    () => broker.validate(grant.token, request),
    (error: unknown) =>
      error instanceof RelayError &&
      error.code === "WORKSPACE_APPROVAL_INVALID",
  );

  const expiring = broker.issue(request);
  now += 1_000;
  assert.throws(
    () => broker.validate(expiring.token, request),
    (error: unknown) =>
      error instanceof RelayError &&
      error.code === "WORKSPACE_APPROVAL_EXPIRED",
  );
});
