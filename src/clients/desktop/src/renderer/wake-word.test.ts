import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  IpcWakeWordDetector,
  builtInWakeWord,
  type WakeWordBridge
} from "./wake-word.js";

function fakeBridge(): {
  bridge: WakeWordBridge;
  detect: () => void;
  fail: () => void;
  lifecycle: string[];
} {
  const lifecycle: string[] = [];
  let detectionListener: (() => void) | undefined;
  let errorListener: ((message: string) => void) | undefined;
  return {
    bridge: {
      startWakeWordDetection: async keyword => {
        lifecycle.push(`start:${keyword}`);
      },
      stopWakeWordDetection: async () => {
        lifecycle.push("stop");
      },
      onWakeWordDetected: listener => {
        detectionListener = listener;
        lifecycle.push("listen:detected");
        return () => {
          detectionListener = undefined;
          lifecycle.push("remove:detected");
        };
      },
      onWakeWordError: listener => {
        errorListener = listener;
        lifecycle.push("listen:error");
        return () => {
          errorListener = undefined;
          lifecycle.push("remove:error");
        };
      }
    },
    detect: () => detectionListener?.(),
    fail: () => errorListener?.("microphone failed"),
    lifecycle
  };
}

test("IpcWakeWordDetector publishes Chinese Jarvis detections and releases main-process audio", async () => {
  const fake = fakeBridge();
  const detector = new IpcWakeWordDetector(fake.bridge, builtInWakeWord);
  const states: string[] = [];
  let detections = 0;
  detector.onStateChange(state => states.push(state));
  detector.onDetected(() => detections++);

  await detector.start();
  fake.detect();
  assert.equal(detections, 1);
  assert.equal(detector.state, "listening");

  await detector.stop();
  fake.detect();
  assert.equal(detections, 1);
  assert.deepEqual(states, ["starting", "listening", "stopped"]);
  assert.deepEqual(fake.lifecycle, [
    "listen:detected",
    "listen:error",
    "start:贾维斯",
    "remove:detected",
    "remove:error",
    "stop"
  ]);
});

test("IpcWakeWordDetector fails closed when the main-process detector reports an error", async () => {
  const fake = fakeBridge();
  const detector = new IpcWakeWordDetector(fake.bridge, builtInWakeWord);

  await detector.start();
  fake.fail();

  assert.equal(detector.state, "error");
  await detector.stop();
  assert.equal(detector.state, "stopped");
});
