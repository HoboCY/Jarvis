import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  BudgetExceededError,
  createBudgetTracker,
  withTimeout
} from "./budgets.mjs";

test("provider probes, attempts, and retries share hard request budgets", () => {
  const budget = createBudgetTracker({ providerRequests: 2, retries: 1 });

  budget.recordProviderAttempt();
  budget.recordProviderAttempt({ retry: true });
  assert.deepEqual(budget.snapshot().used, {
    providerRequests: 2,
    realtimeConnections: 0,
    delegationAttempts: 0,
    codexTasks: 0,
    retries: 1
  });

  assert.throws(
    () => budget.recordProviderAttempt({ retry: true }),
    (error) => error instanceof BudgetExceededError && error.code === "BUDGET_EXHAUSTED"
  );
  assert.equal(budget.snapshot().used.providerRequests, 2);
  assert.equal(budget.snapshot().used.retries, 1);
});

test("bounded work rejects with a safe timeout category", async () => {
  await assert.rejects(
    () => withTimeout(() => new Promise(() => {}), 5),
    (error) => error.code === "TIMEOUT" && error.message === "TIMEOUT"
  );
});
