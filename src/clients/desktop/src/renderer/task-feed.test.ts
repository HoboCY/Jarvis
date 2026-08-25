import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  DesktopTaskNotificationFeed,
  collectTaskPages,
  ensureActiveDesktopTaskNotificationFeed,
  maxTrackedFeedEntities,
  nonTerminalTaskStatuses,
  notificationActionIdempotencyKey,
  refreshFeedIfCurrent,
  refreshOnBackendConnectionState,
  type DesktopNotification,
  type DesktopTask
} from "./task-feed.js";

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

test("keeps newer realtime overlays when an older refresh snapshot resolves", async () => {
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
    payload: { taskId: "task-race", status: "succeeded", resultSummary: "新结果" }
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

  assert.equal(feed.tasks[0]?.status, "succeeded");
  assert.equal(feed.tasks[0]?.resultSummary, "新结果");
  assert.equal(feed.currentNotification?.id, "notification-race");
  assert.equal(feed.currentNotification?.status, "delivered");
  assert.deepEqual(delivered, ["notification-race"]);
});

test("ignores an older task event after a newer event", async () => {
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

  assert.equal(feed.tasks[0]?.status, "succeeded");
  assert.equal(feed.tasks[0]?.resultSummary, "最新");
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

  assert.equal(feed.tasks[0]?.status, "succeeded");
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

  assert.equal(feed.tasks[0]?.status, "succeeded");
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
  assert.equal(feed.tasks.find(task => task.id === "task-0")?.status, "succeeded");
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
      payload: { taskId: `old-task-${index}`, status: "running", entityVersion: index }
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
