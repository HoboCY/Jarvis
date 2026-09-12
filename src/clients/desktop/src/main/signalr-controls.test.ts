import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  SignalRControlCoordinator,
  type SignalRConnection
} from "./signalr-controls.js";

test("SignalR controls stop and start the existing connection once while publishing normal states", async () => {
  let startCalls = 0;
  let stopCalls = 0;
  const published: string[] = [];
  const connection: SignalRConnection = {
    start: async () => { startCalls++; },
    stop: async () => { stopCalls++; }
  };
  const controls = new SignalRControlCoordinator(() => connection, state => {
    published.push(state);
  });

  assert.equal(await controls.pause(), "paused");
  assert.equal(await controls.pause(), "paused");
  assert.equal(stopCalls, 1);
  assert.deepEqual(published, ["disconnected"]);

  assert.equal(await controls.resume(), "connected");
  assert.equal(await controls.resume(), "connected");
  assert.equal(startCalls, 1);
  assert.deepEqual(published, ["disconnected", "connecting", "connected"]);
  assert.equal(controls.getState(), "connected");
});

test("concurrent pause and resume are serialized and a failed resume remains paused for retry", async () => {
  let releaseStart!: () => void;
  let failStart = true;
  const startGate = new Promise<void>(resolve => { releaseStart = resolve; });
  const connection: SignalRConnection = {
    start: async () => {
      await startGate;
      if (failStart) {
        throw new Error("signalr unavailable");
      }
    },
    stop: async () => {}
  };
  const controls = new SignalRControlCoordinator(() => connection, () => {});
  await controls.pause();

  const firstResume = controls.resume();
  const duplicateResume = controls.resume();
  assert.equal(firstResume, duplicateResume);
  releaseStart();
  await assert.rejects(firstResume, /signalr unavailable/);
  assert.equal(controls.getState(), "paused");

  failStart = false;
  assert.equal(await controls.resume(), "connected");
});

test("a missing connection remains disconnected without exposing transport details", async () => {
  const published: string[] = [];
  const controls = new SignalRControlCoordinator(() => undefined, state => {
    published.push(state);
  });
  assert.equal(await controls.pause(), "paused");
  assert.equal(await controls.resume(), "disconnected");
  assert.deepEqual(published, ["disconnected", "disconnected"]);
});
