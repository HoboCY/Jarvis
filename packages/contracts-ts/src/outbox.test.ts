import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  decodeSignalREventEnvelope,
  decodeSignalREventEnvelopeJson,
  type ConversationCreatedPayload,
  type ConversationSummaryUpdatedPayload,
  type DeviceTaskCancellationRequestedPayload,
  type NotificationCreatedPayload,
  type RealtimeSessionInvalidatedPayload,
} from "./index.js";

test("decodes a Phase 1 SignalR outbox envelope", () => {
  const envelope = decodeSignalREventEnvelopeJson(JSON.stringify({
    eventId: "0198b0a1-0000-7000-8000-000000000001",
    occurredAt: 1_756_000_000_000,
    type: "conversation.created",
    payload: {
      userId: "0198b0a1-0000-7000-8000-000000000002",
      conversationId: "0198b0a1-0000-7000-8000-000000000003",
      title: "hello",
    } satisfies ConversationCreatedPayload,
  }));

  assert.equal(envelope.type, "conversation.created");
  assert.equal(envelope.occurredAt, 1_756_000_000_000);
  assert.equal((envelope.payload as ConversationCreatedPayload).title, "hello");
});

test("decodes the conversation summary update contract", () => {
  const event = decodeSignalREventEnvelope({
    eventId: "0198b0a1-0000-7000-8000-000000000010",
    occurredAt: 1_756_000_000_010,
    type: "conversation.summaryUpdated",
    payload: {
      userId: "0198b0a1-0000-7000-8000-000000000002",
      conversationId: "0198b0a1-0000-7000-8000-000000000003",
      summaryId: "0198b0a1-0000-7000-8000-000000000011",
      fromSequence: 1,
      toSequence: 10,
      entityVersion: 2
    } satisfies ConversationSummaryUpdatedPayload
  });

  assert.equal(event.type, "conversation.summaryUpdated");
  assert.equal((event.payload as ConversationSummaryUpdatedPayload).toSequence, 10);
});

test("rejects malformed SignalR outbox envelopes", () => {
  assert.throws(
    () => decodeSignalREventEnvelopeJson('{"eventId":"missing-payload"}'),
    TypeError,
  );
});

test("decodes Device cancellation and realtime invalidation hints", () => {
  const cancellation = decodeSignalREventEnvelope({
    eventId: "0198b0a1-0000-7000-8000-000000000020",
    occurredAt: 1_756_000_000_020,
    type: "task.cancellationRequested",
    payload: {
      userId: "0198b0a1-0000-7000-8000-000000000002",
      deviceId: "0198b0a1-0000-7000-8000-000000000021",
      conversationId: "0198b0a1-0000-7000-8000-000000000003",
      taskId: "0198b0a1-0000-7000-8000-000000000022",
      status: "cancellationRequested",
      occurredAt: 1_756_000_000_020,
      entityVersion: 3
    } satisfies DeviceTaskCancellationRequestedPayload
  });
  const invalidation = decodeSignalREventEnvelope({
    eventId: "0198b0a1-0000-7000-8000-000000000023",
    occurredAt: 1_756_000_000_023,
    type: "realtime.sessionInvalidated",
    payload: {
      userId: "0198b0a1-0000-7000-8000-000000000002",
      sessionId: "0198b0a1-0000-7000-8000-000000000024",
      conversationId: "0198b0a1-0000-7000-8000-000000000003",
      status: "rotated",
      reason: "idle rotation"
    } satisfies RealtimeSessionInvalidatedPayload
  });

  assert.equal((cancellation.payload as DeviceTaskCancellationRequestedPayload).deviceId.endsWith("21"), true);
  assert.equal((invalidation.payload as RealtimeSessionInvalidatedPayload).status, "rotated");
});

test("decodes Phase 3 task and notification event envelopes", () => {
  const notification = decodeSignalREventEnvelope({
    eventId: "0198b0a1-0000-7000-8000-000000000004",
    occurredAt: 1_756_000_000_001,
    type: "notification.created",
    payload: {
      userId: "0198b0a1-0000-7000-8000-000000000002",
      notificationId: "0198b0a1-0000-7000-8000-000000000005",
      type: "task.completed",
      severity: "success",
      title: "完成",
      body: "done",
      actionsJson: "[\"acknowledge\"]",
      status: "pending",
      dedupKey: "task:1:completed",
      entityVersion: 0
    } satisfies NotificationCreatedPayload
  });

  assert.equal(notification.type, "notification.created");
  assert.equal((notification.payload as NotificationCreatedPayload).status, "pending");
});
