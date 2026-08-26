import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseDiagnostics } from "./diagnostics.js";

test("diagnostics parser keeps only bounded safe aggregates", () => {
  const result = parseDiagnostics({
    version: "1.0.0",
    uptimeSeconds: 12,
    database: { available: true },
    work: {
      tasksByStatus: { queued: 2 },
      pendingApprovals: 1,
      unreadNotifications: 3,
      pendingOutbox: 4,
      onlineDevices: 1
    },
    workers: { responses: "running" },
    circuits: { openai: "closed" },
    processStartedAtMs: 123,
    secret: "Bearer must never render"
  });

  assert.deepEqual(result.tasksByStatus, { queued: 2 });
  assert.equal(result.workers.responses, "running");
  assert.equal("secret" in result, false);
});

test("diagnostics parser rejects unbounded or malformed backend values", () => {
  assert.throws(() => parseDiagnostics({}), /diagnostics response/);
  assert.throws(() => parseDiagnostics({
    version: "1",
    uptimeSeconds: -1,
    database: { available: true },
    work: {
      tasksByStatus: {},
      pendingApprovals: 0,
      unreadNotifications: 0,
      pendingOutbox: 0,
      onlineDevices: 0
    },
    workers: {},
    circuits: {}
  }), /uptimeSeconds/);
});
