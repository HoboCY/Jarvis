import { strict as assert } from "node:assert";
import { test } from "node:test";
import { MobileConversationController, type MobileConversationBackend, type MobileVoiceSession } from "./MobileConversationController.js";

class FakeVoiceSession implements MobileVoiceSession {
  public interrupts = 0;
  public readonly events: unknown[] = [];

  interrupt(): void {
    this.interrupts++;
  }

  sendEvent(event: unknown): void {
    this.events.push(event);
  }
}

class FakeConversationBackend implements MobileConversationBackend {
  public readonly persisted: { conversationId: string; request: unknown; idempotencyKey: string }[] = [];
  public fail = false;

  async createConversation(): Promise<{ id: string }> {
    return { id: "00000000-0000-7000-8000-000000000010" };
  }

  async getConversation(conversationId: string): Promise<{ id: string }> {
    return { id: conversationId };
  }

  async addTypedMessage(conversationId: string, request: unknown, idempotencyKey: string): Promise<unknown> {
    if (this.fail) {
      throw new Error("persist failed");
    }
    this.persisted.push({ conversationId, request, idempotencyKey });
    return { messageId: "00000000-0000-7000-8000-000000000011" };
  }
}

test("MobileConversationController uses one conversation id and persists typed input before interrupting voice", async () => {
  const backend = new FakeConversationBackend();
  const voice = new FakeVoiceSession();
  const controller = new MobileConversationController(backend, () => "typed-key-1");
  await controller.open();
  controller.attachVoiceSession(voice);

  await controller.sendTyped(" hello ");
  assert.equal(controller.conversationId, "00000000-0000-7000-8000-000000000010");
  assert.deepEqual(backend.persisted, [{
    conversationId: controller.conversationId,
    request: {
      clientRequestId: "typed-key-1",
      text: "hello",
      replyMode: "text",
      realtimeSessionId: null
    },
    idempotencyKey: "typed-key-1"
  }]);
  assert.equal(voice.interrupts, 1);
  assert.deepEqual(voice.events, [
    {
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hello" }]
      }
    },
    { type: "response.create", response: { output_modalities: ["text"] } }
  ]);
});

test("MobileConversationController does not interrupt or send provider events when typed persistence fails", async () => {
  const backend = new FakeConversationBackend();
  backend.fail = true;
  const voice = new FakeVoiceSession();
  const controller = new MobileConversationController(backend, () => "typed-key-2");
  await controller.open("00000000-0000-7000-8000-000000000012");
  controller.attachVoiceSession(voice);

  await assert.rejects(controller.sendTyped("hello"), /persist failed/);
  assert.equal(voice.interrupts, 0);
  assert.deepEqual(voice.events, []);
});
