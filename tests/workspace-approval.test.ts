import assert from "node:assert/strict";
import test from "node:test";
import { RelayError } from "../src/errors.js";
import { WorkspaceApprovalBroker } from "../src/workspace-approval.js";

const request = {
  workspace: "C:\\work\\repo",
  permission: "read-only" as const,
  callerScope: "task:test",
};

test("workspace approval is conversation-scoped, reusable and permission-bounded", () => {
  const broker = new WorkspaceApprovalBroker();
  const grant = broker.issue(request);
  const claim = broker.validate(grant.token, request);
  assert.equal(claim.approvalId, grant.approvalId);
  assert.equal(
    broker.validate(grant.token, request).approvalId,
    grant.approvalId,
  );
  assert.throws(
    () =>
      broker.validate(grant.token, {
        ...request,
        callerScope: "task:different",
      }),
    (error: unknown) =>
      error instanceof RelayError &&
      error.code === "WORKSPACE_APPROVAL_MISMATCH",
  );
  assert.throws(
    () =>
      broker.validate(grant.token, {
        ...request,
        permission: "workspace-write",
      }),
    (error: unknown) =>
      error instanceof RelayError &&
      error.code === "WORKSPACE_APPROVAL_MISMATCH",
  );

  const writeGrant = broker.issue({
    ...request,
    permission: "workspace-write",
  });
  assert.equal(
    broker.validate(writeGrant.token, request).approvalId,
    writeGrant.approvalId,
  );
  assert.equal(
    broker.validate(writeGrant.token, {
      ...request,
      permission: "workspace-write",
    }).approvalId,
    writeGrant.approvalId,
  );
});
