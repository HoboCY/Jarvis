import { strict as assert } from "node:assert";
import { test } from "node:test";
import { MobileApiError } from "./MobileApiSession.js";
import { MobileLogoutCoordinator } from "./MobileLogoutCoordinator.js";

test("MobileLogoutCoordinator revokes before clearing mobile state", async () => {
  const calls: string[] = [];
  const coordinator = new MobileLogoutCoordinator({
    revoke: async () => { calls.push("revoke"); },
    stopVoice: async () => { calls.push("stop-voice"); },
    disconnectSignalR: async () => { calls.push("disconnect-signalr"); },
    clearFeed: () => { calls.push("clear-feed"); },
    clearCredentials: async () => { calls.push("clear-credentials"); }
  });

  await coordinator.logout();
  assert.deepEqual(calls, [
    "revoke",
    "stop-voice",
    "disconnect-signalr",
    "clear-feed",
    "clear-credentials"
  ]);
});

test("MobileLogoutCoordinator treats an already invalid session as terminal logout", async () => {
  const calls: string[] = [];
  const coordinator = new MobileLogoutCoordinator({
    revoke: async () => {
      calls.push("revoke");
      throw new MobileApiError(401, "session already revoked");
    },
    stopVoice: async () => { calls.push("stop-voice"); },
    disconnectSignalR: async () => { calls.push("disconnect-signalr"); },
    clearFeed: () => { calls.push("clear-feed"); },
    clearCredentials: async () => { calls.push("clear-credentials"); }
  });

  await coordinator.logout();
  assert.deepEqual(calls, [
    "revoke",
    "stop-voice",
    "disconnect-signalr",
    "clear-feed",
    "clear-credentials"
  ]);
});

test("MobileLogoutCoordinator preserves credentials after a retryable revoke failure", async () => {
  const calls: string[] = [];
  const coordinator = new MobileLogoutCoordinator({
    revoke: async () => {
      calls.push("revoke");
      throw new MobileApiError(503, "database busy");
    },
    stopVoice: async () => { calls.push("stop-voice"); },
    disconnectSignalR: async () => { calls.push("disconnect-signalr"); },
    clearFeed: () => { calls.push("clear-feed"); },
    clearCredentials: async () => { calls.push("clear-credentials"); }
  });

  await assert.rejects(coordinator.logout(), error => error instanceof MobileApiError && error.status === 503);
  assert.deepEqual(calls, ["revoke", "stop-voice", "disconnect-signalr", "clear-feed"]);
});

test("MobileLogoutCoordinator allows a retry after a temporary revoke failure", async () => {
  const calls: string[] = [];
  let attempts = 0;
  const coordinator = new MobileLogoutCoordinator({
    revoke: async () => {
      calls.push("revoke");
      attempts++;
      if (attempts === 1) {
        throw new MobileApiError(503, "database busy");
      }
    },
    stopVoice: async () => { calls.push("stop-voice"); },
    disconnectSignalR: async () => { calls.push("disconnect-signalr"); },
    clearFeed: () => { calls.push("clear-feed"); },
    clearCredentials: async () => { calls.push("clear-credentials"); }
  });

  await assert.rejects(coordinator.logout(), error => error instanceof MobileApiError && error.status === 503);
  await coordinator.logout();
  assert.deepEqual(calls, [
    "revoke", "stop-voice", "disconnect-signalr", "clear-feed",
    "revoke", "stop-voice", "disconnect-signalr", "clear-feed", "clear-credentials"
  ]);
});
