import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  WakeWordDetectorAdapter,
  type WakeWordEngine,
  type WakeWordProcessor
} from "./wake-word.js";

test("WakeWordDetectorAdapter starts local processing, publishes Jarvis detections, and releases it", async () => {
  const lifecycle: string[] = [];
  let detect: (() => void) | undefined;
  const engine: WakeWordEngine = {
    release: async () => {
      lifecycle.push("release");
    },
    terminate: () => {
      lifecycle.push("terminate");
    }
  };
  const processor: WakeWordProcessor = {
    subscribe: async subscribed => {
      assert.equal(subscribed, engine);
      lifecycle.push("subscribe");
    },
    unsubscribe: async unsubscribed => {
      assert.equal(unsubscribed, engine);
      lifecycle.push("unsubscribe");
    }
  };
  const detector = new WakeWordDetectorAdapter(
    async onDetected => {
      detect = onDetected;
      lifecycle.push("create");
      return engine;
    },
    processor);
  const states: string[] = [];
  detector.onStateChange(state => states.push(state));
  let detections = 0;
  detector.onDetected(() => detections++);

  await detector.start();
  assert.equal(detector.state, "listening");
  detect?.();
  assert.equal(detections, 1);

  await detector.stop();
  assert.equal(detector.state, "stopped");
  assert.deepEqual(lifecycle, ["create", "subscribe", "unsubscribe", "release", "terminate"]);
  assert.deepEqual(states, ["starting", "listening", "stopped"]);
});

test("WakeWordDetectorAdapter cleans up a processor that fails while subscribing", async () => {
  const lifecycle: string[] = [];
  const engine: WakeWordEngine = {
    release: async () => {
      lifecycle.push("release");
    },
    terminate: () => {
      lifecycle.push("terminate");
    }
  };
  const processor: WakeWordProcessor = {
    subscribe: async () => {
      lifecycle.push("subscribe");
      throw new Error("processor microphone setup failed");
    },
    unsubscribe: async unsubscribed => {
      assert.equal(unsubscribed, engine);
      lifecycle.push("unsubscribe");
    }
  };
  const detector = new WakeWordDetectorAdapter(async () => engine, processor);

  await assert.rejects(detector.start(), /processor microphone setup failed/);

  assert.equal(detector.state, "error");
  assert.deepEqual(lifecycle, ["subscribe", "unsubscribe", "release", "terminate"]);
});
