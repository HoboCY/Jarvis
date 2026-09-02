import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  IpcWakeWordDetector,
  WakeWordStartCancelledError,
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

test("IpcWakeWordDetector ignores a late successful start after a fatal bridge error", async () => {
  let resolveStart: (() => void) | undefined;
  let errorListener: ((message: string) => void) | undefined;
  const bridge: WakeWordBridge = {
    startWakeWordDetection: async () => new Promise<void>(resolve => {
      resolveStart = resolve;
    }),
    stopWakeWordDetection: async () => undefined,
    onWakeWordDetected: () => () => undefined,
    onWakeWordError: listener => {
      errorListener = listener;
      return () => {
        errorListener = undefined;
      };
    }
  };
  const detector = new IpcWakeWordDetector(bridge, builtInWakeWord);
  const states: string[] = [];
  detector.onStateChange(state => states.push(state));

  const starting = detector.start();
  errorListener?.("native detector failed");
  assert.equal(detector.state, "error");

  resolveStart?.();
  await assert.rejects(starting, WakeWordStartCancelledError);

  assert.equal(detector.state, "error");
  assert.deepEqual(states, ["starting", "error"]);
});

test("IpcWakeWordDetector detaches failed bridge listeners before an explicit retry", async () => {
  const detectionListeners = new Set<() => void>();
  const errorListeners = new Set<(message: string) => void>();
  const bridge: WakeWordBridge = {
    startWakeWordDetection: async () => undefined,
    stopWakeWordDetection: async () => undefined,
    onWakeWordDetected: listener => {
      detectionListeners.add(listener);
      return () => detectionListeners.delete(listener);
    },
    onWakeWordError: listener => {
      errorListeners.add(listener);
      return () => errorListeners.delete(listener);
    }
  };
  const detector = new IpcWakeWordDetector(bridge, builtInWakeWord);
  let detections = 0;
  detector.onDetected(() => detections++);

  await detector.start();
  for (const listener of errorListeners) {
    listener("microphone failed");
  }
  assert.equal(detector.state, "error");
  for (const listener of detectionListeners) {
    listener();
  }
  assert.equal(detections, 0);

  await detector.start();
  for (const listener of detectionListeners) {
    listener();
  }
  assert.equal(detections, 1);

  await detector.stop();
});
