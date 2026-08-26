import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  MobileLifecycleController,
  type MobileLifecycleRuntime,
  type MobileAppStateSource,
  type MobileAppState
} from "./MobileLifecycleController.js";

class FakeAppState implements MobileAppStateSource {
  public state: MobileAppState = "background";
  private readonly listeners = new Set<(state: MobileAppState) => void>();

  subscribe(listener: (state: MobileAppState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(state: MobileAppState): void {
    this.state = state;
    for (const listener of this.listeners) {
      listener(state);
    }
  }
}

class FakeRuntime implements MobileLifecycleRuntime {
  public authRefreshes = 0;
  public recoveries = 0;
  public realtimeConnects = 0;
  public realtimeDisconnects = 0;
  public signalConnects = 0;
  public signalDisconnects = 0;
  public audioStops = 0;
  public authenticated = true;

  async refreshAuth(): Promise<boolean> {
    this.authRefreshes++;
    return this.authenticated;
  }

  async recoverHttpState(): Promise<void> {
    this.recoveries++;
  }

  async connectRealtime(): Promise<void> {
    this.realtimeConnects++;
  }

  async disconnectRealtime(): Promise<void> {
    this.realtimeDisconnects++;
  }

  async connectSignalR(): Promise<void> {
    this.signalConnects++;
  }

  async disconnectSignalR(): Promise<void> {
    this.signalDisconnects++;
  }

  async stopAudio(): Promise<void> {
    this.audioStops++;
  }
}

test("MobileLifecycleController enters foreground once and recovers before realtime", async () => {
  const source = new FakeAppState();
  const runtime = new FakeRuntime();
  const controller = new MobileLifecycleController(source, runtime);

  await controller.start();
  assert.equal(runtime.authRefreshes, 0);
  source.emit("active");
  await controller.whenIdle();
  source.emit("active");
  await controller.whenIdle();
  assert.equal(runtime.authRefreshes, 1);
  assert.equal(runtime.recoveries, 1);
  assert.equal(runtime.signalConnects, 1);
  assert.equal(runtime.realtimeConnects, 1);
});

test("MobileLifecycleController stops audio, realtime, and SignalR on background", async () => {
  const source = new FakeAppState();
  const runtime = new FakeRuntime();
  const controller = new MobileLifecycleController(source, runtime);

  await controller.start();
  source.emit("active");
  await controller.whenIdle();
  source.emit("background");
  await controller.whenIdle();
  source.emit("background");
  await controller.whenIdle();

  assert.equal(runtime.audioStops, 1);
  assert.equal(runtime.realtimeDisconnects, 1);
  assert.equal(runtime.signalDisconnects, 1);
  controller.dispose();
});

test("MobileLifecycleController can re-enter the foreground pipeline after pairing", async () => {
  const source = new FakeAppState();
  const runtime = new FakeRuntime();
  runtime.authenticated = false;
  const controller = new MobileLifecycleController(source, runtime);

  await controller.start();
  source.emit("active");
  await controller.whenIdle();
  assert.equal(runtime.signalConnects, 0);

  runtime.authenticated = true;
  await controller.recoverForeground();
  assert.equal(runtime.authRefreshes, 2);
  assert.equal(runtime.recoveries, 1);
  assert.equal(runtime.signalConnects, 1);
  assert.equal(runtime.realtimeConnects, 1);
  controller.dispose();
});
