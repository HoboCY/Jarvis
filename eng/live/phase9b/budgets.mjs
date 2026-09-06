export const DEFAULT_BUDGETS = Object.freeze({
  providerRequests: 12,
  realtimeConnections: 4,
  delegationAttempts: 2,
  codexTasks: 5,
  retries: 2
});

export class BudgetExceededError extends Error {
  constructor(kind, limit) {
    super("BUDGET_EXHAUSTED");
    this.name = "BudgetExceededError";
    this.code = "BUDGET_EXHAUSTED";
    this.kind = kind;
    this.limit = limit;
  }
}

export class TimeoutError extends Error {
  constructor() {
    super("TIMEOUT");
    this.name = "TimeoutError";
    this.code = "TIMEOUT";
  }
}

export function createBudgetTracker(overrides = {}) {
  const limits = { ...DEFAULT_BUDGETS };
  for (const [kind, value] of Object.entries(overrides)) {
    assertBudgetKind(kind);
    if (!Number.isSafeInteger(value) || value < 0 || value > DEFAULT_BUDGETS[kind]) {
      throw new RangeError("Invalid hard budget.");
    }
    limits[kind] = value;
  }

  const used = Object.fromEntries(Object.keys(DEFAULT_BUDGETS).map((kind) => [kind, 0]));

  return Object.freeze({
    consume(kind, amount = 1) {
      assertAmount(amount);
      assertBudgetKind(kind);
      assertAvailable(limits, used, kind, amount);
      used[kind] += amount;
      return used[kind];
    },
    recordProviderAttempt({ retry = false } = {}) {
      const increments = { providerRequests: 1, retries: retry ? 1 : 0 };
      for (const [kind, amount] of Object.entries(increments)) {
        if (amount > 0) {
          assertAvailable(limits, used, kind, amount);
        }
      }
      used.providerRequests += 1;
      if (retry) {
        used.retries += 1;
      }
      return used.providerRequests;
    },
    canConsume(kind, amount = 1) {
      assertAmount(amount);
      assertBudgetKind(kind);
      return used[kind] + amount <= limits[kind];
    },
    snapshot() {
      const remaining = {};
      for (const kind of Object.keys(limits)) {
        remaining[kind] = limits[kind] - used[kind];
      }
      return {
        limits: { ...limits },
        used: { ...used },
        remaining
      };
    }
  });
}

export async function withTimeout(operation, timeoutMs, { signal } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30 * 60 * 1000) {
    throw new RangeError("Timeout must be positive.");
  }

  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, timeoutMs);

  let removeExternalAbort;
  if (signal !== undefined) {
    if (signal.aborted) {
      clearTimeout(timer);
      throw new TimeoutError();
    }
    removeExternalAbort = () => controller.abort();
    signal.addEventListener("abort", removeExternalAbort, { once: true });
  }

  try {
    const value = typeof operation === "function"
      ? operation(controller.signal)
      : operation;
    return await Promise.race([
      value,
      new Promise((_, reject) => {
        controller.signal.addEventListener("abort", () => reject(new TimeoutError()), { once: true });
      })
    ]);
  } finally {
    clearTimeout(timer);
    if (removeExternalAbort !== undefined) {
      signal.removeEventListener("abort", removeExternalAbort);
    }
  }
}

function assertBudgetKind(kind) {
  if (!Object.hasOwn(DEFAULT_BUDGETS, kind)) {
    throw new RangeError("Unknown budget kind.");
  }
}

function assertAmount(amount) {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new RangeError("Budget amount must be a positive integer.");
  }
}

function assertAvailable(limits, used, kind, amount) {
  if (used[kind] + amount > limits[kind]) {
    throw new BudgetExceededError(kind, limits[kind]);
  }
}
