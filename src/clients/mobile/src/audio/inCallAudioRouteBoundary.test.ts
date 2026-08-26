import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  createInCallAudioRouteBoundary,
  type InCallAudioManager,
  type NativeAudioEventEmitter
} from "./inCallAudioRouteBoundary.js";

class FakeEventEmitter implements NativeAudioEventEmitter {
  private readonly listeners = new Map<string, Set<(payload: unknown) => void>>();

  addListener(eventName: string, listener: (payload: unknown) => void): { remove: () => void } {
    const listeners = this.listeners.get(eventName) ?? new Set();
    listeners.add(listener);
    this.listeners.set(eventName, listeners);
    return { remove: () => listeners.delete(listener) };
  }

  emit(eventName: string, payload: unknown): void {
    for (const listener of this.listeners.get(eventName) ?? []) {
      listener(payload);
    }
  }
}

class FakeInCallAudioManager implements InCallAudioManager {
  public readonly starts: { media?: "audio" | "video" }[] = [];
  public stops = 0;
  public readonly forceSpeakerFlags: (boolean | null)[] = [];
  public wiredHeadset = false;

  start(setup?: { media?: "audio" | "video" }): void {
    this.starts.push(setup ?? {});
  }

  stop(): void {
    this.stops += 1;
  }

  setForceSpeakerphoneOn(flag: boolean | null): void {
    this.forceSpeakerFlags.push(flag);
  }

  async getIsWiredHeadsetPluggedIn(): Promise<{ isWiredHeadsetPluggedIn: boolean }> {
    return { isWiredHeadsetPluggedIn: this.wiredHeadset };
  }
}

test("InCall audio boundary uses native call APIs and reports observed routes separately", async () => {
  const manager = new FakeInCallAudioManager();
  const events = new FakeEventEmitter();
  const boundary = createInCallAudioRouteBoundary({
    inCallManager: manager,
    deviceEventEmitter: events,
    requestMicrophonePermission: async () => "granted"
  });
  const observed: string[] = [];
  const unsubscribe = boundary.subscribeOutputRoute(route => observed.push(route));

  await boundary.startCallAudio();
  assert.deepEqual(manager.starts, [{ media: "audio" }]);
  assert.equal(boundary.getOutputRoute(), "unknown");

  events.emit("WiredHeadset", { isPlugged: true });
  assert.equal(boundary.getOutputRoute(), "headset");
  assert.deepEqual(observed, ["headset"]);

  const routeAfterSpeakerRequest = await boundary.setOutputRoute("speaker");
  assert.equal(routeAfterSpeakerRequest, "headset");
  assert.deepEqual(manager.forceSpeakerFlags, [true]);
  // A successful native policy call does not prove that hardware switched.
  assert.equal(boundary.getOutputRoute(), "headset");

  events.emit("NoisyAudio", null);
  assert.equal(boundary.getOutputRoute(), "unknown");
  assert.deepEqual(observed, ["headset", "unknown"]);

  const routeAfterSystemRequest = await boundary.setOutputRoute("system");
  assert.equal(routeAfterSystemRequest, "unknown");
  assert.deepEqual(manager.forceSpeakerFlags, [true, null]);

  unsubscribe();
  await boundary.stopCallAudio();
  assert.equal(manager.stops, 1);
});

test("InCall audio boundary maps a native wired-headset observation without claiming speaker state", async () => {
  const manager = new FakeInCallAudioManager();
  manager.wiredHeadset = true;
  const events = new FakeEventEmitter();
  const boundary = createInCallAudioRouteBoundary({
    inCallManager: manager,
    deviceEventEmitter: events,
    requestMicrophonePermission: async () => "granted"
  });

  await boundary.startCallAudio();
  assert.equal(boundary.getOutputRoute(), "headset");
  await boundary.setOutputRoute("speaker");
  assert.equal(boundary.getOutputRoute(), "headset");
});
