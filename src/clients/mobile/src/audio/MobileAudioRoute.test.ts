import { strict as assert } from "node:assert";
import { test } from "node:test";
import { MobileAudioRoute, type AudioRoute, type NativeAudioRouteBoundary } from "./MobileAudioRoute.js";

class FakeAudioRouteBoundary implements NativeAudioRouteBoundary {
  public permission: "granted" | "denied" = "granted";
  public starts = 0;
  public stops = 0;
  public route: AudioRoute = "system";
  private readonly listeners = new Set<(route: AudioRoute) => void>();

  async requestMicrophonePermission(): Promise<"granted" | "denied"> {
    return this.permission;
  }

  async startCallAudio(): Promise<void> {
    this.starts++;
  }

  async stopCallAudio(): Promise<void> {
    this.stops++;
  }

  getOutputRoute(): AudioRoute {
    return this.route;
  }

  async setOutputRoute(route: "system" | "speaker"): Promise<AudioRoute> {
    this.route = route;
    for (const listener of this.listeners) {
      listener(route);
    }
    return route;
  }

  subscribeOutputRoute(listener: (route: AudioRoute) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

class PolicyOnlyAudioRouteBoundary implements NativeAudioRouteBoundary {
  public requested: "system" | "speaker" = "system";
  private readonly listeners = new Set<(route: AudioRoute) => void>();

  async requestMicrophonePermission(): Promise<"granted" | "denied"> {
    return "granted";
  }

  async startCallAudio(): Promise<void> {
    // The native call session may not have an observable route immediately.
  }

  async stopCallAudio(): Promise<void> {
    // No-op test boundary.
  }

  getOutputRoute(): AudioRoute {
    return "unknown";
  }

  async setOutputRoute(route: "system" | "speaker"): Promise<AudioRoute> {
    this.requested = route;
    // Requesting a policy does not prove that the OS changed the route.
    return "unknown";
  }

  subscribeOutputRoute(listener: (route: AudioRoute) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

test("MobileAudioRoute denies a call before opening native audio", async () => {
  const boundary = new FakeAudioRouteBoundary();
  boundary.permission = "denied";
  const route = new MobileAudioRoute(boundary);

  await assert.rejects(route.start(), /microphone permission/i);
  assert.equal(boundary.starts, 0);
  assert.equal(route.active, false);
});

test("MobileAudioRoute starts and stops once and reports the OS-selected output route", async () => {
  const boundary = new FakeAudioRouteBoundary();
  const route = new MobileAudioRoute(boundary);
  const changes: AudioRoute[] = [];
  const unsubscribe = route.onRouteChanged(value => changes.push(value));

  await route.start();
  await route.start();
  assert.equal(boundary.starts, 1);
  assert.equal(route.outputRoute, "system");

  assert.equal(await route.setOutputRoute("speaker"), "speaker");
  assert.deepEqual(changes, ["speaker"]);
  await route.stop();
  await route.stop();
  assert.equal(boundary.stops, 1);
  unsubscribe();
});

test("MobileAudioRoute exposes requested output policy separately from observed route", async () => {
  const boundary = new PolicyOnlyAudioRouteBoundary();
  const route = new MobileAudioRoute(boundary);

  assert.equal(route.outputRoute, "unknown");
  await route.setOutputRoute("speaker");

  assert.equal(boundary.requested, "speaker");
  assert.equal(route.requestedOutputPolicy, "speaker");
  assert.equal(route.outputRoute, "unknown");
});

test("MobileAudioRoute cancels delayed permission before opening native call audio", async () => {
  let releasePermission!: (value: "granted") => void;
  let starts = 0;
  const boundary: NativeAudioRouteBoundary = {
    requestMicrophonePermission: () => new Promise(resolve => {
      releasePermission = resolve;
    }),
    startCallAudio: async () => { starts += 1; },
    stopCallAudio: async () => undefined,
    getOutputRoute: () => "unknown",
    setOutputRoute: async () => "unknown",
    subscribeOutputRoute: () => () => undefined
  };
  const route = new MobileAudioRoute(boundary);
  const start = route.start();
  await new Promise<void>(resolve => setImmediate(resolve));
  await route.stop();
  releasePermission("granted");

  await assert.rejects(start, /cancel|foreground/i);
  assert.equal(starts, 0);
  assert.equal(route.active, false);
});

test("MobileAudioRoute releases native audio if stop races call-audio activation", async () => {
  let releaseStart!: () => void;
  let stops = 0;
  const boundary: NativeAudioRouteBoundary = {
    requestMicrophonePermission: async () => "granted",
    startCallAudio: () => new Promise<void>(resolve => {
      releaseStart = resolve;
    }),
    stopCallAudio: async () => { stops += 1; },
    getOutputRoute: () => "unknown",
    setOutputRoute: async () => "unknown",
    subscribeOutputRoute: () => () => undefined
  };
  const route = new MobileAudioRoute(boundary);
  const start = route.start();
  await new Promise<void>(resolve => setImmediate(resolve));
  await route.stop();
  releaseStart();

  await assert.rejects(start, /cancel/i);
  assert.equal(stops, 1);
  assert.equal(route.active, false);
});
