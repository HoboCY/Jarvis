import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  MobileTaskNotificationFeed,
  type MobileFeedBackend,
  type MobileFeedEntity,
  type MobileSignalREvent
} from "./MobileTaskNotificationFeed.js";

class FakeFeedBackend implements MobileFeedBackend {
  public taskCalls = 0;
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
  assert.equal(feed.notifications[0]!.status, "read");
  assert.equal(feed.notifications[0]!.title, "new");
  assert.equal(feed.acceptEvent({
    ...event,
    eventId: "event-3",
    payload: { id: "notification-2", status: "pending", entityVersion: 1, title: "old" }
  }), false);
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
