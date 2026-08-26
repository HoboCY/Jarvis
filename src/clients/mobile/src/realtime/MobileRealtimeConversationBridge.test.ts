import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { RealtimeSession } from "@openai/agents-realtime";
import { MobileRealtimeConversationBridge, type MobileRealtimePersistenceBackend } from "./MobileRealtimeConversationBridge.js";

class FakeTransport {
  private readonly listeners = new Map<string, Set<(value: unknown) => void>>();

  on(type: string, listener: (value: unknown) => void): void {
    const listeners = this.listeners.get(type) ?? new Set<(value: unknown) => void>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  off(type: string, listener: (value: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string, value: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(value);
    }
  }
}

test("MobileRealtimeConversationBridge marks lifecycle and persists transcript events", async () => {
  const transport = new FakeTransport();
  const calls: string[] = [];
  const backend: MobileRealtimePersistenceBackend = {
    markConnected: async input => { calls.push(`connected:${input.sessionId}`); },
    markEnded: async input => { calls.push(`ended:${input.status}`); },
    ingest: async input => { calls.push(`ingest:${input.events[0]!.role}:${input.events[0]!.status}`); }
  };
  const session = {
    transport,
    close: () => { calls.push("closed"); }
  } as unknown as RealtimeSession;
  const bridge = new MobileRealtimeConversationBridge(
    "conversation-1",
    "00000000-0000-7000-8000-000000000001",
    backend,
    () => "idempotency-key",
    "external-1");

  await bridge.connect(session);
  transport.emit("*", {
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "item-user",
    transcript: "hello"
  });
  transport.emit("output_text_delta", { itemId: "item-assistant", delta: "hi" });
  transport.emit("turn_done", { response: { output: [{ id: "item-assistant" }] } });
  await bridge.close();

  assert.deepEqual(calls, [
    "connected:00000000-0000-7000-8000-000000000001",
    "closed",
    "ingest:user:completed",
    "ingest:assistant:streaming",
    "ingest:assistant:completed",
    "ended:disconnected"
  ]);
});

test("MobileRealtimeConversationBridge does not persist events after close or end twice", async () => {
  const transport = new FakeTransport();
  let ingests = 0;
  let ends = 0;
  const bridge = new MobileRealtimeConversationBridge(
    "conversation-1",
    "00000000-0000-7000-8000-000000000001",
    {
      markConnected: async () => undefined,
      markEnded: async () => { ends++; },
      ingest: async () => { ingests++; }
    },
    () => "key",
    "external");
  const session = { transport, close: () => undefined } as unknown as RealtimeSession;
  await bridge.connect(session);
  await bridge.close();
  transport.emit("*", {
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "item",
    transcript: "ignored"
  });
  await bridge.close();
  assert.equal(ingests, 0);
  assert.equal(ends, 1);
});

test("MobileRealtimeConversationBridge does not attach a session after close races markConnected", async () => {
  const transport = new FakeTransport();
  let releaseConnected!: () => void;
  let sessionCloses = 0;
  const bridge = new MobileRealtimeConversationBridge(
    "conversation-1",
    "realtime-1",
    {
      markConnected: async () => new Promise<void>(resolve => {
        releaseConnected = resolve;
      }),
      markEnded: async () => undefined,
      ingest: async () => undefined
    },
    () => "key",
    "external");
  const session = {
    transport,
    close: () => { sessionCloses += 1; }
  } as unknown as RealtimeSession;

  const connectPromise = bridge.connect(session);
  await new Promise<void>(resolve => setImmediate(resolve));
  const closePromise = bridge.close();
  releaseConnected();
  await closePromise;
  await assert.rejects(connectPromise, /closed/i);
  assert.equal(sessionCloses, 1);
});
