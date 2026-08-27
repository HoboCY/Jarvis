import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  MobileTaskNotificationFeed,
  mobileNotificationActionIdempotencyKey,
  notificationActionsFrom,
  type MobileFeedBackend,
  type MobileFeedEntity,
  type MobileSignalREvent
} from "./MobileTaskNotificationFeed.js";

test("mobile notification actions fail closed and use a stable bounded key", () => {
  assert.deepEqual(notificationActionsFrom('["acknowledge"]'), ["acknowledge"]);
  assert.deepEqual(notificationActionsFrom("[]"), []);
  assert.deepEqual(notificationActionsFrom('["run-command"]'), []);
  assert.deepEqual(notificationActionsFrom('["acknowledge","run-command"]'), []);
  assert.deepEqual(notificationActionsFrom({ action: "acknowledge" }), []);

  const longId = "n".repeat(500);
  const first = mobileNotificationActionIdempotencyKey(longId, "acknowledge");
  assert.equal(first, mobileNotificationActionIdempotencyKey(longId, "acknowledge"));
  assert.ok(first.length <= 200);
});

class FakeFeedBackend implements MobileFeedBackend {
  public taskCalls = 0;
  public applyNotificationAction?: MobileFeedBackend["applyNotificationAction"];
  public readonly tasks: MobileFeedEntity[] = [
    { id: "task-active", status: "running", entityVersion: 2 },
    { id: "task-done", status: "completed", entityVersion: 4 }
  ];
  public readonly notifications: MobileFeedEntity[] = [
    { id: "notification-1", status: "pending", entityVersion: 1, title: "One" }
  ];
  public readonly approvals: MobileFeedEntity[] = [
    { id: "approval-1", status: "pending", entityVersion: 1 }
  ];

  async listTasks(): Promise<{ items: MobileFeedEntity[]; nextCursor: null }> {
    this.taskCalls++;
    return { items: this.tasks, nextCursor: null };
  }

  async listUnreadNotifications(): Promise<MobileFeedEntity[]> {
    return this.notifications;
  }

  async listPendingApprovals(): Promise<MobileFeedEntity[]> {
    return this.approvals;
  }
}

test("MobileTaskNotificationFeed recovers all non-terminal tasks and pending approvals", async () => {
  const backend = new FakeFeedBackend();
  const feed = new MobileTaskNotificationFeed(backend);
  await feed.refresh();

  assert.deepEqual(feed.tasks.map(item => item.id), ["task-active"]);
  assert.deepEqual(feed.notifications.map(item => item.id), ["notification-1"]);
  assert.deepEqual(feed.approvals.map(item => item.id), ["approval-1"]);
  assert.equal(backend.taskCalls, 1);
});

test("MobileTaskNotificationFeed deduplicates event ids and keeps the newest entity version", () => {
  const feed = new MobileTaskNotificationFeed(new FakeFeedBackend());
  const event: MobileSignalREvent = {
    eventId: "event-1",
    type: "notification.created",
    payload: { id: "notification-2", status: "pending", entityVersion: 1, title: "first" }
  };
  assert.equal(feed.acceptEvent(event), true);
  assert.equal(feed.acceptEvent(event), false);
  assert.equal(feed.acceptEvent({
    ...event,
    eventId: "event-2",
    payload: { id: "notification-2", status: "read", entityVersion: 2, title: "new" }
  }), true);
  assert.deepEqual(feed.notifications, []);
  assert.equal(feed.acceptEvent({
    ...event,
    eventId: "event-3",
    payload: { id: "notification-2", status: "pending", entityVersion: 1, title: "old" }
  }), false);
});

test("MobileTaskNotificationFeed acknowledges only an offered action with retry-stable identity", async () => {
  const keys: string[] = [];
  let failOnce = true;
  const backend = new FakeFeedBackend();
  backend.notifications.splice(0);
  backend.applyNotificationAction = async (_notificationId, actionId, idempotencyKey) => {
    assert.equal(actionId, "acknowledge");
    keys.push(idempotencyKey);
    if (failOnce) {
      failOnce = false;
      throw new Error("response lost after commit");
    }
    return { id: "notification-action", status: "actioned", entityVersion: 2 };
  };
  const feed = new MobileTaskNotificationFeed(backend);
  assert.equal(feed.acceptEvent({
    eventId: "notification-action-created",
    type: "notification.created",
    payload: {
      notificationId: "notification-action",
      status: "pending",
      entityVersion: 1,
      actionsJson: '["acknowledge"]'
    }
  }), true);

  await assert.rejects(() => feed.acknowledgeNotification("notification-action"), /response lost/);
  await feed.acknowledgeNotification("notification-action");

  assert.deepEqual(keys, [
    mobileNotificationActionIdempotencyKey("notification-action", "acknowledge"),
    mobileNotificationActionIdempotencyKey("notification-action", "acknowledge")
  ]);
  assert.deepEqual(feed.notifications, []);
});

test("MobileTaskNotificationFeed does not invoke untrusted notification actions", async () => {
  let calls = 0;
  const backend = new FakeFeedBackend();
  backend.notifications.splice(0);
  backend.applyNotificationAction = async () => {
    calls++;
    return { id: "notification-untrusted", status: "actioned" };
  };
  const feed = new MobileTaskNotificationFeed(backend);
  assert.equal(feed.acceptEvent({
    eventId: "notification-untrusted-created",
    type: "notification.created",
    payload: {
      notificationId: "notification-untrusted",
      status: "pending",
      entityVersion: 1,
      actionsJson: '["run-command"]'
    }
  }), true);

  await assert.rejects(() => feed.acknowledgeNotification("notification-untrusted"), /does not offer/);
  assert.equal(calls, 0);
});

test("MobileTaskNotificationFeed follows task cursors until all non-terminal tasks are recovered", async () => {
  const tasks = Array.from({ length: 205 }, (_, index) => ({
    id: `task-${index}`,
    status: "running",
    entityVersion: 1
  }));
  let calls = 0;
  const backend: MobileFeedBackend = {
    listTasks: async query => {
      calls += 1;
      const offset = Number(query?.cursor ?? 0);
      const items = tasks.slice(offset, offset + 100);
      const nextCursor = offset + items.length < tasks.length
        ? String(offset + items.length)
        : null;
      return { items, nextCursor };
    },
    listUnreadNotifications: async () => [],
    listPendingApprovals: async () => []
  };

  const feed = new MobileTaskNotificationFeed(backend);
  await feed.refresh();

  assert.equal(calls, 3);
  assert.equal(feed.tasks.length, 205);
});

test("MobileTaskNotificationFeed fails closed on a repeated task cursor", async () => {
  let calls = 0;
  const backend: MobileFeedBackend = {
    listTasks: async () => {
      calls += 1;
      return { items: [], nextCursor: "same-cursor" };
    },
    listUnreadNotifications: async () => [],
    listPendingApprovals: async () => []
  };

  const feed = new MobileTaskNotificationFeed(backend);
  await assert.rejects(feed.refresh(), /repeated cursor/i);
  assert.equal(calls, 2);
});
