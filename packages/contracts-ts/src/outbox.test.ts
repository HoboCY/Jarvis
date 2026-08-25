import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  decodeSignalREventEnvelopeJson,
  type ConversationCreatedPayload,
} from "./outbox.js";

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

test("rejects malformed SignalR outbox envelopes", () => {
  assert.throws(
    () => decodeSignalREventEnvelopeJson('{"eventId":"missing-payload"}'),
    TypeError,
  );
});
