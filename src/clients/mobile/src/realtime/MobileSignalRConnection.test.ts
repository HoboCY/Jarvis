import { strict as assert } from "node:assert";
import { test } from "node:test";
import { MobileSignalRConnection, type MobileHubConnection, type MobileSignalRFeed } from "./MobileSignalRConnection.js";

class FakeHubConnection implements MobileHubConnection {
  public starts = 0;
  public stops = 0;
  public readonly handlers = new Map<string, (payload: unknown) => void>();
  public readonly reconnectHandlers: (() => void)[] = [];

  on(eventName: string, handler: (payload: unknown) => void): void {
    this.handlers.set(eventName, handler);
  }

  onreconnected(handler: () => void): void {
    this.reconnectHandlers.push(handler);
  }

  async start(): Promise<void> {
    this.starts++;
  }

  async stop(): Promise<void> {
    this.stops++;
  }

  emit(eventName: string, payload: unknown): void {
    this.handlers.get(eventName)?.(payload);
  }
}

class FakeFeed implements MobileSignalRFeed {
  public events = 0;
  public recoveries = 0;

  acceptEvent(): boolean {
    this.events++;
    return true;
  }

  async refresh(): Promise<void> {
    this.recoveries++;
  }
}

test("MobileSignalRConnection forwards foreground events and refreshes after reconnect", async () => {
  const connection = new FakeHubConnection();
  const feed = new FakeFeed();
  const client = new MobileSignalRConnection("https://jarvis.test", () => connection, feed);

  await client.connect();
  assert.equal(connection.handlers.has("conversation.summaryUpdated"), true);
  assert.equal(connection.handlers.has("realtime.sessionInvalidated"), true);
  connection.emit("notification.created", { eventId: "event-1", occurredAt: 1, type: "notification.created", payload: {} });
  connection.emit("conversation.summaryUpdated", {
    eventId: "event-2",
    occurredAt: 2,
    type: "conversation.summaryUpdated",
    payload: { conversationId: "conversation-1", summaryId: "summary-1", entityVersion: 2 }
  });
  assert.equal(feed.events, 2);
  connection.reconnectHandlers[0]!();
  await client.whenIdle();
  assert.equal(feed.recoveries, 1);
  await client.disconnect();
  await client.disconnect();
  assert.equal(connection.starts, 1);
  assert.equal(connection.stops, 1);
});
