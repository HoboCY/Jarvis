import { strict as assert } from "node:assert";
import { test } from "node:test";
import { ScriptedRealtimeTransport } from "@openai/agents-realtime/testing";
import { RealtimeSession } from "@openai/agents-realtime";
import {
  SessionRotationStateMachine,
  createRealtimeAgent,
  createTextOnlyResponseEvent,
  createRealtimeToolIdempotencyKey,
  type RealtimeTaskBackend,
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

test("routes a real SDK function call through the injected backend with a stable bounded key", async () => {
  const transport = new ScriptedRealtimeTransport();
  const keys: string[] = [];
  const backend: RealtimeTaskBackend = {
    delegateTask: async (_input, idempotencyKey) => {
      keys.push(idempotencyKey);
      return { accepted: true, taskId: "00000000-0000-0000-0000-000000000099", status: "queued" };
    },
    getTaskStatus: async () => ({ status: "queued" }),
    cancelTask: async () => ({ accepted: true, status: "cancellationRequested" }),
    rememberFact: async () => ({ saved: true, memoryId: "memory-1" })
  };
  const session = new RealtimeSession(
    createRealtimeAgent("test instructions", undefined, {
      backend,
      sessionScope: "realtime-session-123"
    }),
    { transport, model: "gpt-4o-realtime-preview" }
  );
  await transport.runScenario({
    scenario: async ({ expectCall }) => {
      await expectCall("connect");
      const output = expectCall("sendFunctionCallOutput", call => {
        assert.equal(call.toolCall.callId, "call-123");
        assert.match(call.output, /taskId/);
      });
      await output;
    },
    exercise: async () => {
      await session.connect({ apiKey: "ek_scripted", model: "gpt-4o-realtime-preview" });
      transport.emit("turn_started", {
        type: "response_started",
        providerData: { response: { id: "response-123" } }
      });
      transport.emit("function_call", {
        type: "function_call",
        name: "delegate_task",
        callId: "call-123",
        arguments: JSON.stringify({
          goal: "分析报表",
          expectedOutput: null,
          requiredCapabilities: ["deepReasoning"],
          preferredDeviceId: null,
          sourceMessageIds: [],
          attachmentRefs: [],
          capabilityEnvelope: null
        }),
        responseId: "response-123"
      });
      await new Promise(resolve => setImmediate(resolve));
    }
  });

  assert.equal(keys.length, 1);
  assert.equal(keys[0], "realtime-session-123:delegate_task:call-123");
  assert.ok(keys[0].length <= 200);
  transport.assertComplete();
});

test("routes delegate, status, and cancel through the real SDK function-call pipeline", async () => {
  const transport = new ScriptedRealtimeTransport();
  const calls: string[] = [];
  const taskId = "00000000-0000-7000-8000-000000000099";
  const backend: RealtimeTaskBackend = {
    delegateTask: async (input, idempotencyKey) => {
      calls.push(`delegate:${idempotencyKey}`);
      assert.equal(input.goal, "分析报表");
      return { accepted: true, taskId, status: "queued" };
    },
    getTaskStatus: async (input, idempotencyKey) => {
      calls.push(`status:${idempotencyKey}`);
      assert.equal(input.taskId, taskId);
      return { taskId, status: "running", progressSummary: "执行中", requiresUserAction: false };
    },
    cancelTask: async (input, idempotencyKey) => {
      calls.push(`cancel:${idempotencyKey}`);
      assert.equal(input.taskId, taskId);
      return { accepted: true, status: "cancellationRequested" };
    },
    rememberFact: async (input, idempotencyKey) => {
      calls.push(`remember:${idempotencyKey}`);
      assert.equal(input.key, "communication.responseLength");
      return { saved: true, memoryId: "memory-1" };
    }
  };
  const session = new RealtimeSession(
    createRealtimeAgent("test instructions", undefined, {
      backend,
      sessionScope: "0198b0a1-0000-7000-8000-000000000001"
    }),
    { transport, model: "gpt-4o-realtime-preview" }
  );
  const functionCalls = [
    {
      name: "delegate_task",
      callId: "call-delegate",
      responseId: "response-delegate",
      args: {
        goal: "分析报表",
        expectedOutput: null,
        requiredCapabilities: ["deepReasoning"],
        preferredDeviceId: null,
        sourceMessageIds: [],
        attachmentRefs: [],
        capabilityEnvelope: null
      },
      output: { accepted: true, taskId, status: "queued" }
    },
    {
      name: "get_task_status",
      callId: "call-status",
      responseId: "response-status",
      args: { taskId },
      output: { taskId, status: "running", progressSummary: "执行中", requiresUserAction: false }
    },
    {
      name: "cancel_task",
      callId: "call-cancel",
      responseId: "response-cancel",
      args: { taskId },
      output: { accepted: true, status: "cancellationRequested" }
    }
  ] as const;

  await transport.runScenario({
    scenario: async ({ expectCall }) => {
      await expectCall("connect");
      for (const functionCall of functionCalls) {
        const output = expectCall("sendFunctionCallOutput", call => {
          assert.equal(call.toolCall.callId, functionCall.callId);
          assert.deepEqual(JSON.parse(call.output), functionCall.output);
        });
        await output;
      }
    },
    exercise: async () => {
      await session.connect({ apiKey: "ek_scripted", model: "gpt-4o-realtime-preview" });
      for (const functionCall of functionCalls) {
        transport.emit("turn_started", {
          type: "response_started",
          providerData: { response: { id: functionCall.responseId } }
        });
        transport.emit("function_call", {
          type: "function_call",
          name: functionCall.name,
          callId: functionCall.callId,
          arguments: JSON.stringify(functionCall.args),
          responseId: functionCall.responseId
        });
        await new Promise(resolve => setImmediate(resolve));
      }
    }
  });

  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map(call => call.split(":")[0]), ["delegate", "status", "cancel"]);
  transport.assertComplete();
});

test("replaying a function call uses one backend write and returns the cached output", async () => {
  const transport = new ScriptedRealtimeTransport();
  const outputs: unknown[] = [];
  let backendCalls = 0;
  const result = { accepted: true, taskId: "00000000-0000-7000-8000-000000000099", status: "queued" };
  const session = new RealtimeSession(
    createRealtimeAgent("test instructions", undefined, {
      backend: {
        delegateTask: async () => {
          backendCalls++;
          return result;
        },
        getTaskStatus: async () => ({ status: "queued" }),
        cancelTask: async () => ({ accepted: true, status: "cancellationRequested" }),
        rememberFact: async () => ({ saved: true, memoryId: "memory-1" })
      },
      sessionScope: "0198b0a1-0000-7000-8000-000000000002"
    }),
    { transport, model: "gpt-4o-realtime-preview" }
  );
  const args = {
    goal: "分析报表",
    expectedOutput: null,
    requiredCapabilities: ["deepReasoning"],
    preferredDeviceId: null,
    sourceMessageIds: [],
    attachmentRefs: [],
    capabilityEnvelope: null
  };

  await transport.runScenario({
    scenario: async ({ expectCall }) => {
      await expectCall("connect");
      for (let index = 0; index < 2; index++) {
        const output = expectCall("sendFunctionCallOutput", call => {
          outputs.push(JSON.parse(call.output));
          assert.equal(call.toolCall.callId, "call-replay");
        });
        await output;
      }
    },
    exercise: async () => {
      await session.connect({ apiKey: "ek_scripted", model: "gpt-4o-realtime-preview" });
      for (const responseId of ["response-replay-1", "response-replay-2"]) {
        transport.emit("turn_started", {
          type: "response_started",
          providerData: { response: { id: responseId } }
        });
        transport.emit("function_call", {
          type: "function_call",
          name: "delegate_task",
          callId: "call-replay",
          arguments: JSON.stringify(args),
          responseId
        });
        await new Promise(resolve => setImmediate(resolve));
      }
    }
  });

  assert.equal(backendCalls, 1);
  assert.deepEqual(outputs, [result, result]);
  transport.assertComplete();
});

test("routes remember_fact through the authenticated backend and replays by call id", async () => {
  const transport = new ScriptedRealtimeTransport();
  let backendCalls = 0;
  const session = new RealtimeSession(
    createRealtimeAgent("test instructions", undefined, {
      backend: {
        delegateTask: async () => ({ accepted: true }),
        getTaskStatus: async () => ({ status: "queued" }),
        cancelTask: async () => ({ accepted: true, status: "cancelled" }),
        rememberFact: async (input, idempotencyKey) => {
          backendCalls++;
          assert.match(idempotencyKey, /remember_fact:call-remember-fact/);
          assert.equal(input.key, "communication.responseLength");
          return { saved: true, memoryId: "memory-remember-1" };
        }
      },
      sessionScope: "remember-session"
    }),
    { transport, model: "gpt-4o-realtime-preview" }
  );

  await transport.runScenario({
    scenario: async ({ expectCall }) => {
      await expectCall("connect");
      const output = expectCall("sendFunctionCallOutput", call => {
        assert.deepEqual(JSON.parse(call.output), { saved: true, memoryId: "memory-remember-1" });
      });
      await output;
      const replay = expectCall("sendFunctionCallOutput", call => {
        assert.deepEqual(JSON.parse(call.output), { saved: true, memoryId: "memory-remember-1" });
      });
      await replay;
    },
    exercise: async () => {
      await session.connect({ apiKey: "ek_scripted", model: "gpt-4o-realtime-preview" });
      transport.emit("turn_started", {
        type: "response_started",
        providerData: { response: { id: "response-remember-fact" } }
      });
      transport.emit("function_call", {
        type: "function_call",
        name: "remember_fact",
        callId: "call-remember-fact",
        arguments: JSON.stringify({
          key: "communication.responseLength",
          value: "prefer concise answers",
          sourceMessageId: "00000000-0000-7000-8000-000000000099",
          sensitive: false
        }),
        responseId: "response-remember-fact"
      });
      transport.emit("function_call", {
        type: "function_call",
        name: "remember_fact",
        callId: "call-remember-fact",
        arguments: JSON.stringify({
          key: "communication.responseLength",
          value: "prefer concise answers",
          sourceMessageId: "00000000-0000-7000-8000-000000000099",
          sensitive: false
        }),
        responseId: "response-remember-fact"
      });
      await new Promise(resolve => setImmediate(resolve));
    }
  });

  assert.equal(backendCalls, 1);
  transport.assertComplete();
});

test("returns a safe backend-error output when a Realtime backend fails", async () => {
  const transport = new ScriptedRealtimeTransport();
  const session = new RealtimeSession(
    createRealtimeAgent("test instructions", undefined, {
      backend: {
        delegateTask: async () => ({ accepted: true }),
        getTaskStatus: async () => {
          throw new Error("database credentials must not escape");
        },
        cancelTask: async () => ({ accepted: true, status: "cancelled" }),
        rememberFact: async () => ({ saved: true, memoryId: "memory-1" })
      },
      sessionScope: "0198b0a1-0000-7000-8000-000000000003"
    }),
    { transport, model: "gpt-4o-realtime-preview" }
  );

  await transport.runScenario({
    scenario: async ({ expectCall }) => {
      await expectCall("connect");
      const output = expectCall("sendFunctionCallOutput", call => {
        assert.deepEqual(JSON.parse(call.output), {
          available: false,
          code: "backend-error",
          tool: "get_task_status",
          message: "The authenticated backend could not complete this tool call."
        });
      });
      await output;
    },
    exercise: async () => {
      await session.connect({ apiKey: "ek_scripted", model: "gpt-4o-realtime-preview" });
      transport.emit("turn_started", {
        type: "response_started",
        providerData: { response: { id: "response-failure" } }
      });
      transport.emit("function_call", {
        type: "function_call",
        name: "get_task_status",
        callId: "call-failure",
        arguments: JSON.stringify({ taskId: "00000000-0000-7000-8000-000000000099" }),
        responseId: "response-failure"
      });
      await new Promise(resolve => setImmediate(resolve));
    }
  });

  transport.assertComplete();
});

test("keeps idempotency keys bounded and separates call ids for a production UUID scope", () => {
  const productionScope = "0198b0a1-0000-7000-8000-000000000004";
  const first = createRealtimeToolIdempotencyKey(productionScope, "delegate_task", "call-a");
  const second = createRealtimeToolIdempotencyKey(productionScope, "delegate_task", "call-b");
  const long = createRealtimeToolIdempotencyKey("scope-".repeat(100), "cancel_task", "call-".repeat(100));

  assert.notEqual(first, second);
  assert.ok(first.length <= 200);
  assert.ok(second.length <= 200);
  assert.ok(long.length <= 200);
});

test("does not collide when long idempotency inputs share the same prefix", () => {
  const scope = "scope-".repeat(100);
  const first = createRealtimeToolIdempotencyKey(scope, "delegate_task", "call-a");
  const second = createRealtimeToolIdempotencyKey(scope, "delegate_task", "call-b");

  assert.notEqual(first, second);
  assert.ok(first.length <= 200);
  assert.ok(second.length <= 200);
});
