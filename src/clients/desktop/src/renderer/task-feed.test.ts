import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  DesktopTaskNotificationFeed,
  artifactManifestFrom,
  collectTaskPages,
  desktopTaskFrom,
  ensureActiveDesktopTaskNotificationFeed,
  maxTrackedFeedEntities,
  nonTerminalTaskStatuses,
  pendingUserInputFrom,
  notificationActionIdempotencyKey,
  notificationActionsFrom,
  refreshFeedIfCurrent,
  refreshOnBackendConnectionState,
  type DesktopNotification,
  type DesktopTask
} from "./task-feed.js";
import { createDesktopActionFailure, DesktopActionRunner } from "./control-panel.js";

test("accepts only the exact allowlisted notification action projection", () => {
  assert.deepEqual(notificationActionsFrom('["acknowledge"]'), ["acknowledge"]);
  assert.deepEqual(notificationActionsFrom("[]"), []);
  assert.deepEqual(notificationActionsFrom('["run-command"]'), []);
  assert.deepEqual(notificationActionsFrom('["acknowledge","run-command"]'), []);
  assert.deepEqual(notificationActionsFrom("not-json"), []);
  assert.deepEqual(notificationActionsFrom(["acknowledge"]), []);
});

test("projects bounded user-input questions without accepting secret or provider fields", async () => {
  const projection = pendingUserInputFrom({
    requestId: "99",
    itemId: "item-1",
    threadId: "thread-1",
    turnId: "turn-1",
    status: "pending",
    providerRaw: { answers: { q1: { answers: ["secret"] } } },
    questions: [{
      id: "q1",
      header: "Choice",
      question: "Choose one",
      options: [{ label: "A", description: "First" }]
    }]
  });

  assert.deepEqual(projection, {
    requestId: "99",
    requestIdIsString: true,
    itemId: "item-1",
    threadId: "thread-1",
    turnId: "turn-1",
    questions: [{
      id: "q1",
      header: "Choice",
      question: "Choose one",
      isOther: false,
      options: [{ label: "A", description: "First" }]
    }],
    expiresAtMs: null
  });
  assert.equal(pendingUserInputFrom({
    requestId: "99",
    itemId: "item-1",
    threadId: "thread-1",
    turnId: "turn-1",
    questions: [{ id: "q1", header: "Secret", question: "Password?", isSecret: true }]
  }), undefined);
  assert.deepEqual(desktopTaskFrom({
    id: "task-1",
    status: "waitingForUserInput",
    providerRaw: { result: "must not enter Renderer" },
    pendingUserInput: projection
  }), {
    id: "task-1",
    status: "waitingForUserInput",
    goal: undefined,
    progressSummary: undefined,
    resultSummary: undefined,
    pendingUserInput: projection
  });
});

test("projects validated task and execution artifact manifests without paths", () => {
  const task = desktopTaskFrom({
    id: "task-artifact",
    status: "succeeded",
    artifacts: [{
      path: "/private/worker/secret/report.json",
      size: 42,
      sha256: "a".repeat(64),
      contentType: "application/json"
    }],
    execution: {
      id: "execution-artifact",
      artifacts: [{
        path: "/private/worker/secret/trace.txt",
        size: 7,
        sha256: "b".repeat(64),
        contentType: "text/plain"
      }]
    }
  });

  assert.deepEqual(task?.artifacts, [
    { size: 42, sha256: "a".repeat(64), contentType: "application/json" },
    { size: 7, sha256: "b".repeat(64), contentType: "text/plain" }
  ]);
  assert.equal(JSON.stringify(task).includes("/private/worker"), false);
});

test("rejects unsafe artifact metadata while retaining only validated fields", () => {
  assert.deepEqual(artifactManifestFrom([
    {
      path: "/private/worker/secret.json",
      size: 12,
      sha256: "C".repeat(64),
      contentType: "application/json",
      secret: "must not project"
    },
    { path: "/private/worker/negative", size: -1, sha256: "d".repeat(64), contentType: "text/plain" },
    { path: "/private/worker/short", size: 2, sha256: "not-a-sha", contentType: "text/plain" },
    { path: "/private/worker/control", size: 2, sha256: "e".repeat(64), contentType: "text/\nplain" },
    { path: "/private/worker/private-text", size: 2, sha256: "1".repeat(64), contentType: "private secret text" },
    { path: "/private/worker/overflow", size: Number.MAX_SAFE_INTEGER + 1, sha256: "f".repeat(64), contentType: "text/plain" }
  ]), [
    { size: 12, sha256: "c".repeat(64), contentType: "application/json" }
  ]);
});

test("restores terminal artifact manifests through a bounded no-status scan without adding terminal tasks", async () => {
  const statusCalls: (string | undefined)[] = [];
  const scanCalls: Array<{ conversationId?: string; cursor?: string }> = [];
  const feed = new DesktopTaskNotificationFeed({
    getTasks: async (_conversationId, _cursor, status) => {
      statusCalls.push(status);
      return status === "running" ? [{ id: "active-task", status: "running" }] : [];
    },
    getAllTasks: async (conversationId, cursor) => {
      scanCalls.push({ conversationId, cursor });
      return cursor === undefined
        ? {
          items: [{
            id: "terminal-task",
            status: "succeeded",
            execution: {
              id: "terminal-execution",
              artifacts: [{
                path: "/private/worker/secret/report.json",
                size: 42,
                sha256: "a".repeat(64),
                contentType: "application/json"
              }]
            }
          }],
          nextCursor: null
        }
        : [];
    },
    getUnreadNotifications: async () => [],
    markDelivered: async () => undefined,
    markRead: async () => undefined,
    dismiss: async () => undefined
  });

  await feed.refresh("conversation-artifacts");

  assert.deepEqual(statusCalls.sort(), [...nonTerminalTaskStatuses].sort());
  assert.deepEqual(scanCalls, [{ conversationId: "conversation-artifacts", cursor: undefined }]);
  assert.deepEqual(feed.tasks.map(task => task.id), ["active-task"]);
  assert.deepEqual(feed.artifacts, [{
    taskId: "terminal-task",
    executionId: "terminal-execution",
    status: "succeeded",
    artifacts: [{ size: 42, sha256: "a".repeat(64), contentType: "application/json" }]
  }]);
  assert.equal(feed.artifactRestoreStatus, "complete");
  assert.equal(JSON.stringify(feed.artifacts).includes("/private/worker"), false);
});

test("restores terminal task identity separately from active tasks during the no-status scan", async () => {
  const feed = new DesktopTaskNotificationFeed({
    getTasks: async (_conversationId, _cursor, status) =>
      status === "running" ? [{ id: "active-task", status: "running" }] : [],
    getAllTasks: async () => [
      { id: "active-task", status: "running" },
      { id: "terminal-no-artifact", status: "succeeded" },
      { id: "terminal-failed", status: "failed" }
    ],
    getUnreadNotifications: async () => [
      { id: "notification-independent", status: "delivered", title: "完成", body: "已补拉" }
    ],
    markDelivered: async () => undefined,
    markRead: async () => undefined,
    dismiss: async () => undefined
  });

  await feed.refresh("conversation-terminal");

  assert.deepEqual(feed.tasks.map(task => task.id), ["active-task"]);
  assert.deepEqual(feed.terminalTasks, [
    { taskId: "terminal-failed", status: "failed" },
    { taskId: "terminal-no-artifact", status: "succeeded" }
  ]);
  assert.deepEqual(feed.notifications.map(notification => notification.id), ["notification-independent"]);
});

test("retains a newer terminal event when the in-flight no-status scan is stale", async () => {
  let releaseScan!: (tasks: readonly DesktopTask[]) => void;
  const scan = new Promise<readonly DesktopTask[]>(resolve => { releaseScan = resolve; });
  const feed = new DesktopTaskNotificationFeed({
    getTasks: async (_conversationId, _cursor, status) =>
      status === "running"
        ? [{ id: "race-task", status: "running", entityVersion: 1 }]
        : [],
    getAllTasks: async () => scan,
    getUnreadNotifications: async () => [],
    markDelivered: async () => undefined,
    markRead: async () => undefined,
    dismiss: async () => undefined
  });

  const refresh = feed.refresh("conversation-race");
  await feed.applyEvent({
    eventId: "race-task-finished",
    occurredAt: 2,
    type: "task.updated",
    payload: {
      taskId: "race-task",
      conversationId: "conversation-race",
      status: "succeeded",
      entityVersion: 2
    }
  });
  releaseScan([{ id: "race-task", status: "running", entityVersion: 1 }]);
  await refresh;

  assert.deepEqual(feed.tasks, []);
  assert.deepEqual(feed.terminalTasks, [{ taskId: "race-task", status: "succeeded" }]);
});

test("does not show a task in both active and terminal sections when snapshots disagree", async () => {
  const feed = new DesktopTaskNotificationFeed({
    getTasks: async (_conversationId, _cursor, status) =>
      status === "running"
        ? [{ id: "mixed-task", status: "running", entityVersion: 1 }]
        : [],
    getAllTasks: async () => [{ id: "mixed-task", status: "succeeded", entityVersion: 2 }],
    getUnreadNotifications: async () => [],
    markDelivered: async () => undefined,
    markRead: async () => undefined,
    dismiss: async () => undefined
  });

  await feed.refresh("conversation-mixed");

  assert.deepEqual(feed.tasks, []);
  assert.deepEqual(feed.terminalTasks, [{ taskId: "mixed-task", status: "succeeded" }]);
  assert.equal(feed.tasks.some((task: DesktopTask) =>
    feed.terminalTasks.some(state => state.taskId === task.id)), false);
});

test("does not re-add an active overlay after a newer terminal scan", async () => {
  let releaseScan!: (tasks: readonly DesktopTask[]) => void;
  const scan = new Promise<readonly DesktopTask[]>(resolve => { releaseScan = resolve; });
  const feed = new DesktopTaskNotificationFeed({
    getTasks: async () => [],
    getAllTasks: async () => scan,
    getUnreadNotifications: async () => [],
    markDelivered: async () => undefined,
    markRead: async () => undefined,
    dismiss: async () => undefined
  });
  feed.selectConversation("conversation-overlay");

  const refresh = feed.refresh("conversation-overlay");
  await feed.applyEvent({
    eventId: "overlay-running",
    occurredAt: 1,
    type: "task.updated",
    payload: {
      taskId: "overlay-task",
      conversationId: "conversation-overlay",
      status: "running",
      entityVersion: 1
    }
  });
  releaseScan([{ id: "overlay-task", status: "succeeded", entityVersion: 2 }]);
  await refresh;

  assert.deepEqual(feed.tasks, []);
  assert.deepEqual(feed.terminalTasks, [{ taskId: "overlay-task", status: "succeeded" }]);
});

test("retains a terminal event observed before an older refresh snapshot", async () => {
  const feed = new DesktopTaskNotificationFeed({
    getTasks: async (_conversationId, _cursor, status) =>
      status === "running"
        ? [{ id: "pre-refresh-terminal", status: "running", entityVersion: 1 }]
        : [],
    getAllTasks: async () => [{
      id: "pre-refresh-terminal",
      status: "running",
      entityVersion: 1
    }],
    getUnreadNotifications: async () => [],
    markDelivered: async () => undefined,
    markRead: async () => undefined,
    dismiss: async () => undefined
  });
  feed.selectConversation("conversation-pre-refresh-terminal");

  await feed.applyEvent({
    eventId: "pre-refresh-terminal-event",
    occurredAt: 2,
    type: "task.updated",
    payload: {
      taskId: "pre-refresh-terminal",
      conversationId: "conversation-pre-refresh-terminal",
      status: "succeeded",
      entityVersion: 2
    }
  });
  await feed.refresh("conversation-pre-refresh-terminal");

  assert.deepEqual(feed.tasks, []);
  assert.deepEqual(feed.terminalTasks, [{
    taskId: "pre-refresh-terminal",
    status: "succeeded"
  }]);
});

test("marks the bounded terminal window partial when a terminal event cannot fit", async () => {
  const feed = new DesktopTaskNotificationFeed({
    getTasks: async () => [],
    getAllTasks: async () => Array.from({ length: 256 }, (_, index) => ({
      id: `scanned-terminal-${index}`,
      status: "succeeded",
      entityVersion: 1
    })),
    getUnreadNotifications: async () => [],
    markDelivered: async () => undefined,
    markRead: async () => undefined,
    dismiss: async () => undefined
  });
  feed.selectConversation("conversation-terminal-bound");
  await feed.refresh("conversation-terminal-bound");

  await feed.applyEvent({
    eventId: "overflow-terminal-event",
    occurredAt: 2,
    type: "task.updated",
    payload: {
      taskId: "overflow-terminal",
      conversationId: "conversation-terminal-bound",
      status: "succeeded",
      entityVersion: 2
    }
  });

  assert.equal(feed.tasks.some(task => task.id === "overflow-terminal"), false);
  assert.equal(feed.terminalTasks.length, 256);
  assert.equal(feed.artifactRestoreStatus, "partial");
});

test("keeps terminal realtime updates out of active tasks and deduplicates the scanned identity", async () => {
  const feed = new DesktopTaskNotificationFeed({
    getTasks: async () => [],
    getAllTasks: async () => [{ id: "terminal-realtime", status: "succeeded" }],
    getUnreadNotifications: async () => [],
    markDelivered: async () => undefined,
    markRead: async () => undefined,
    dismiss: async () => undefined
  });
  feed.selectConversation("conversation-terminal");

  await feed.applyEvent({
    eventId: "terminal-realtime-started",
    occurredAt: 1,
    type: "task.updated",
    payload: {
      taskId: "terminal-realtime",
      conversationId: "conversation-terminal",
      status: "running",
      entityVersion: 1
    }
  });
  assert.deepEqual(feed.tasks.map(task => ({ id: task.id, status: task.status })), [
    { id: "terminal-realtime", status: "running" }
  ]);

  await feed.applyEvent({
    eventId: "terminal-realtime-finished",
    occurredAt: 2,
    type: "task.updated",
    payload: {
      taskId: "terminal-realtime",
      conversationId: "conversation-terminal",
      status: "succeeded",
      entityVersion: 2
    }
  });
  assert.deepEqual(feed.tasks, []);
  assert.deepEqual(feed.terminalTasks, [{ taskId: "terminal-realtime", status: "succeeded" }]);

  await feed.refresh("conversation-terminal");
  assert.deepEqual(feed.tasks, []);
  assert.deepEqual(feed.terminalTasks, [{ taskId: "terminal-realtime", status: "succeeded" }]);
});

test("bounds and replaces the terminal task window across repeated partial scans", async () => {
  const makePartialTasks = (prefix: string) => Array.from({ length: 257 }, (_, index) => ({
    id: `${prefix}-${index}`,
    status: "cancelled"
  }));
  let scanTasks = makePartialTasks("first-terminal");
  const feed = new DesktopTaskNotificationFeed({
    getTasks: async () => [],
    getAllTasks: async () => scanTasks,
    getUnreadNotifications: async () => [],
    markDelivered: async () => undefined,
    markRead: async () => undefined,
    dismiss: async () => undefined
  });

  await feed.refresh("conversation-terminal");
  assert.equal(feed.artifactRestoreStatus, "partial");
  assert.equal(feed.terminalTasks.length, 256);
  assert.equal(feed.terminalTasks.every(task => task.taskId.startsWith("first-terminal-")), true);

  scanTasks = makePartialTasks("second-terminal");
  await feed.refresh("conversation-terminal");
  assert.equal(feed.terminalTasks.length, 256);
  assert.equal(feed.terminalTasks.some(task => task.taskId === "first-terminal-0"), false);
  assert.equal(feed.terminalTasks.every(task => task.taskId.startsWith("second-terminal-")), true);
});

test("reports partial artifact recovery after a bounded scan failure", async () => {
  let scanCalls = 0;
  const feed = new DesktopTaskNotificationFeed({
    getTasks: async () => [],
    getAllTasks: async () => {
      scanCalls++;
      throw new Error("artifact scan unavailable");
    },
    getUnreadNotifications: async () => [],
    markDelivered: async () => undefined,
    markRead: async () => undefined,
    dismiss: async () => undefined
  });

  await feed.refresh("conversation-artifacts");

  assert.equal(scanCalls, 1);
  assert.equal(feed.artifactRestoreStatus, "partial");
  assert.deepEqual(feed.artifacts, []);
});

test("shows the safely recovered subset after a bounded partial artifact scan", async () => {
  const scannedTasks = Array.from({ length: 257 }, (_, index) => ({
    id: `terminal-task-${index}`,
    status: "succeeded",
    artifacts: [{
      size: index,
      sha256: index.toString(16).padStart(64, "0"),
      contentType: "application/json"
    }]
  }));
  const feed = new DesktopTaskNotificationFeed({
    getTasks: async () => [],
    getAllTasks: async () => scannedTasks,
    getUnreadNotifications: async () => [],
    markDelivered: async () => undefined,
    markRead: async () => undefined,
    dismiss: async () => undefined
  });

  await feed.refresh("conversation-artifacts");

  assert.equal(feed.artifactRestoreStatus, "partial");
  assert.equal(feed.artifacts.length, 256);
  assert.equal(feed.artifacts.every(state => state.status === "succeeded"
    && state.artifacts.length === 1), true);
});

test("replaces the artifact window across repeated partial scans without accumulating stale entries", async () => {
  const makePartialTasks = (prefix: string) => Array.from({ length: 257 }, (_, index) => ({
    id: `${prefix}-${index}`,
    status: "succeeded",
    artifacts: [{
      size: index,
      sha256: index.toString(16).padStart(64, "0"),
      contentType: "application/json"
    }]
  }));
  let scanTasks: Array<{
    id: string;
    status: string;
    artifacts: Array<{ size: number; sha256: string; contentType: string }>;
  }> = [{
    id: "complete-task",
    status: "succeeded",
    artifacts: [{ size: 1, sha256: "c".repeat(64), contentType: "application/json" }]
  }];
  const feed = new DesktopTaskNotificationFeed({
    getTasks: async () => [],
    getAllTasks: async () => scanTasks,
    getUnreadNotifications: async () => [],
    markDelivered: async () => undefined,
    markRead: async () => undefined,
    dismiss: async () => undefined
  });

  await feed.refresh("conversation-artifacts");
  assert.equal(feed.artifacts.length, 1);
  scanTasks = makePartialTasks("first-partial");
  await feed.refresh("conversation-artifacts");
  assert.equal(feed.artifactRestoreStatus, "partial");
  assert.equal(feed.artifacts.length, 256);
  assert.equal(feed.artifacts.some(state => state.taskId === "complete-task"), false);

  scanTasks = makePartialTasks("second-partial");
  await feed.refresh("conversation-artifacts");
  assert.equal(feed.artifacts.length, 256);
  assert.equal(feed.artifacts.some(state => state.taskId === "first-partial-0"), false);
  assert.equal(feed.artifacts.every(state => state.taskId.startsWith("second-partial-")), true);
});

test("applies a device completion artifact summary immediately without HTTP refresh or replay duplicates", async () => {
  const feed = new DesktopTaskNotificationFeed({
    getTasks: async () => { throw new Error("Unexpected HTTP refresh"); },
    getUnreadNotifications: async () => [],
    markDelivered: async () => undefined,
    markRead: async () => undefined,
    dismiss: async () => undefined
  });
  feed.selectConversation("conversation-artifacts");
  await feed.applyEvent({
    eventId: "device-task-created",
    occurredAt: 1,
    type: "task.updated",
    payload: { taskId: "device-task", conversationId: "conversation-artifacts", status: "running", entityVersion: 1 }
  });
  const completed = {
    eventId: "device-task-completed",
    occurredAt: 2,
    type: "task.updated",
    payload: {
      taskId: "device-task", status: "succeeded", entityVersion: 2,
      eventType: "task.completed", pendingUserInput: null,
      artifacts: [{ size: 42, sha256: "a".repeat(64), contentType: "text/plain" }]
    }
  };
  await feed.applyEvent(completed);
  await feed.applyEvent(completed);
  assert.equal(feed.tasks.length, 0);
  assert.deepEqual(feed.terminalTasks, [{ taskId: "device-task", status: "succeeded" }]);
  assert.deepEqual(feed.artifacts, [{
    taskId: "device-task", status: "succeeded",
    artifacts: [{ size: 42, sha256: "a".repeat(64), contentType: "text/plain" }]
  }]);
});

test("preserves known artifacts when a task event omits its manifest", async () => {
  const feed = new DesktopTaskNotificationFeed({
    getTasks: async () => [],
    getUnreadNotifications: async () => [],
    markDelivered: async () => undefined,
    markRead: async () => undefined,
    dismiss: async () => undefined
  });
  feed.selectConversation("conversation-artifacts");

  await feed.applyEvent({
    eventId: "artifact-created",
    occurredAt: 1,
    type: "task.updated",
    payload: {
      taskId: "terminal-task",
      conversationId: "conversation-artifacts",
      status: "succeeded",
      entityVersion: 1,
      artifacts: [{
        path: "/private/worker/report.json",
        size: 42,
        sha256: "a".repeat(64),
        contentType: "application/json"
      }]
    }
  });
  await feed.applyEvent({
    eventId: "artifact-status-only",
    occurredAt: 2,
    type: "task.updated",
    payload: {
      taskId: "terminal-task",
      conversationId: "conversation-artifacts",
      status: "succeeded",
      entityVersion: 2
    }
  });

  assert.deepEqual(feed.artifacts, [{
    taskId: "terminal-task",
    status: "succeeded",
    artifacts: [{ size: 42, sha256: "a".repeat(64), contentType: "application/json" }]
  }]);
  assert.equal(JSON.stringify(feed.artifacts).includes("/private/worker"), false);
});

test("does not publish a stale artifact scan across conversation binding epochs", async () => {
  let releaseOldScan!: () => void;
  let artifactScanCount = 0;
  const oldScanReady = new Promise<void>(resolve => { releaseOldScan = resolve; });
  const feed = new DesktopTaskNotificationFeed({
    getTasks: async () => [],
    getAllTasks: async conversationId => {
      if (conversationId === "conversation-a" && artifactScanCount++ === 0) {
        await oldScanReady;
        return [{
          id: "old-terminal-task",
          status: "succeeded",
          artifacts: [{ size: 1, sha256: "a".repeat(64), contentType: "text/plain" }]
        }];
      }
      return conversationId === "conversation-a"
        ? [{
          id: "new-terminal-task",
          status: "succeeded",
          artifacts: [{ size: 2, sha256: "b".repeat(64), contentType: "text/plain" }]
        }]
        : [];
    },
    getUnreadNotifications: async () => [],
    markDelivered: async () => undefined,
    markRead: async () => undefined,
    dismiss: async () => undefined
  });

  const oldRefresh = feed.refresh("conversation-a");
  await new Promise(resolve => setTimeout(resolve, 0));
  feed.selectConversation("conversation-b");
  await feed.refresh("conversation-b");
  feed.selectConversation("conversation-a");
  await feed.refresh("conversation-a");
  releaseOldScan();
  await oldRefresh;

  assert.deepEqual(feed.artifacts, [{
    taskId: "new-terminal-task",
    status: "succeeded",
    artifacts: [{ size: 2, sha256: "b".repeat(64), contentType: "text/plain" }]
  }]);
  assert.deepEqual(feed.terminalTasks, [{ taskId: "new-terminal-task", status: "succeeded" }]);
});

test("task events update only the fixed task projection and clear completed user input", async () => {
  const feed = new DesktopTaskNotificationFeed({
    getTasks: async () => [],
    getUnreadNotifications: async () => [],
    markDelivered: async () => undefined,
    markRead: async () => undefined,
    dismiss: async () => undefined
  });

  await feed.applyEvent({
    eventId: "task-input-required",
    occurredAt: 1,
    type: "task.updated",
    payload: {
      taskId: "task-input",
      status: "waitingForUserInput",
      pendingUserInput: {
        requestId: "99",
        itemId: "item-1",
        threadId: "thread-1",
        turnId: "turn-1",
        questions: [{ id: "q1", header: "Choice", question: "Choose one" }]
      },
      entityVersion: 7,
      providerRaw: { answers: { q1: { answers: ["raw"] } } }
    }
  });
  assert.equal(feed.tasks[0]?.pendingUserInput?.requestId, "99");
  assert.equal(feed.tasks[0]?.entityVersion, 7);
  assert.equal("providerRaw" in (feed.tasks[0] ?? {}), false);

  await feed.applyEvent({
    eventId: "task-input-answered",
    occurredAt: 2,
    type: "task.updated",
    payload: {
      taskId: "task-input",
      status: "running",
      pendingUserInput: null,
      entityVersion: 8,
      providerRaw: { answers: { q1: { answers: ["raw"] } } }
    }
  });
  assert.equal(feed.tasks[0]?.pendingUserInput, undefined);
  assert.equal(feed.tasks[0]?.status, "running");

  await feed.applyEvent({
    eventId: "task-input-late-required",
    occurredAt: 3,
    type: "task.updated",
    payload: {
      taskId: "task-input",
      status: "waitingForUserInput",
      pendingUserInput: {
        requestId: "late",
        itemId: "late-item",
        threadId: "late-thread",
        turnId: "late-turn",
        questions: [{ id: "q1", header: "Late", question: "Should not render" }]
      },
      entityVersion: 7
    }
  });
  assert.equal(feed.tasks[0]?.status, "running");
  assert.equal(feed.tasks[0]?.pendingUserInput, undefined);

  const recoveringProjection = desktopTaskFrom({
    id: "task-recovering",
    status: "recovering",
    pendingUserInput: {
      requestId: "recovery-input",
      itemId: "recovery-item",
      threadId: "recovery-thread",
      turnId: "recovery-turn",
      questions: [{ id: "q1", header: "Recovery", question: "Should stay hidden" }],
      entityVersion: 9
    }
  });
  assert.equal(recoveringProjection?.pendingUserInput, undefined);

  await feed.applyEvent({
    eventId: "task-input-reclaimed",
    occurredAt: 4,
    type: "task.updated",
    payload: {
      taskId: "task-input",
      status: "waitingForUserInput",
      pendingUserInput: {
        requestId: "reclaimed",
        itemId: "reclaimed-item",
        threadId: "reclaimed-thread",
        turnId: "reclaimed-turn",
        questions: [{ id: "q1", header: "Reclaimed", question: "Answer after recovery" }]
      },
      entityVersion: 9
    }
  });
  const reclaimedTask = feed.tasks[0];
  assert.equal(reclaimedTask?.status, "waitingForUserInput");
  assert.equal(reclaimedTask?.pendingUserInput?.requestId, "reclaimed");
  await feed.applyEvent({
    eventId: "task-input-recovery-stale",
    occurredAt: 5,
    type: "task.updated",
    payload: {
      taskId: "task-input",
      status: "recovering",
      pendingUserInput: null,
      entityVersion: 8
    }
  });
  const taskAfterStaleRecovery = feed.tasks[0];
  assert.equal(taskAfterStaleRecovery?.status, "waitingForUserInput");
  assert.equal(taskAfterStaleRecovery?.pendingUserInput?.requestId, "reclaimed");
});

test("refreshes durable tasks and unread notifications and deduplicates notification events", async () => {
  const calls: string[] = [];
  const feed = new DesktopTaskNotificationFeed({
    getTasks: async (conversationId, _cursor, status) => {
      calls.push(`tasks:${conversationId}:${status}`);
      return [{ id: "task-1", status: "running", goal: "分析" }];
    },
    getUnreadNotifications: async () => {
      calls.push("notifications:global");
      return [{ id: "notification-1", status: "pending", title: "完成", body: "结果" }];
    },
    markDelivered: async (id, key) => calls.push(`delivered:${id}:${key}`),
    markRead: async id => calls.push(`read:${id}`),
    dismiss: async id => calls.push(`dismiss:${id}`)
  });

  await feed.refresh("conversation-1");
  await feed.applyEvent({
    eventId: "event-1",
    occurredAt: 1,
    type: "notification.created",
    payload: { id: "notification-1", status: "pending", title: "完成", body: "结果" }
  });
  await feed.applyEvent({
    eventId: "event-2",
    occurredAt: 2,
    type: "notification.created",
    payload: { id: "notification-1", status: "pending", title: "重复", body: "重复" }
  });

  assert.equal(calls.filter(call => call.startsWith("tasks:conversation-1:")).length,
    nonTerminalTaskStatuses.length);
  assert.equal(calls.includes("notifications:global"), true);
  assert.equal(feed.tasks.length, 1);
  assert.equal(feed.notifications.length, 1);
  assert.equal(feed.notifications[0]?.title, "完成");
  assert.equal(feed.notifications[0]?.status, "delivered");
  assert.equal(calls.filter(call => call.startsWith("delivered:")).length, 1);
  assert.equal(calls.find(call => call.startsWith("delivered:")),
    "delivered:notification-1:notification-delivered:notification-1");

  await feed.read("notification-1");
  await feed.dismiss("notification-1");
  assert.deepEqual(calls.slice(-2), ["read:notification-1", "dismiss:notification-1"]);
});

test("keeps a failed delivered receipt pending and retries it on the next refresh", async () => {
  let failDelivery = true;
  const deliveredKeys: string[] = [];
  const feed = new DesktopTaskNotificationFeed({
    getTasks: async () => [],
    getUnreadNotifications: async () => [
      { id: "notification-retry", status: "pending", title: "稍后", body: "重试" }
    ],
    markDelivered: async (_id, key) => {
      deliveredKeys.push(key);
      if (failDelivery) {
        throw new Error("offline");
      }
    },
    markRead: async () => undefined,
    dismiss: async () => undefined
  });

  await feed.refresh("conversation-offline");
  assert.equal(feed.notifications[0]?.status, "pending");
  failDelivery = false;
  await feed.refresh("conversation-offline");

  assert.equal(feed.notifications[0]?.status, "delivered");
  assert.deepEqual(deliveredKeys, [
    "notification-delivered:notification-retry",
    "notification-delivered:notification-retry"
  ]);
});

test("routes concurrent delivered receipts through the action runner and exposes retry state", async () => {
  let failDelivery = true;
  const deliveredKeys: string[] = [];
  const states: Array<{ key: string; status: string; message?: string }> = [];
  const runner = new DesktopActionRunner({
    createIdempotencyKey: key => `runner:${key}`,
    onStateChange: state => states.push(state)
  });
  const backend = {
    getTasks: async () => [],
    getUnreadNotifications: async () => [
      { id: "notification-runner", status: "pending", title: "送达", body: "结果" }
    ],
    markDelivered: async (_notificationId: string, idempotencyKey: string) => {
      deliveredKeys.push(idempotencyKey);
      if (failDelivery) {
        throw createDesktopActionFailure("retryable", "backend_unavailable");
      }
    },
    markRead: async () => undefined,
    dismiss: async () => undefined,
    runAction: <T>(key: string, execute: (idempotencyKey: string) => Promise<T>) =>
      runner.run(key, execute)
  };
  const feed = new DesktopTaskNotificationFeed(backend);

  await Promise.all([
    feed.refresh("conversation-runner"),
    feed.refresh("conversation-runner")
  ]);
  assert.equal(feed.notifications[0]?.status, "pending");
  failDelivery = false;
  await feed.refresh("conversation-runner");

  assert.equal(feed.notifications[0]?.status, "delivered");
  assert.deepEqual(deliveredKeys, [
    "runner:notification-delivered:notification-runner",
    "runner:notification-delivered:notification-runner"
  ]);
  assert.deepEqual(states
    .filter(state => state.key === "notification-delivered:notification-runner")
    .map(state => state.status), ["pending", "retryable", "pending", "succeeded"]);
  assert.equal(states.some(state => state.message?.includes("scenario-client-secret")), false);
});

test("keeps a terminal delivered receipt pending without duplicate backend calls", async () => {
  let deliveryCalls = 0;
  const states: Array<{ key: string; status: string }> = [];
  const runner = new DesktopActionRunner({
    createIdempotencyKey: key => `runner:${key}`,
    onStateChange: state => states.push({ key: state.key, status: state.status })
  });
  const backend = {
    getTasks: async () => [],
    getUnreadNotifications: async () => [
      { id: "notification-terminal", status: "pending", title: "送达失败", body: "结果" }
    ],
    markDelivered: async () => {
      deliveryCalls++;
      throw createDesktopActionFailure("terminal", "invalid_input");
    },
    markRead: async () => undefined,
    dismiss: async () => undefined,
    runAction: <T>(key: string, execute: (idempotencyKey: string) => Promise<T>) =>
      runner.run(key, execute)
  };
  const feed = new DesktopTaskNotificationFeed(backend);

  await feed.refresh("conversation-terminal");
  await feed.refresh("conversation-terminal");

  assert.equal(feed.notifications[0]?.status, "pending");
  assert.equal(deliveryCalls, 1);
  assert.deepEqual(states, [
    { key: "notification-delivered:notification-terminal", status: "pending" },
    { key: "notification-delivered:notification-terminal", status: "terminal" }
  ]);
});

test("retries read with the same notification action idempotency key after a lost response", async () => {
  let failOnce = true;
  const keys: string[] = [];
  const feed = new DesktopTaskNotificationFeed({
    getTasks: async () => [],
    getUnreadNotifications: async () => [],
    markDelivered: async () => undefined,
    markRead: async (_notificationId, key) => {
      keys.push(key);
      if (failOnce) {
        failOnce = false;
        throw new Error("response lost after commit");
      }
    },
    dismiss: async () => undefined
  });

  await feed.applyEvent({
    eventId: "notification-read-retry",
    occurredAt: 1,
    type: "notification.created",
    payload: { notificationId: "notification-read-retry", status: "pending", title: "读", body: "重试" }
  });
  await assert.rejects(() => feed.read("notification-read-retry"), /response lost/);
  await feed.read("notification-read-retry");

  assert.deepEqual(keys, [
    notificationActionIdempotencyKey("notification-read-retry", "read"),
    notificationActionIdempotencyKey("notification-read-retry", "read")
  ]);
  assert.deepEqual(feed.notifications, []);
});

test("retries dismiss with the same notification action idempotency key after a lost response", async () => {
  let failOnce = true;
  const keys: string[] = [];
  const feed = new DesktopTaskNotificationFeed({
    getTasks: async () => [],
    getUnreadNotifications: async () => [],
    markDelivered: async () => undefined,
    markRead: async () => undefined,
    dismiss: async (_notificationId, key) => {
      keys.push(key);
      if (failOnce) {
        failOnce = false;
        throw new Error("response lost after commit");
      }
    }
  });

  await feed.applyEvent({
    eventId: "notification-dismiss-retry",
    occurredAt: 1,
    type: "notification.created",
    payload: { notificationId: "notification-dismiss-retry", status: "pending", title: "忽略", body: "重试" }
  });
  await assert.rejects(() => feed.dismiss("notification-dismiss-retry"), /response lost/);
  await feed.dismiss("notification-dismiss-retry");

  assert.deepEqual(keys, [
    notificationActionIdempotencyKey("notification-dismiss-retry", "dismiss"),
    notificationActionIdempotencyKey("notification-dismiss-retry", "dismiss")
  ]);
  assert.deepEqual(feed.notifications, []);
});

test("acknowledges only an offered notification and retries with the same bounded key", async () => {
  let failOnce = true;
  const keys: string[] = [];
  const feed = new DesktopTaskNotificationFeed({
    getTasks: async () => [],
    getUnreadNotifications: async () => [],
    markDelivered: async () => undefined,
    markRead: async () => undefined,
    dismiss: async () => undefined,
    applyAction: async (_notificationId, actionId, key) => {
      assert.equal(actionId, "acknowledge");
      keys.push(key);
      if (failOnce) {
        failOnce = false;
        throw new Error("response lost after commit");
      }
    }
  });

  await feed.applyEvent({
    eventId: "notification-acknowledge-retry",
    occurredAt: 1,
    type: "notification.created",
    payload: {
      notificationId: "notification-acknowledge-retry",
      status: "pending",
      title: "完成",
      body: "结果",
      actionsJson: '["acknowledge"]'
    }
  });
  await assert.rejects(() => feed.acknowledge("notification-acknowledge-retry"), /response lost/);
  await feed.acknowledge("notification-acknowledge-retry");

  assert.deepEqual(keys, [
    notificationActionIdempotencyKey("notification-acknowledge-retry", "acknowledge"),
    notificationActionIdempotencyKey("notification-acknowledge-retry", "acknowledge")
  ]);
  assert.ok(keys[0]!.length <= 200);
  assert.deepEqual(feed.notifications, []);
});

test("fails closed when a notification does not offer acknowledge", async () => {
  let calls = 0;
  const feed = new DesktopTaskNotificationFeed({
    getTasks: async () => [],
    getUnreadNotifications: async () => [],
    markDelivered: async () => undefined,
    markRead: async () => undefined,
    dismiss: async () => undefined,
    applyAction: async () => {
      calls++;
    }
  });
  await feed.applyEvent({
    eventId: "notification-untrusted-action",
    occurredAt: 1,
    type: "notification.created",
    payload: {
      notificationId: "notification-untrusted-action",
      status: "pending",
      title: "不可信动作",
      body: "",
      actionsJson: '["run-command"]'
    }
  });

  await assert.rejects(() => feed.acknowledge("notification-untrusted-action"), /does not offer/);
  assert.equal(calls, 0);
});

test("deduplicates SignalR notification ids while delivering a pending notification once", async () => {
  let deliveryCalls = 0;
  const feed = new DesktopTaskNotificationFeed({
    getTasks: async () => [],
    getUnreadNotifications: async () => [],
    markDelivered: async () => {
      deliveryCalls++;
    },
    markRead: async () => undefined,
    dismiss: async () => undefined
  });

  const event = {
    eventId: "event-notification-1",
    occurredAt: 1,
    type: "notification.created",
    payload: { notificationId: "notification-signalr", status: "pending", title: "完成", body: "实时" }
  } as const;
  await feed.applyEvent(event);
  await feed.applyEvent({ ...event, eventId: "event-notification-2" });

  assert.equal(deliveryCalls, 1);
  assert.equal(feed.notifications.length, 1);
  assert.equal(feed.notifications[0]?.id, "notification-signalr");
  assert.equal(feed.currentNotification?.id, "notification-signalr");
  assert.equal(feed.notifications[0]?.status, "delivered");
});

test("refreshes on connected only and pulls offline notifications after reconnect", async () => {
  assert.deepEqual(nonTerminalTaskStatuses, [
    "queued",
    "assigned",
    "running",
    "waitingForApproval",
    "waitingForUserInput",
    "recovering",
    "cancellationRequested"
  ]);
  const taskConversations: string[] = [];
  let notificationRefreshes = 0;
  const deliveredKeys: string[] = [];
  let offlineNotificationAvailable = false;
  const feed = new DesktopTaskNotificationFeed({
    getTasks: async (conversationId, _cursor, status) => {
      taskConversations.push(`${conversationId}:${status}`);
      return [{ id: "task-reconnected", status: "running", goal: "继续" }];
    },
    getUnreadNotifications: async () => {
      notificationRefreshes++;
      return offlineNotificationAvailable
        ? [{ id: "notification-offline", status: "pending", title: "离线完成", body: "已补拉" }]
        : [];
    },
    markDelivered: async (_notificationId, key) => {
      deliveredKeys.push(key);
    },
    markRead: async () => undefined,
    dismiss: async () => undefined
  });
  const refresh = (conversationId?: string) => feed.refresh(conversationId);

  assert.equal(await refreshOnBackendConnectionState("disconnected", refresh, "conversation-1"), false);
  assert.equal(await refreshOnBackendConnectionState("reconnecting", refresh, "conversation-1"), false);
  assert.deepEqual(taskConversations, []);
  assert.equal(notificationRefreshes, 0);

  assert.equal(await refreshOnBackendConnectionState("connected", refresh, "conversation-1"), true);
  assert.deepEqual(taskConversations, nonTerminalTaskStatuses.map(status => `conversation-1:${status}`));
  assert.equal(notificationRefreshes, 1);
  assert.equal(feed.notifications.length, 0);

  offlineNotificationAvailable = true;
  assert.equal(await refreshOnBackendConnectionState("connected", refresh, "conversation-2"), true);
  assert.deepEqual(taskConversations, [
    ...nonTerminalTaskStatuses.map(status => `conversation-1:${status}`),
    ...nonTerminalTaskStatuses.map(status => `conversation-2:${status}`)
  ]);
  assert.equal(notificationRefreshes, 2);
  assert.equal(feed.notifications[0]?.id, "notification-offline");
  assert.equal(feed.notifications[0]?.status, "delivered");
  assert.deepEqual(deliveredKeys, ["notification-delivered:notification-offline"]);
});

test("keeps newer realtime terminal overlays when an older refresh snapshot resolves", async () => {
  const resolveTasks: ((tasks: readonly DesktopTask[]) => void)[] = [];
  let resolveNotifications: ((notifications: readonly DesktopNotification[]) => void) | undefined;
  const delivered: string[] = [];
  const feed = new DesktopTaskNotificationFeed({
    getTasks: async () => new Promise(resolve => { resolveTasks.push(resolve); }),
    getUnreadNotifications: async () => new Promise(resolve => { resolveNotifications = resolve; }),
    markDelivered: async notificationId => { delivered.push(notificationId); },
    markRead: async () => undefined,
    dismiss: async () => undefined
  });

  const refresh = feed.refresh("conversation-race");
  await feed.applyEvent({
    eventId: "task-newer",
    occurredAt: 200,
    type: "task.updated",
    payload: {
      taskId: "task-race",
      conversationId: "conversation-race",
      status: "succeeded",
      resultSummary: "新结果"
    }
  });
  await feed.applyEvent({
    eventId: "notification-newer",
    occurredAt: 200,
    type: "notification.created",
    payload: {
      notificationId: "notification-race",
      status: "pending",
      title: "新通知",
      body: "重连后仍显示"
    }
  });

  for (const resolve of resolveTasks) {
    resolve([{ id: "task-race", status: "running", resultSummary: "旧结果" }]);
  }
  resolveNotifications?.([]);
  await refresh;

  assert.deepEqual(feed.tasks, []);
  assert.deepEqual(feed.terminalTasks, [{ taskId: "task-race", status: "succeeded" }]);
  assert.equal(feed.currentNotification?.id, "notification-race");
  assert.equal(feed.currentNotification?.status, "delivered");
  assert.deepEqual(delivered, ["notification-race"]);
});

test("switching conversations clears task state, keeps global notifications, and filters scoped events", async () => {
  let taskRefreshes = 0;
  const feed = new DesktopTaskNotificationFeed({
    getTasks: async conversationId => {
      taskRefreshes++;
      return conversationId === "conversation-new"
        ? [{ id: "task-new", status: "running", entityVersion: 1 }]
        : conversationId === "conversation-old"
          ? [{ id: "task-old", status: "running", entityVersion: 1 }]
          : [];
    },
    getUnreadNotifications: async () => [{
      id: "notification-global",
      status: "delivered",
      title: "全局通知",
      body: "设备范围"
    }],
    markDelivered: async () => undefined,
    markRead: async () => undefined,
    dismiss: async () => undefined
  });

  await feed.refresh("conversation-old");
  assert.equal(feed.hasTask("task-old"), true);
  assert.equal(feed.notifications[0]?.id, "notification-global");

  const oldBinding = feed.captureConversationBinding();
  feed.selectConversation("conversation-new");
  assert.deepEqual(feed.tasks, []);
  assert.equal(feed.notifications[0]?.id, "notification-global");
  assert.equal(feed.hasTask("task-old", oldBinding), false);

  await feed.applyEvent({
    eventId: "late-old-task",
    occurredAt: 2,
    type: "task.updated",
    payload: {
      taskId: "task-old",
      conversationId: "conversation-old",
      status: "succeeded",
      entityVersion: 2
    }
  }, feed.captureConversationBinding());
  assert.deepEqual(feed.tasks, []);

  await feed.applyEvent({
    eventId: "new-task-without-scope",
    occurredAt: 3,
    type: "task.updated",
    payload: { taskId: "task-new", status: "succeeded", entityVersion: 2 }
  });
  assert.deepEqual([...feed.tasks].map((task: DesktopTask) => task.id), ["task-new"]);
  assert.ok(taskRefreshes > nonTerminalTaskStatuses.length);
});

test("does not publish a late old conversation refresh after the same feed switches", async () => {
  let releaseOldRefresh!: () => void;
  const oldRefreshReady = new Promise<void>(resolve => { releaseOldRefresh = resolve; });
  const appliedTaskIds: string[] = [];
  const feed = new DesktopTaskNotificationFeed({
    getTasks: async conversationId => {
      if (conversationId === "conversation-old") {
        await oldRefreshReady;
      }
      return conversationId === "conversation-new"
        ? [{ id: "task-new", status: "running" }]
        : [{ id: "task-old", status: "running" }];
    },
    getUnreadNotifications: async () => [],
    markDelivered: async () => undefined,
    markRead: async () => undefined,
    dismiss: async () => undefined
  });

  const oldRefresh = refreshFeedIfCurrent(
    feed,
    () => feed,
    tasks => appliedTaskIds.push(...tasks.map(task => task.id)),
    "conversation-old");
  await new Promise(resolve => setTimeout(resolve, 0));
  feed.selectConversation("conversation-new");
  await refreshFeedIfCurrent(
    feed,
    () => feed,
    tasks => appliedTaskIds.push(...tasks.map(task => task.id)),
    "conversation-new");
  releaseOldRefresh();
  await oldRefresh;

  assert.deepEqual(appliedTaskIds, ["task-new"]);
  assert.deepEqual([...feed.tasks].map((task: DesktopTask) => task.id), ["task-new"]);
});

test("ignores an older task event after a newer terminal event", async () => {
  const feed = new DesktopTaskNotificationFeed({
    getTasks: async () => [],
    getUnreadNotifications: async () => [],
    markDelivered: async () => undefined,
    markRead: async () => undefined,
    dismiss: async () => undefined
  });

  await feed.applyEvent({
    eventId: "task-latest",
    occurredAt: 200,
    type: "task.updated",
    payload: { taskId: "task-order", status: "succeeded", resultSummary: "最新" }
  });
  await feed.applyEvent({
    eventId: "task-stale",
    occurredAt: 100,
    type: "task.updated",
    payload: { taskId: "task-order", status: "running", resultSummary: "过期" }
  });

  assert.deepEqual(feed.tasks, []);
  assert.deepEqual(feed.terminalTasks, [{ taskId: "task-order", status: "succeeded" }]);
});

test("refresh removes entities omitted by the server when no realtime event changed them", async () => {
  let includeSnapshot = true;
  const feed = new DesktopTaskNotificationFeed({
    getTasks: async () => includeSnapshot ? [{ id: "task-stale", status: "running" }] : [],
    getUnreadNotifications: async () => includeSnapshot
      ? [{ id: "notification-stale", status: "delivered", title: "旧", body: "旧" }]
      : [],
    markDelivered: async () => undefined,
    markRead: async () => undefined,
    dismiss: async () => undefined
  });

  await feed.refresh();
  includeSnapshot = false;
  await feed.refresh();

  assert.deepEqual(feed.tasks, []);
  assert.deepEqual(feed.notifications, []);
});

test("drops event-only active and terminal states after a complete empty scan", async () => {
  for (const [taskId, status] of [
    ["event-active-complete-empty", "running"],
    ["event-terminal-complete-empty", "succeeded"]
  ] as const) {
    const feed = new DesktopTaskNotificationFeed({
      getTasks: async () => [],
      getAllTasks: async () => [],
      getUnreadNotifications: async () => [],
      markDelivered: async () => undefined,
      markRead: async () => undefined,
      dismiss: async () => undefined
    });

    await feed.refresh("conversation-complete-empty");
    await feed.applyEvent({
      eventId: `${taskId}-event`,
      occurredAt: 1,
      type: "task.updated",
      payload: {
        taskId,
        conversationId: "conversation-complete-empty",
        status,
        entityVersion: 1
      }
    });

    assert.equal(feed.tasks.some(task => task.id === taskId), status === "running");
    assert.equal(feed.terminalTasks.some(task => task.taskId === taskId), status === "succeeded");

    await feed.refresh("conversation-complete-empty");
    assert.equal(feed.tasks.some(task => task.id === taskId), false);
    assert.equal(feed.terminalTasks.some(task => task.taskId === taskId), false);

    await feed.refresh("conversation-complete-empty");
    assert.equal(feed.tasks.some(task => task.id === taskId), false);
    assert.equal(feed.terminalTasks.some(task => task.taskId === taskId), false);
  }
});

test("retains event-only state across a partial no-status scan", async () => {
  const feed = new DesktopTaskNotificationFeed({
    getTasks: async () => [],
    getAllTasks: async () => Array.from({ length: 257 }, (_, index) => ({
      id: `partial-terminal-${index}`,
      status: "succeeded"
    })),
    getUnreadNotifications: async () => [],
    markDelivered: async () => undefined,
    markRead: async () => undefined,
    dismiss: async () => undefined
  });

  await feed.refresh("conversation-partial-event");
  await feed.applyEvent({
    eventId: "partial-event-active",
    occurredAt: 1,
    type: "task.updated",
    payload: {
      taskId: "partial-event-active",
      conversationId: "conversation-partial-event",
      status: "running",
      entityVersion: 1
    }
  });

  await feed.refresh("conversation-partial-event");

  assert.deepEqual(feed.tasks.map(task => task.id), ["partial-event-active"]);
  assert.equal(feed.terminalTasks.length, 256);
  assert.equal(feed.artifactRestoreStatus, "partial");
});

test("does not resurrect a notification read or dismissed while refresh snapshot is pending", async () => {
  for (const action of ["read", "dismiss"] as const) {
    let resolveNotifications: ((notifications: readonly DesktopNotification[]) => void) | undefined;
    const feed = new DesktopTaskNotificationFeed({
      getTasks: async () => [],
      getUnreadNotifications: async () => new Promise(resolve => { resolveNotifications = resolve; }),
      markDelivered: async () => undefined,
      markRead: async () => undefined,
      dismiss: async () => undefined
    });

    const refresh = feed.refresh(`conversation-${action}`);
    await feed.applyEvent({
      eventId: `notification-${action}`,
      occurredAt: 100,
      type: "notification.created",
      payload: {
        notificationId: `notification-${action}`,
        status: "pending",
        title: "待处理",
        body: "旧快照不应复活"
      }
    });
    if (action === "read") {
      await feed.read(`notification-${action}`);
    } else {
      await feed.dismiss(`notification-${action}`);
    }

    resolveNotifications?.([{
      id: `notification-${action}`,
      status: "pending",
      title: "旧快照",
      body: "不应复活"
    }]);
    await refresh;
    assert.deepEqual(feed.notifications, [], action);
  }
});

test("does not resurrect a notification deleted by a terminal realtime event", async () => {
  let resolveNotifications: ((notifications: readonly DesktopNotification[]) => void) | undefined;
  const feed = new DesktopTaskNotificationFeed({
    getTasks: async () => [],
    getUnreadNotifications: async () => new Promise(resolve => { resolveNotifications = resolve; }),
    markDelivered: async () => undefined,
    markRead: async () => undefined,
    dismiss: async () => undefined
  });

  const refresh = feed.refresh("conversation-terminal-delete");
  await feed.applyEvent({
    eventId: "notification-created-before-refresh",
    occurredAt: 100,
    type: "notification.created",
    payload: {
      notificationId: "notification-terminal-delete",
      status: "pending",
      title: "完成",
      body: "稍后关闭"
    }
  });
  await feed.applyEvent({
    eventId: "notification-dismissed-during-refresh",
    occurredAt: 200,
    type: "notification.updated",
    payload: {
      notificationId: "notification-terminal-delete",
      status: "dismissed",
      action: "dismiss"
    }
  });

  resolveNotifications?.([{
    id: "notification-terminal-delete",
    status: "delivered",
    title: "旧快照",
    body: "不应复活"
  }]);
  await refresh;
  assert.deepEqual(feed.notifications, []);
});

test("retains read tombstones across a clean refresh and rejects a stale created event", async () => {
  let includeSnapshot = true;
  const feed = new DesktopTaskNotificationFeed({
    getTasks: async () => [],
    getUnreadNotifications: async () => includeSnapshot
      ? [{ id: "notification-read-watermark", status: "pending", title: "旧", body: "旧", entityVersion: 0 }]
      : [],
    markDelivered: async () => undefined,
    markRead: async () => undefined,
    dismiss: async () => undefined
  });

  await feed.refresh();
  await feed.read("notification-read-watermark");
  includeSnapshot = false;
  await feed.refresh();
  await feed.applyEvent({
    eventId: "notification-read-stale-created",
    occurredAt: 999,
    type: "notification.created",
    payload: {
      notificationId: "notification-read-watermark",
      status: "pending",
      entityVersion: 0
    }
  });

  assert.deepEqual(feed.notifications, []);
});

test("retains a terminal notification tombstone across refresh and accepts a newer version", async () => {
  let includeSnapshot = true;
  const feed = new DesktopTaskNotificationFeed({
    getTasks: async () => [],
    getUnreadNotifications: async () => includeSnapshot
      ? [{ id: "notification-terminal-watermark", status: "pending", title: "旧", body: "旧", entityVersion: 0 }]
      : [],
    markDelivered: async () => undefined,
    markRead: async () => undefined,
    dismiss: async () => undefined
  });

  await feed.refresh();
  await feed.applyEvent({
    eventId: "notification-terminal-v1",
    occurredAt: 100,
    type: "notification.updated",
    payload: {
      notificationId: "notification-terminal-watermark",
      status: "dismissed",
      action: "dismiss",
      entityVersion: 1
    }
  });
  includeSnapshot = false;
  await feed.refresh();
  await feed.applyEvent({
    eventId: "notification-terminal-stale-v0",
    occurredAt: 200,
    type: "notification.created",
    payload: {
      notificationId: "notification-terminal-watermark",
      status: "pending",
      entityVersion: 0
    }
  });
  assert.deepEqual(feed.notifications, []);

  await feed.applyEvent({
    eventId: "notification-terminal-new-v2",
    occurredAt: 201,
    type: "notification.created",
    payload: {
      notificationId: "notification-terminal-watermark",
      status: "pending",
      title: "新",
      body: "新",
      entityVersion: 2
    }
  });
  const notifications = feed.notifications;
  assert.equal(notifications.length, 1);
  assert.match(JSON.stringify(notifications), /新/);
});

test("seeds task snapshot entity version before accepting realtime events", async () => {
  const feed = new DesktopTaskNotificationFeed({
    getTasks: async () => [{ id: "task-snapshot-watermark", status: "running", entityVersion: 2 }],
    getUnreadNotifications: async () => [],
    markDelivered: async () => undefined,
    markRead: async () => undefined,
    dismiss: async () => undefined
  });

  await feed.refresh();
  await feed.applyEvent({
    eventId: "task-snapshot-stale-event",
    occurredAt: 999,
    type: "task.updated",
    payload: { taskId: "task-snapshot-watermark", status: "queued", entityVersion: 1 }
  });

  assert.equal(feed.tasks[0]?.status, "running");
});

test("does not roll a newer task back when a later HTTP snapshot is stale", async () => {
  const feed = new DesktopTaskNotificationFeed({
    getTasks: async () => [{ id: "task-refresh-watermark", status: "running", entityVersion: 2 }],
    getUnreadNotifications: async () => [],
    markDelivered: async () => undefined,
    markRead: async () => undefined,
    dismiss: async () => undefined
  });

  await feed.refresh();
  await feed.applyEvent({
    eventId: "task-refresh-newer",
    occurredAt: 100,
    type: "task.updated",
    payload: { taskId: "task-refresh-watermark", status: "succeeded", entityVersion: 3 }
  });
  await feed.refresh();

  assert.deepEqual(feed.tasks, []);
  assert.deepEqual(feed.terminalTasks, [{ taskId: "task-refresh-watermark", status: "succeeded" }]);
});

test("orders same-millisecond task events by entity version", async () => {
  const feed = new DesktopTaskNotificationFeed({
    getTasks: async () => [],
    getUnreadNotifications: async () => [],
    markDelivered: async () => undefined,
    markRead: async () => undefined,
    dismiss: async () => undefined
  });

  await feed.applyEvent({
    eventId: "task-running-v2",
    occurredAt: 1_000,
    type: "task.updated",
    payload: { taskId: "task-versioned", status: "running", entityVersion: 2 }
  });
  await feed.applyEvent({
    eventId: "task-succeeded-v3",
    occurredAt: 1_000,
    type: "task.updated",
    payload: { taskId: "task-versioned", status: "succeeded", entityVersion: 3 }
  });
  await feed.applyEvent({
    eventId: "task-late-running-v2",
    occurredAt: 1_001,
    type: "task.updated",
    payload: { taskId: "task-versioned", status: "running", entityVersion: 2 }
  });

  assert.deepEqual(feed.tasks, []);
  assert.deepEqual(feed.terminalTasks, [{ taskId: "task-versioned", status: "succeeded" }]);
});

test("collects all task pages and rejects a repeated cursor", async () => {
  const calls: (string | undefined)[] = [];
  const tasks = await collectTaskPages(async cursor => {
    calls.push(cursor);
    if (cursor === undefined) {
      return { items: [{ id: "task-1", status: "queued" }], nextCursor: "cursor-1" };
    }
    if (cursor === "cursor-1") {
      return { items: [{ id: "task-2", status: "queued" }], nextCursor: "cursor-2" };
    }
    return { items: [{ id: "task-3", status: "queued" }], nextCursor: null };
  });

  assert.deepEqual(calls, [undefined, "cursor-1", "cursor-2"]);
  assert.deepEqual(tasks.map(task => task.id), ["task-1", "task-2", "task-3"]);

  await assert.rejects(
    () => collectTaskPages(async () => ({
      items: [],
      nextCursor: "same-cursor"
    })),
    /repeated cursor/);
});

test("collects more than one hundred pages without truncating the authoritative feed", async () => {
  const tasks = await collectTaskPages(async cursor => {
    const page = cursor ? Number(cursor) : 0;
    return {
      items: [{ id: `task-page-${page}`, status: "running" }],
      nextCursor: page === 100 ? null : String(page + 1)
    };
  });

  assert.equal(tasks.length, 101);
  assert.equal(tasks[100]?.id, "task-page-100");
});

test("bounds version tracking and refreshes before applying an evicted late event", async () => {
  let taskRefreshes = 0;
  let notificationRefreshes = 0;
  const feed = new DesktopTaskNotificationFeed({
    getTasks: async () => {
      taskRefreshes++;
      return [];
    },
    getUnreadNotifications: async () => {
      notificationRefreshes++;
      return [];
    },
    markDelivered: async () => undefined,
    markRead: async () => undefined,
    dismiss: async () => undefined
  });

  for (let index = 0; index <= maxTrackedFeedEntities; index++) {
    await feed.applyEvent({
      eventId: `task-event-${index}`,
      occurredAt: index,
      type: "task.updated",
      payload: { taskId: `task-${index}`, status: "running", entityVersion: index }
    });
  }
  await feed.applyEvent({
    eventId: "task-late-evicted",
    occurredAt: 0,
    type: "task.updated",
    payload: { taskId: "task-0", status: "running", entityVersion: 0 }
  });

  for (let index = 0; index <= maxTrackedFeedEntities; index++) {
    await feed.applyEvent({
      eventId: `notification-created-${index}`,
      occurredAt: index,
      type: "notification.created",
      payload: {
        notificationId: `notification-${index}`,
        status: "pending",
        title: "通知",
        body: "通知",
        entityVersion: 0
      }
    });
    await feed.applyEvent({
      eventId: `notification-read-${index}`,
      occurredAt: index + 1,
      type: "notification.updated",
      payload: {
        notificationId: `notification-${index}`,
        status: "read",
        entityVersion: 1
      }
    });
  }
  await feed.applyEvent({
    eventId: "notification-late-evicted",
    occurredAt: 0,
    type: "notification.created",
    payload: {
      notificationId: "notification-0",
      status: "pending",
      title: "过期",
      body: "过期",
      entityVersion: 0
    }
  });

  assert.equal(feed.tasks.some(task => task.id === "task-0"), false);
  assert.equal(feed.notifications.some(notification => notification.id === "notification-0"), false);
  assert.ok(taskRefreshes > 0);
  assert.ok(notificationRefreshes > 0);
});

test("retries an authoritative refresh after the first watermark fallback fails", async () => {
  let taskRequests = 0;
  const feed = new DesktopTaskNotificationFeed({
    getTasks: async () => {
      taskRequests++;
      if (taskRequests <= nonTerminalTaskStatuses.length) {
        throw new Error("temporary refresh failure");
      }
      return [{ id: "task-0", status: "succeeded", entityVersion: 2 }];
    },
    getUnreadNotifications: async () => [],
    markDelivered: async () => undefined,
    markRead: async () => undefined,
    dismiss: async () => undefined
  });

  for (let index = 0; index <= maxTrackedFeedEntities; index++) {
    await feed.applyEvent({
      eventId: `task-watermark-${index}`,
      occurredAt: index,
      type: "task.updated",
      payload: { taskId: `task-${index}`, status: "running", entityVersion: index }
    });
  }

  await feed.applyEvent({
    eventId: "task-late-after-refresh-retry",
    occurredAt: 0,
    type: "task.updated",
    payload: { taskId: "task-0", status: "running", entityVersion: 0 }
  });

  assert.equal(taskRequests, nonTerminalTaskStatuses.length * 2);
  assert.equal(feed.tasks.find(task => task.id === "task-0"), undefined);
  assert.deepEqual(feed.terminalTasks, [{ taskId: "task-0", status: "succeeded" }]);
});

test("returns the bounded refresh error when the retry also fails", async () => {
  let taskRequests = 0;
  const feed = new DesktopTaskNotificationFeed({
    getTasks: async () => {
      taskRequests++;
      throw new Error("refresh unavailable");
    },
    getUnreadNotifications: async () => [],
    markDelivered: async () => undefined,
    markRead: async () => undefined,
    dismiss: async () => undefined
  });

  for (let index = 0; index <= maxTrackedFeedEntities; index++) {
    await feed.applyEvent({
      eventId: `task-watermark-error-${index}`,
      occurredAt: index,
      type: "task.updated",
      payload: { taskId: `task-error-${index}`, status: "running", entityVersion: index }
    });
  }

  await assert.rejects(
    () => feed.applyEvent({
      eventId: "task-late-after-refresh-error",
      occurredAt: 0,
      type: "task.updated",
      payload: { taskId: "task-error-0", status: "running", entityVersion: 0 }
    }),
    /refresh unavailable/);
  assert.equal(taskRequests, nonTerminalTaskStatuses.length * 2);
});

test("does not apply a stale watermark retry after switching conversations", async () => {
  let failOldConversation = false;
  const feed = new DesktopTaskNotificationFeed({
    getTasks: async (conversationId) => {
      if (conversationId === "old" && failOldConversation) {
        throw new Error("old conversation unavailable");
      }

      return conversationId === "new"
        ? [{ id: "new-task", status: "running", entityVersion: 3 }]
        : [];
    },
    getUnreadNotifications: async () => [],
    markDelivered: async () => undefined,
    markRead: async () => undefined,
    dismiss: async () => undefined
  });

  await feed.refresh("old");
  failOldConversation = true;
  for (let index = 0; index <= maxTrackedFeedEntities; index++) {
    await feed.applyEvent({
      eventId: `task-watermark-switch-${index}`,
      occurredAt: index,
      type: "task.updated",
      payload: {
        taskId: `old-task-${index}`,
        conversationId: "old",
        status: "running",
        entityVersion: index
      }
    });
  }

  const staleRetry = feed.applyEvent({
    eventId: "task-late-before-switch",
    occurredAt: 0,
    type: "task.updated",
    payload: { taskId: "old-task-0", status: "running", entityVersion: 0 }
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  await feed.refresh("new");
  await staleRetry;

  assert.deepEqual(feed.tasks.map(task => task.id), ["new-task"]);
});

test("disposes a pending watermark retry without a late refresh", async () => {
  let taskRequests = 0;
  const feed = new DesktopTaskNotificationFeed({
    getTasks: async () => {
      taskRequests++;
      throw new Error("refresh unavailable");
    },
    getUnreadNotifications: async () => [],
    markDelivered: async () => undefined,
    markRead: async () => undefined,
    dismiss: async () => undefined
  });

  for (let index = 0; index <= maxTrackedFeedEntities; index++) {
    await feed.applyEvent({
      eventId: `task-watermark-dispose-${index}`,
      occurredAt: index,
      type: "task.updated",
      payload: { taskId: `dispose-task-${index}`, status: "running", entityVersion: index }
    });
  }

  const staleRetry = feed.applyEvent({
    eventId: "task-late-before-dispose",
    occurredAt: 0,
    type: "task.updated",
    payload: { taskId: "dispose-task-0", status: "running", entityVersion: 0 }
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  feed.dispose();
  await staleRetry;

  assert.equal(taskRequests, nonTerminalTaskStatuses.length);
});

test("recreates a disposed feed during a StrictMode setup-cleanup-setup cycle", () => {
  let created = 0;
  const create = () => {
    created++;
    return new DesktopTaskNotificationFeed({
      getTasks: async () => [],
      getUnreadNotifications: async () => [],
      markDelivered: async () => undefined,
      markRead: async () => undefined,
      dismiss: async () => undefined
    });
  };

  const first = ensureActiveDesktopTaskNotificationFeed(undefined, create);
  first.dispose();
  const second = ensureActiveDesktopTaskNotificationFeed(first, create);

  assert.equal(created, 2);
  assert.notEqual(second, first);
  assert.equal(second.isDisposed, false);
});

test("does not commit an old feed refresh after StrictMode replaces it", async () => {
  let releaseOldRefresh!: () => void;
  const oldRefreshReady = new Promise<void>(resolve => {
    releaseOldRefresh = resolve;
  });
  const createBackend = (taskId: string, waitForRefresh?: Promise<void>) => ({
    getTasks: async () => {
      await waitForRefresh;
      return [{ id: taskId, status: "running", entityVersion: 1 }];
    },
    getUnreadNotifications: async () => [],
    markDelivered: async () => undefined,
    markRead: async () => undefined,
    dismiss: async () => undefined
  });
  const oldFeed = new DesktopTaskNotificationFeed(createBackend("old-task", oldRefreshReady));
  const newFeed = new DesktopTaskNotificationFeed(createBackend("new-task"));
  let currentFeed: DesktopTaskNotificationFeed | undefined = oldFeed;
  const appliedTaskIds: string[] = [];

  const oldRefresh = refreshFeedIfCurrent(
    oldFeed,
    () => currentFeed,
    tasks => appliedTaskIds.push(...tasks.map(task => task.id)),
    "conversation-1");
  oldFeed.dispose();
  currentFeed = newFeed;
  await refreshFeedIfCurrent(
    newFeed,
    () => currentFeed,
    tasks => appliedTaskIds.push(...tasks.map(task => task.id)),
    "conversation-1");
  releaseOldRefresh();
  await oldRefresh;

  assert.deepEqual(appliedTaskIds, ["new-task"]);
});
