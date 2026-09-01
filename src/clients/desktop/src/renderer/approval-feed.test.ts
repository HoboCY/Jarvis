import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  DesktopApprovalFeed,
  approvalDecisionKey,
  ensureActiveDesktopApprovalFeed,
  type DesktopApproval
} from "./approval-feed.js";

const pending: DesktopApproval = {
  id: "0198b0a1-0000-7000-8000-000000000101",
  taskId: "0198b0a1-0000-7000-8000-000000000102",
  executionId: "0198b0a1-0000-7000-8000-000000000103",
  deviceId: "0198b0a1-0000-7000-8000-000000000104",
  kind: "fileWrite",
  reason: "Write report",
  status: "pending",
  scope: null
};

test("pulls pending approvals, deduplicates ids, and only sends explicit approve-once", async () => {
  const decisions: unknown[] = [];
  const feed = new DesktopApprovalFeed({
    getPendingApprovals: async () => [pending, { ...pending, reason: "duplicate" }],
    decideApproval: async input => {
      decisions.push(input);
      return { ...pending, status: "approved", scope: input.scope };
    }
  });

  await feed.refresh();
  assert.equal(feed.approvals.length, 1);
  await feed.approveOnce(pending.id);

  const key = approvalDecisionKey(pending.id, "approve", "once");
  assert.deepEqual(decisions, [{
    approvalId: pending.id,
    decision: "approve",
    scope: "once",
    clientRequestId: key,
    idempotencyKey: key
  }]);
  assert.deepEqual(feed.approvals, []);
});

test("denies with a stable idempotency key after a lost response", async () => {
  let failOnce = true;
  const keys: string[] = [];
  const feed = new DesktopApprovalFeed({
    getPendingApprovals: async () => [pending],
    decideApproval: async input => {
      keys.push(input.idempotencyKey);
      if (failOnce) {
        failOnce = false;
        throw new Error("response lost after commit");
      }
      return { ...pending, status: "denied", scope: input.scope };
    }
  });

  await feed.refresh();
  await assert.rejects(() => feed.deny(pending.id), /response lost/);
  await feed.deny(pending.id);

  assert.deepEqual(keys, [
    approvalDecisionKey(pending.id, "deny", "once"),
    approvalDecisionKey(pending.id, "deny", "once")
  ]);
  assert.deepEqual(feed.approvals, []);
});

test("uses SignalR as a hint, deduplicates event ids, and ignores stale refresh after dispose", async () => {
  let refreshes = 0;
  let release: ((value: readonly DesktopApproval[]) => void) | undefined;
  const feed = new DesktopApprovalFeed({
    getPendingApprovals: async () => {
      refreshes++;
      return new Promise(resolve => { release = resolve; });
    },
    decideApproval: async () => pending
  });

  const event = { eventId: "approval-event-1", type: "approval.required" };
  const refresh = feed.applyEvent(event);
  release?.([pending]);
  await refresh;
  assert.equal(refreshes, 1);
  assert.equal(await feed.applyEvent(event), false);
  assert.equal(refreshes, 1);

  const stale = feed.refresh();
  feed.dispose();
  release?.([pending]);
  await stale;
  assert.deepEqual(feed.approvals, []);
});

test("recreates a disposed approval feed during a StrictMode setup-cleanup-setup cycle", () => {
  let creations = 0;
  const create = (): DesktopApprovalFeed => {
    creations++;
    return new DesktopApprovalFeed({
      getPendingApprovals: async () => [],
      decideApproval: async () => pending
    });
  };

  const first = ensureActiveDesktopApprovalFeed(undefined, create);
  first.dispose();
  const second = ensureActiveDesktopApprovalFeed(first, create);

  assert.notEqual(second, first);
  assert.equal(second.isDisposed, false);
  assert.equal(creations, 2);
});
