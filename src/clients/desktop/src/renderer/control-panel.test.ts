import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  ApprovalActionCoordinator,
  DesktopActionRunner,
  DesktopLogicalActionAttemptLedger,
  DesktopRealtimeActionCycle,
  TaskInputAttemptLedger,
  clearOppositeApprovalRetryable,
  createDesktopActionFailure,
  classifyDesktopActionFailure,
  desktopActionMessage,
  projectDesktopNotificationFeedback,
  projectRealtimeRetryControls,
  submitTaskInputWithReconcile,
  type DesktopActionState,
  type TaskInputAnswers
} from "./control-panel.js";
import {
  createDesktopActionFailureProjection,
  createDesktopIpcFailure,
  createDesktopIpcSuccess,
  isDesktopActionFailureProjection,
  unwrapDesktopIpcResult
} from "./desktop-ipc.js";
import {
  desktopDeviceAudioLabel,
  desktopDeviceCanUseLocalAudio,
  desktopDeviceStatusLabel,
  parseDesktopDeviceBootstrap
} from "./device-status.js";
import {
  projectDesktopRealtimeConnectionButton,
  projectDesktopRealtimeRetryButtons
} from "./realtime-retry-controls.js";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("keeps one pending action and one idempotency key for duplicate submissions", async () => {
  const states: DesktopActionState[] = [];
  const runner = new DesktopActionRunner({
    createIdempotencyKey: key => `stable:${key}`,
    onStateChange: state => states.push(state)
  });
  const operation = deferred<string>();
  let calls = 0;
  const execute = (idempotencyKey: string): Promise<string> => {
    calls++;
    assert.equal(idempotencyKey, "stable:task-cancel:task-1");
    return operation.promise;
  };

  const first = runner.run("task-cancel:task-1", execute);
  const second = runner.run("task-cancel:task-1", execute);
  assert.equal(first, second);
  assert.equal(runner.get("task-cancel:task-1")?.status, "pending");
  runner.reset("task-cancel:task-1");
  assert.equal(runner.run("task-cancel:task-1", execute), first);

  operation.resolve("accepted");
  assert.equal(await first, "accepted");
  assert.equal(calls, 1);
  assert.equal(runner.get("task-cancel:task-1")?.status, "succeeded");
  assert.deepEqual(states.map(state => state.status), ["pending", "succeeded"]);
  assert.equal(await runner.run("task-cancel:task-1", execute), "accepted");
  assert.equal(calls, 1);
});

test("retains a retryable failure and retries with the same idempotency key", async () => {
  const runner = new DesktopActionRunner({
    createIdempotencyKey: key => `stable:${key}`
  });
  const keys: string[] = [];
  let fail = true;
  const execute = async (idempotencyKey: string): Promise<string> => {
    keys.push(idempotencyKey);
    if (fail) {
      fail = false;
      throw new Error("network unavailable");
    }
    return "ok";
  };

  await assert.rejects(() => runner.run("notification-read:n-1", execute), /network unavailable/);
  assert.equal(runner.get("notification-read:n-1")?.status, "retryable");
  assert.equal(runner.get("notification-read:n-1")?.retryable, true);
  assert.equal(await runner.run("notification-read:n-1", execute), "ok");
  assert.deepEqual(keys, [
    "stable:notification-read:n-1",
    "stable:notification-read:n-1"
  ]);
  assert.equal(runner.get("notification-read:n-1")?.status, "succeeded");
});

test("does not resubmit terminal failures and keeps a bounded actionable message", async () => {
  const runner = new DesktopActionRunner({
    createIdempotencyKey: key => `stable:${key}`
  });
  let calls = 0;
  const failure = createDesktopActionFailure("terminal", "not_pending");
  const execute = async (): Promise<void> => {
    calls++;
    throw failure;
  };

  await assert.rejects(() => runner.run("approval-deny:a-1", execute), /Desktop action failed/);
  assert.equal(runner.get("approval-deny:a-1")?.status, "terminal");
  assert.equal(runner.get("approval-deny:a-1")?.retryable, false);
  await assert.rejects(() => runner.run("approval-deny:a-1", execute), /Desktop action failed/);
  assert.equal(calls, 1);
  assert.equal(classifyDesktopActionFailure(new Error("request timed out")), "retryable");
  assert.equal(classifyDesktopActionFailure(new Error("invalid approval decision")), "retryable");
  assert.equal(classifyDesktopActionFailure(new Error("Jarvis backend request failed with 404.")), "retryable");
  assert.equal(classifyDesktopActionFailure(new Error("Jarvis backend request failed with 503.")), "retryable");
  assert.equal(classifyDesktopActionFailure(createDesktopActionFailure("terminal", "not_pending")), "terminal");
  assert.equal(classifyDesktopActionFailure(new Error("the action is already cancelled")), "retryable");
  assert.doesNotMatch(
    desktopActionMessage(new Error("Bearer token=super-secret /Users/hobo/private.txt")),
    /super-secret|\/Users\/hobo/);
});

test("uses only typed allowlisted failures and redacts every sensitive input shape", () => {
  assert.equal(classifyDesktopActionFailure(createDesktopActionFailure("terminal", "not_pending")), "terminal");
  assert.equal(classifyDesktopActionFailure(createDesktopActionFailure("retryable", "backend_unavailable")), "retryable");
  assert.equal(classifyDesktopActionFailure(new Error("transport says already cancelled")), "retryable");
  assert.equal(classifyDesktopActionFailure(new Error("JARVIS_DESKTOP_ACTION_FAILURE|terminal|not_pending")), "retryable");
  assert.equal(
    classifyDesktopActionFailure(new Error("Error invoking remote method 'backend:cancelTask': Error: JARVIS_DESKTOP_ACTION_FAILURE|terminal|not_pending")),
    "retryable");
  assert.equal(
    classifyDesktopActionFailure(new Error("transport JARVIS_DESKTOP_ACTION_FAILURE|terminal|not_pending")),
    "retryable");
  assert.equal(classifyDesktopActionFailure(new Error("JARVIS_DESKTOP_ACTION_FAILURE|terminal|not-a-code")), "retryable");
  assert.equal(
    classifyDesktopActionFailure(createDesktopActionFailureProjection("terminal", "not_pending")),
    "terminal");
  assert.equal(classifyDesktopActionFailure({
    brand: "jarvis.desktop.action-failure",
    version: 1,
    kind: "terminal",
    code: "not_pending"
  }), "terminal");
  assert.equal(classifyDesktopActionFailure({
    brand: "fake.desktop.action-failure",
    version: 1,
    kind: "terminal",
    code: "not_pending"
  }), "retryable");

  const sentinel = "desktop-action-secret-sentinel";
  const messages = [
    `Authorization: Bearer ${sentinel}`,
    `token: ${sentinel}`,
    `secret=${sentinel}`,
    `https://example.test/callback?token=${sentinel}&secret=${sentinel}`,
    `/Users/hobo/${sentinel}`,
    `/home/hobo/${sentinel}`,
    `/opt/jarvis/${sentinel}`,
    `/private/var/${sentinel}`,
    `/var/tmp/${sentinel}`,
    `C:\\Users\\hobo\\${sentinel}`
  ];
  for (const raw of messages) {
    assert.doesNotMatch(desktopActionMessage(new Error(raw)), new RegExp(sentinel));
  }
});

test("unwraps only the branded versioned IPC result and preserves a safe failure projection", () => {
  const success = createDesktopIpcSuccess({ accepted: true });
  assert.deepEqual(unwrapDesktopIpcResult(success), { accepted: true });

  const failure = createDesktopIpcFailure(createDesktopActionFailureProjection("terminal", "not_pending"));
  assert.throws(
    () => unwrapDesktopIpcResult(failure),
    error => classifyDesktopActionFailure(error) === "terminal"
      && desktopActionMessage(error) === "目标已不再待处理。");
  assert.throws(
    () => unwrapDesktopIpcResult({
      brand: "jarvis.desktop.ipc",
      version: 1,
      ok: false,
      failure: {
        brand: "fake.desktop.action-failure",
        version: 1,
        kind: "terminal",
        code: "not_pending"
      }
    }),
    error => classifyDesktopActionFailure(error) === "retryable"
      && desktopActionMessage(error) === "操作失败，请稍后重试。");
  assert.throws(
    () => unwrapDesktopIpcResult(new Error("Error invoking remote method: Authorization: Bearer secret")),
    error => classifyDesktopActionFailure(error) === "retryable"
      && !desktopActionMessage(error).includes("secret"));
});

test("keeps a branded IPC projection through action-runner rejection", async () => {
  const runner = new DesktopActionRunner();
  const projection = createDesktopActionFailureProjection("terminal", "not_pending");

  await assert.rejects(
    () => runner.run("approval:projection", async () => {
      throw projection;
    }),
    error => isDesktopActionFailureProjection(error)
      && classifyDesktopActionFailure(error) === "terminal");
});

test("resets realtime action state for each lifecycle while preserving retries in one cycle", async () => {
  const resets: string[] = [];
  const runner = new DesktopActionRunner({
    createIdempotencyKey: key => `stable:${key}`,
    onStateReset: key => resets.push(key)
  });
  const cycle = new DesktopRealtimeActionCycle(runner);
  cycle.begin();
  await runner.run("realtime-disconnect", async () => undefined);
  assert.equal(runner.get("realtime-disconnect")?.status, "succeeded");

  cycle.begin();
  assert.equal(runner.get("realtime-disconnect"), undefined);
  assert.equal(resets.includes("realtime-disconnect"), true);
  await runner.run("realtime-disconnect", async () => undefined);
  assert.equal(runner.get("realtime-disconnect")?.status, "succeeded");

  let persistenceFailure = true;
  let wakeFailure = true;
  await assert.rejects(() => runner.run("realtime-retry-persistence", async () => {
    if (persistenceFailure) {
      persistenceFailure = false;
      throw createDesktopActionFailure("retryable", "persistence_unavailable");
    }
  }));
  await runner.run("realtime-retry-persistence", async () => undefined);
  await assert.rejects(() => runner.run("realtime-retry-wake", async () => {
    if (wakeFailure) {
      wakeFailure = false;
      throw createDesktopActionFailure("retryable", "wake_unavailable");
    }
  }));
  await runner.run("realtime-retry-wake", async () => undefined);
  cycle.begin();
  assert.equal(runner.get("realtime-retry-persistence"), undefined);
  assert.equal(runner.get("realtime-retry-wake"), undefined);

  let secondPersistenceFailure = true;
  let secondWakeFailure = true;
  await assert.rejects(() => runner.run("realtime-retry-persistence", async () => {
    if (secondPersistenceFailure) {
      secondPersistenceFailure = false;
      throw createDesktopActionFailure("retryable", "persistence_unavailable");
    }
  }));
  await assert.rejects(() => runner.run("realtime-retry-wake", async () => {
    if (secondWakeFailure) {
      secondWakeFailure = false;
      throw createDesktopActionFailure("retryable", "wake_unavailable");
    }
  }));
  await runner.run("realtime-retry-persistence", async () => undefined);
  await runner.run("realtime-retry-wake", async () => undefined);
  assert.equal(runner.get("realtime-retry-persistence")?.status, "succeeded");
  assert.equal(runner.get("realtime-retry-wake")?.status, "succeeded");
});

test("projects realtime retry controls only from their matching retryable failure", () => {
  const persistenceFailure: DesktopActionState = {
    key: "realtime-retry-persistence",
    status: "retryable",
    idempotencyKey: "persistence-key",
    retryable: true,
    code: "persistence_unavailable",
    message: "消息仍未保存，请稍后重试。"
  };
  const wakeFailure: DesktopActionState = {
    key: "realtime-retry-wake",
    status: "retryable",
    idempotencyKey: "wake-key",
    retryable: true,
    code: "wake_unavailable",
    message: "本地中文唤醒词检测不可用，请检查模型文件和麦克风权限后重试。"
  };

  assert.deepEqual(projectRealtimeRetryControls({
    status: "degraded",
    wakeState: "standby",
    hasController: true,
    persistenceRetryReason: "session-end",
    persistenceAction: persistenceFailure
  }), {
    persistence: true,
    wake: false
  });
  assert.deepEqual(projectRealtimeRetryControls({
    status: "connected",
    wakeState: "error",
    hasController: true,
    wakeAction: wakeFailure
  }), {
    persistence: false,
    wake: true
  });
  assert.deepEqual(projectRealtimeRetryControls({
    status: "degraded",
    wakeState: "error",
    hasController: true,
    persistenceRetryReason: "session-end",
    persistenceAction: persistenceFailure,
    wakeAction: wakeFailure
  }), {
    persistence: true,
    wake: false
  });
  assert.deepEqual(projectRealtimeRetryControls({
    status: "degraded",
    wakeState: "error",
    hasController: true,
    persistenceRetryReason: "session-end",
    persistenceAction: { ...persistenceFailure, status: "terminal", retryable: false },
    wakeAction: wakeFailure
  }), {
    persistence: true,
    wake: false
  });
  assert.deepEqual(projectRealtimeRetryControls({
    status: "connected",
    wakeState: "error",
    hasController: true,
    persistenceRetryReason: undefined,
    wakeAction: { ...wakeFailure, key: "realtime-retry-persistence" }
  }), {
    persistence: false,
    wake: false
  });

  assert.deepEqual(projectRealtimeRetryControls({
    status: "connected",
    wakeState: "standby",
    hasController: true,
    persistenceRetryReason: "event-ingest"
  }), {
    persistence: true,
    wake: false
  });
  assert.deepEqual(projectRealtimeRetryControls({
    status: "degraded",
    wakeState: "standby",
    hasController: false,
    persistenceRetryReason: "session-end"
  }), {
    persistence: true,
    wake: false
  });
  assert.deepEqual(projectRealtimeRetryControls({
    status: "degraded",
    wakeState: "standby",
    hasController: true,
    persistenceRetryReason: undefined,
    persistenceAction: persistenceFailure
  }), {
    persistence: false,
    wake: false
  });
});

test("projects a single persistence recovery button from an event-ingest failure", () => {
  let persistenceRetryCalls = 0;
  let wakeRetryCalls = 0;
  const controls = projectDesktopRealtimeRetryButtons({
    status: "connected",
    wakeState: "standby",
    hasController: true,
    persistenceRetryReason: "event-ingest",
    onRetryPersistence: () => { persistenceRetryCalls++; },
    onRetryWake: () => { wakeRetryCalls++; }
  });

  assert.deepEqual(controls.map(control => ({
    key: control.key,
    label: control.label,
    ariaLabel: control.ariaLabel,
    disabled: control.disabled
  })), [{
    key: "realtime-retry-persistence",
    label: "重试保存",
    ariaLabel: "重试保存",
    disabled: false
  }]);
  controls[0]!.onClick();
  assert.equal(persistenceRetryCalls, 1);
  assert.equal(wakeRetryCalls, 0);
});

test("hides realtime recovery after success and when there is no failure reason", () => {
  const persistenceSuccess = {
    key: "realtime-retry-persistence",
    status: "succeeded" as const,
    idempotencyKey: "persistence-key",
    retryable: false
  };
  const base = {
    status: "connected" as const,
    wakeState: "standby" as const,
    hasController: true,
    onRetryPersistence: () => undefined,
    onRetryWake: () => undefined
  };

  assert.deepEqual(projectDesktopRealtimeRetryButtons({
    ...base,
    persistenceRetryReason: "event-ingest",
    persistenceAction: persistenceSuccess
  }), []);
  assert.deepEqual(projectDesktopRealtimeRetryButtons({
    ...base,
    persistenceRetryReason: undefined
  }), []);
});

test("projects degraded realtime as an enabled connect intent", () => {
  let connectCalls = 0;
  let disconnectCalls = 0;
  const button = projectDesktopRealtimeConnectionButton({
    status: "degraded",
    onConnect: () => { connectCalls++; },
    onDisconnect: () => { disconnectCalls++; }
  });

  assert.deepEqual({
    intent: button.intent,
    label: button.label,
    disabled: button.disabled,
    busy: button.busy
  }, {
    intent: "connect",
    label: "需要处理",
    disabled: false,
    busy: false
  });
  button.onClick();
  assert.equal(connectCalls, 1);
  assert.equal(disconnectCalls, 0);
});

test("keeps delivery receipt states visible and separate from user action states", () => {
  const state = (status: DesktopActionState["status"], key = "notification-delivered:n-1"): DesktopActionState => ({
    key,
    status,
    idempotencyKey: `${key}:idempotency`,
    retryable: status === "retryable",
    ...(status === "retryable" ? { message: "失败，可重试" } : {})
  });

  for (const status of ["pending", "succeeded", "retryable", "terminal"] as const) {
    const projection = projectDesktopNotificationFeedback({ delivered: state(status) });
    assert.equal(projection.delivered?.state.status, status);
    assert.equal(projection.actions.length, 0);
  }

  const projection = projectDesktopNotificationFeedback({
    delivered: state("succeeded"),
    read: state("retryable", "notification-read:n-1")
  });
  assert.equal(projection.delivered?.state.status, "succeeded");
  assert.deepEqual(projection.actions.map(action => [action.action, action.state.status]), [
    ["read", "retryable"]
  ]);
});

test("isolates approval pending state per approval while keeping one approval mutually exclusive", () => {
  const coordinator = new ApprovalActionCoordinator();
  assert.equal(coordinator.begin("approval-a"), true);
  assert.equal(coordinator.begin("approval-a"), false);
  assert.equal(coordinator.begin("approval-b"), true);
  assert.equal(coordinator.isBusy("approval-a"), true);
  assert.equal(coordinator.isBusy("approval-b"), true);
  coordinator.end("approval-a");
  assert.equal(coordinator.begin("approval-a"), true);
  assert.equal(coordinator.isBusy("approval-b"), true);
});

test("clears stale approve retryable feedback when deny succeeds and locks both decisions", async () => {
  const approvalId = "approval-feedback";
  const runner = new DesktopActionRunner({
    createIdempotencyKey: key => `stable:${key}`
  });

  await assert.rejects(
    () => runner.run(`approval-approve:${approvalId}`, async () => {
      throw createDesktopActionFailure("retryable", "backend_unavailable");
    }));
  assert.equal(runner.get(`approval-approve:${approvalId}`)?.status, "retryable");

  clearOppositeApprovalRetryable(runner, approvalId, "deny");
  assert.equal(runner.get(`approval-approve:${approvalId}`), undefined);
  await runner.run(`approval-deny:${approvalId}`, async () => "denied");

  const approveState = runner.get(`approval-approve:${approvalId}`);
  const denyState = runner.get(`approval-deny:${approvalId}`);
  const approvalActionUnavailable = [approveState, denyState].some(state =>
    state?.status === "pending" || state?.status === "succeeded" || state?.status === "terminal");
  const approveDisabled = approvalActionUnavailable;
  const denyDisabled = approvalActionUnavailable;
  assert.equal(approveState, undefined);
  assert.equal((approveState ?? denyState)?.status, "succeeded");
  assert.equal(approveDisabled, true);
  assert.equal(denyDisabled, true);
});

test("freezes each user-input payload and starts a new logical attempt only when edited", () => {
  const ledger = new TaskInputAttemptLedger("task-input:task-1:request-1");
  const first = ledger.prepare({ format: { answers: ["Markdown"] } });
  ledger.commit(first);
  const retry = ledger.prepare({ format: { answers: ["Markdown"] } });
  assert.equal(first.isNewAttempt, false);
  assert.equal(retry.isNewAttempt, false);
  assert.equal(retry.actionKey, first.actionKey);
  assert.deepEqual(retry.payload, first.payload);
  assert.equal(retry.canonicalPayload, first.canonicalPayload);

  const edited = ledger.prepare({ format: { answers: ["PDF"] } });
  assert.equal(edited.isNewAttempt, true);
  assert.notEqual(edited.actionKey, first.actionKey);
  assert.notEqual(edited.canonicalPayload, first.canonicalPayload);
  assert.deepEqual(edited.payload, { format: { answers: ["PDF"] } });
});

test("keeps an edited task-input attempt provisional until reconcile commits it", () => {
  let generatedAttempts = 0;
  const ledger = new TaskInputAttemptLedger("task-input:task-1:request-abort", {
    createAttemptId: () => `attempt-${++generatedAttempts}`
  });
  const initial = ledger.prepare({ format: { answers: ["Markdown"] } });
  ledger.commit(initial);

  const edited = ledger.prepare({ format: { answers: ["PDF"] } });
  const afterFailedReconcile = ledger.prepare({ format: { answers: ["PDF"] } });
  assert.equal(edited.isNewAttempt, true);
  assert.equal(afterFailedReconcile.isNewAttempt, true);
  assert.equal(afterFailedReconcile.actionKey, edited.actionKey);
  assert.equal(generatedAttempts, 2);

  ledger.commit(afterFailedReconcile);
  const afterSuccessfulReconcile = ledger.prepare({ format: { answers: ["PDF"] } });
  assert.equal(afterSuccessfulReconcile.isNewAttempt, false);
  assert.equal(afterSuccessfulReconcile.actionKey, edited.actionKey);
});

test("reconciles every aborted edited submission and retries a committed network attempt", async () => {
  const ledger = new TaskInputAttemptLedger("task-input:task-1:request-flow", {
    createAttemptId: (() => {
      let next = 0;
      return () => `attempt-${++next}`;
    })()
  });
  ledger.commit(ledger.prepare({ format: { answers: ["Markdown"] } }));
  const payload = { format: { answers: ["PDF"] } };
  const runner = new DesktopActionRunner({ createIdempotencyKey: key => `stable:${key}` });
  let reconcileCalls = 0;
  let submitCalls = 0;
  const submittedKeys: string[] = [];
  let networkFailure = true;
  const reconcileOutcomes = ["throw", "abort", "commit"] as const;
  const flow = () => submitTaskInputWithReconcile({
    ledger,
    payload,
    reconcile: async () => {
      const outcome = reconcileOutcomes[reconcileCalls++];
      if (outcome === "throw") {
        throw new Error("reconcile failed");
      }
      return outcome === "commit";
    },
    runAction: (key, execute) => runner.run(key, execute),
    submit: async (_submission, idempotencyKey) => {
      submitCalls++;
      submittedKeys.push(idempotencyKey);
      if (networkFailure) {
        networkFailure = false;
        throw createDesktopActionFailure("retryable", "backend_unavailable");
      }
    }
  });

  await assert.rejects(flow, /reconcile failed/);
  assert.equal(await flow(), undefined);
  assert.equal(reconcileCalls, 2);
  assert.equal(submitCalls, 0);

  await assert.rejects(flow, error => classifyDesktopActionFailure(error) === "retryable");
  assert.equal(reconcileCalls, 3);
  assert.equal(submitCalls, 1);
  await flow();
  assert.equal(reconcileCalls, 3);
  assert.equal(submitCalls, 2);
  assert.equal(submittedKeys[0], submittedKeys[1]);
});

test("normalizes user-input whitespace before deriving the action key", () => {
  const ledger = new TaskInputAttemptLedger("task-input:task-1:request-2");
  const spaced = ledger.prepare({ answer: { answers: ["  same answer  "] } });
  const normalized = ledger.prepare({ answer: { answers: ["same answer"] } });
  assert.equal(spaced.actionKey, normalized.actionKey);
  assert.deepEqual(spaced.payload, normalized.payload);
});

test("keeps retry idempotency and payload coupled across a failed user-input submission", async () => {
  const runner = new DesktopActionRunner({ createIdempotencyKey: key => `stable:${key}` });
  const ledger = new TaskInputAttemptLedger("task-input:task-1:request-1");
  const first = ledger.prepare({ answer: { answers: ["first"] } });
  ledger.commit(first);
  const submitted: Array<{ key: string; idempotencyKey: string; payload: TaskInputAnswers }> = [];
  let fail = true;
  const execute = async (idempotencyKey: string, submission: ReturnType<TaskInputAttemptLedger["prepare"]>) => {
    submitted.push({ key: submission.actionKey, idempotencyKey, payload: submission.payload });
    if (fail) {
      fail = false;
      throw createDesktopActionFailure("retryable", "backend_unavailable");
    }
  };

  await assert.rejects(() => runner.run(first.actionKey, key => execute(key, ledger.prepare({ answer: { answers: ["first"] } }))));
  await runner.run(first.actionKey, key => execute(key, ledger.prepare({ answer: { answers: ["first"] } })));
  const edited = ledger.prepare({ answer: { answers: ["edited"] } });
  assert.notEqual(edited.actionKey, first.actionKey);
  assert.equal(submitted[0]?.idempotencyKey, submitted[1]?.idempotencyKey);
  assert.deepEqual(submitted[0]?.payload, submitted[1]?.payload);
});

test("allocates a new pairing identity after success while retrying one attempt with the same key", async () => {
  const attemptIds = ["attempt-a", "attempt-b"];
  const attempts = new DesktopLogicalActionAttemptLedger("mobile-pairing:create", {
    createAttemptId: () => attemptIds.shift() ?? "attempt-overflow"
  });
  const runner = new DesktopActionRunner({
    createIdempotencyKey: key => `stable:${key}`
  });

  const firstAttempt = attempts.begin();
  const firstKeys: string[] = [];
  await runner.run(firstAttempt.actionKey, async idempotencyKey => {
    firstKeys.push(idempotencyKey);
    return "first-code";
  });
  assert.equal(firstKeys.length, 1);

  const secondAttempt = attempts.begin();
  assert.notEqual(secondAttempt.actionKey, firstAttempt.actionKey);
  const secondKeys: string[] = [];
  let fail = true;
  await assert.rejects(() => runner.run(secondAttempt.actionKey, async idempotencyKey => {
    secondKeys.push(idempotencyKey);
    if (fail) {
      fail = false;
      throw createDesktopActionFailure("retryable", "backend_unavailable");
    }
    return "second-code";
  }));
  await runner.run(secondAttempt.actionKey, async idempotencyKey => {
    secondKeys.push(idempotencyKey);
    return "second-code";
  });
  assert.deepEqual(secondKeys, ["stable:mobile-pairing:create:attempt-b", "stable:mobile-pairing:create:attempt-b"]);
  assert.notEqual(firstKeys[0], secondKeys[0]);
  assert.equal(attempts.current?.actionKey, secondAttempt.actionKey);
});

test("keeps full canonical task-input identity distinct from a repeated legacy display hash", () => {
  let generatedAttempts = 0;
  const ledger = new TaskInputAttemptLedger("task-input:task-1:request-collision", {
    createAttemptId: () => `attempt-${++generatedAttempts}`
  });
  const legacyDisplayHash = (value: string): number => {
    let hash = 2_166_136_261;
    for (const character of value) {
      hash = Math.imul(hash ^ character.codePointAt(0)!, 16_777_619);
    }
    return hash >>> 0;
  };
  assert.equal(legacyDisplayHash("costarring"), legacyDisplayHash("liquid"));

  const first = ledger.prepare({ answer: { answers: ["costarring"] } });
  const second = ledger.prepare({ answer: { answers: ["liquid"] } });
  assert.notEqual(first.canonicalPayload, second.canonicalPayload);
  assert.notEqual(first.actionKey, second.actionKey);
  assert.equal(generatedAttempts, 2);
  const firstRetry = ledger.prepare({ answer: { answers: ["costarring"] } });
  assert.equal(firstRetry.actionKey, first.actionKey);
  assert.deepEqual(firstRetry.payload, first.payload);
  assert.equal(generatedAttempts, 2);
});

test("keeps task-input draft observation pure until the first prepare", () => {
  let generatedAttempts = 0;
  const ledger = new TaskInputAttemptLedger("task-input:task-1:request-draft", {
    createAttemptId: () => `attempt-${++generatedAttempts}`
  });
  const previews = new Set<string>();
  let lastPayload: TaskInputAnswers | undefined;
  for (let index = 0; index < 100; index++) {
    lastPayload = { answer: { answers: [`draft-${index.toString().padStart(3, "0")}`] } };
    previews.add(ledger.actionFor(lastPayload).actionKey);
  }
  assert.equal(previews.size, 1);
  assert.equal(generatedAttempts, 0);

  const prepared = ledger.prepare(lastPayload!);
  assert.equal(generatedAttempts, 1);
  assert.equal(ledger.actionFor(lastPayload!).actionKey, prepared.actionKey);
  assert.equal(generatedAttempts, 1);
});

test("strictly parses device type and status before presenting audio availability", () => {
  const online = parseDesktopDeviceBootstrap({
    deviceId: "device-1",
    name: "Jarvis Mac",
    deviceType: "desktop",
    platform: "darwin",
    status: "online"
  });
  assert.equal(desktopDeviceStatusLabel(online), "在线");
  assert.match(desktopDeviceAudioLabel(online), /本机处理/);
  const offline = { ...online, status: "offline" as const };
  assert.equal(desktopDeviceCanUseLocalAudio(offline), true);
  assert.match(desktopDeviceAudioLabel(offline), /本机处理/);
  const disabled = { ...online, status: "disabled" as const };
  assert.equal(desktopDeviceCanUseLocalAudio(disabled), false);
  assert.match(desktopDeviceAudioLabel(disabled), /禁用/);
  assert.equal(desktopDeviceCanUseLocalAudio({ ...online, deviceType: "mobile" }), false);
  assert.throws(() => parseDesktopDeviceBootstrap({ ...online, status: "unknown" }));
  assert.throws(() => parseDesktopDeviceBootstrap({ ...online, deviceType: "phone" }));
});
