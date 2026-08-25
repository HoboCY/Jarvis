import { strict as assert } from "node:assert";
import { test } from "node:test";
import { ScriptedRealtimeTransport } from "@openai/agents/realtime/testing";
import { RealtimeSession } from "@openai/agents/realtime";
import {
  SessionRotationStateMachine,
  createRealtimeAgent,
  createTextOnlyResponseEvent,
  realtimeToolNames,
  sendTypedMessage
} from "./index.js";

test("keeps the Phase 0 realtime tool surface bounded", () => {
  assert.deepEqual(realtimeToolNames, ["delegate_task", "get_task_status", "cancel_task", "remember_fact"]);
});

test("creates a text-only response event", () => {
  assert.deepEqual(createTextOnlyResponseEvent(), {
    type: "response.create",
    response: { output_modalities: ["text"] }
  });
});

test("passes the complete backend context into the SDK session instructions", async () => {
  const instructions = "fixed safety\n[User preferences]\n喜欢简洁\n[Recent conversation]\nuser: 保留上下文";
  const agent = createRealtimeAgent(instructions, "alloy");
  const session = new RealtimeSession(agent, {
    transport: new ScriptedRealtimeTransport(),
    model: "gpt-4o-realtime-preview"
  });

  const config = await session.getInitialSessionConfig();

  assert.equal(config.instructions, instructions);
});

test("persists typed input before interrupting and sending text-only events on the same SDK session", async () => {
  const transport = new ScriptedRealtimeTransport();
  const session = new RealtimeSession(createRealtimeAgent("test instructions"), {
    transport,
    model: "gpt-4o-realtime-preview"
  });
  const order: string[] = [];

  await transport.runScenario({
    scenario: async ({ expectCall }) => {
      await expectCall("interrupt");
      await expectCall("sendEvent", call => {
        assert.equal(call.event.type, "conversation.item.create");
      });
      await expectCall("sendEvent", call => {
        assert.deepEqual(call.event, createTextOnlyResponseEvent());
      });
    },
    exercise: () => sendTypedMessage(
      session,
      "继续分析",
      async text => {
        order.push(`persist:${text}`);
      })
  });

  assert.deepEqual(order, ["persist:继续分析"]);
  transport.assertComplete();
});

test("rotation only becomes consumable at an idle boundary", () => {
  const rotation = new SessionRotationStateMachine(50 * 60 * 1000);
  rotation.connected(0);
  rotation.setAssistantSpeaking(true, 50 * 60 * 1000);
  assert.equal(rotation.tick(50 * 60 * 1000), "rotation-ready");
  assert.equal(rotation.canRotate(), false);
  rotation.setAssistantSpeaking(false, 50 * 60 * 1000 + 1);
  assert.equal(rotation.canRotate(), true);
  assert.equal(rotation.consumeRotation(), true);
});
