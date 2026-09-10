import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  DesktopRealtimeSessionRegistry,
  DesktopShutdownCoordinator,
  type DesktopShutdownDependencies,
  type DesktopShutdownRendererTarget,
  type DesktopShutdownSession,
  type DesktopShutdownTerminalOperation
} from "./desktop-shutdown.js";

const activeSessionId = "0199f1b8-1234-7000-8000-0123456789ab";
const replacementSessionId = "0199f1b8-1235-7000-8000-0123456789ab";
const secondReplacementSessionId = "0199f1b8-1237-7000-8000-0123456789ab";
const trustedBearer = "t".repeat(32);
const terminalOperation = (
  idempotencyKey = "0199f1b8-1238-7000-8000-0123456789ab",
  reason = "test-terminal",
  status: "rotated" | "disconnected" | "failed" = "disconnected"
): DesktopShutdownTerminalOperation => ({
  idempotencyKey,
  intent: { reason, status }
});

function createHarness(options: {
  renderer?: "available" | "destroyed" | "none";
  bearer?: string;
  timeoutMs?: number;
  fallback?: DesktopShutdownDependencies["fallbackMainSession"];
  stopWake?: DesktopShutdownDependencies["stopWake"];
  stopSignalR?: DesktopShutdownDependencies["stopSignalR"];
} = {}) {
  const sender = {};
  const frame = {};
  const events: string[] = [];
  const sent: Array<{ channel: string; requestId: string }> = [];
  const target: DesktopShutdownRendererTarget | undefined = options.renderer === "none"
    ? undefined
    : {
        sender,
        frame,
        isDestroyed: () => options.renderer === "destroyed",
        send: (channel, value) => {
          sent.push({ channel, requestId: (value as { requestId: string }).requestId });
        }
      };
  const registry = new DesktopRealtimeSessionRegistry();
  registry.markConnected({ sessionId: activeSessionId, externalSessionId: "provider-session", bearer: options.bearer });
  const dependencies: DesktopShutdownDependencies = {
    getRendererTarget: () => target,
    getActiveSession: () => registry.activeSession,
    fallbackMainSession: options.fallback ?? (async () => { events.push("fallback"); }),
    freeze: () => { events.push("freeze"); },
    stopWake: options.stopWake ?? (async () => { events.push("stopWake"); }),
    stopSignalR: options.stopSignalR ?? (async () => { events.push("stopSignalR"); }),
    closeWindows: () => { events.push("closeWindows"); },
    continueQuit: () => { events.push("continueQuit"); },
    createRequestId: () => "0199f1b8-1236-7000-8000-0123456789ab",
    timeoutMs: options.timeoutMs ?? 25
  };
  const coordinator = new DesktopShutdownCoordinator(dependencies);
  return {
    coordinator,
    registry,
    sender,
    frame,
    sent,
    events,
    target
  };
}

test("first quit prevents default, freezes lifecycle, sends one exact shutdown request, and awaits one matching ACK", async () => {
  const harness = createHarness({ bearer: trustedBearer });
  let preventDefaultCalls = 0;
  harness.coordinator.requestQuit({ preventDefault: () => { preventDefaultCalls++; } });
  assert.equal(preventDefaultCalls, 1);
  assert.deepEqual(harness.events.slice(0, 1), ["freeze"]);
  assert.deepEqual(harness.sent, [{
    channel: "app:prepareShutdown",
    requestId: "0199f1b8-1236-7000-8000-0123456789ab"
  }]);
  assert.equal(harness.registry.markEnded(activeSessionId), true);

  assert.equal(harness.coordinator.handleShutdownAck({
    sender: harness.sender,
    frame: harness.frame,
    requestId: "0199f1b8-1236-7000-8000-0123456789ab",
    status: "completed"
  }), true);
  const result = await harness.coordinator.waitForCompletion();
  assert.equal(result.status, "acknowledged");
  assert.deepEqual(harness.events, ["freeze", "stopWake", "stopSignalR", "closeWindows", "continueQuit"]);
  assert.equal(harness.coordinator.handleShutdownAck({
    sender: harness.sender,
    frame: harness.frame,
    requestId: "0199f1b8-1236-8000-8000-0123456789ab",
    status: "completed"
  }), false);

  let secondPreventDefaultCalls = 0;
  harness.coordinator.requestQuit({ preventDefault: () => { secondPreventDefaultCalls++; } });
  assert.equal(secondPreventDefaultCalls, 0);
  assert.equal(harness.events.filter(event => event === "continueQuit").length, 1);
});

test("shutdown ignores invalid sender, frame, and request id without acknowledging or closing", async () => {
  const harness = createHarness({ bearer: trustedBearer });
  harness.coordinator.requestQuit({ preventDefault: () => {} });
  for (const ack of [
    { sender: {}, frame: harness.frame, requestId: "0199f1b8-1236-7000-8000-0123456789ab", status: "completed" as const },
    { sender: harness.sender, frame: {}, requestId: "0199f1b8-1236-7000-8000-0123456789ab", status: "completed" as const },
    { sender: harness.sender, frame: harness.frame, requestId: "not-a-uuid", status: "completed" as const }
  ]) {
    assert.equal(harness.coordinator.handleShutdownAck(ack), false);
  }
  assert.deepEqual(harness.events, ["freeze"]);
  assert.equal(harness.sent.length, 1);
  assert.equal(harness.coordinator.handleShutdownAck({
    sender: harness.sender,
    frame: harness.frame,
    requestId: "0199f1b8-1236-7000-8000-0123456789ab",
    status: "completed"
  }), true);
  await harness.coordinator.waitForCompletion();
});

test("a synchronous renderer send can return the exact ACK before requestQuit assigns its completion promise", async () => {
  const sender = {};
  const frame = {};
  const requestId = "0199f1b8-1236-7000-8000-0123456789ab";
  const holder: { coordinator?: DesktopShutdownCoordinator } = {};
  const dependencies: DesktopShutdownDependencies = {
    getRendererTarget: () => ({
      sender,
      frame,
      isDestroyed: () => false,
      send: () => {
        assert.equal(holder.coordinator?.handleShutdownAck({ sender, frame, requestId, status: "completed" }), true);
      }
    }),
    getActiveSession: () => undefined,
    fallbackMainSession: async () => {},
    freeze: () => {},
    stopWake: () => {},
    stopSignalR: () => {},
    closeWindows: () => {},
    continueQuit: () => {},
    createRequestId: () => requestId,
    timeoutMs: 25
  };
  const coordinator = new DesktopShutdownCoordinator(dependencies);
  holder.coordinator = coordinator;
  coordinator.requestQuit({ preventDefault: () => {} });
  assert.equal((await coordinator.waitForCompletion()).status, "acknowledged");
});

test("renderer timeout uses the registered bearer fallback exactly once and remains bounded", async () => {
  const fallbackCalls: Array<{ sessionId: string; reason: string; status: string; bearer?: string }> = [];
  const harness = createHarness({
    bearer: trustedBearer,
    timeoutMs: 50,
    fallback: async session => {
      fallbackCalls.push(session);
    }
  });
  harness.coordinator.requestQuit({ preventDefault: () => {} });
  const result = await harness.coordinator.waitForCompletion();
  assert.equal(result.status, "fallback");
  assert.deepEqual(fallbackCalls, [{
    sessionId: activeSessionId,
    externalSessionId: "provider-session",
    reason: "desktop-quit-main-fallback",
    status: "disconnected",
    bearer: trustedBearer
  }]);
  assert.deepEqual(harness.events, ["freeze", "stopWake", "stopSignalR", "closeWindows", "continueQuit"]);
});

test("destroyed renderer falls back only for a registered session, while no bearer closes honestly without fallback", async () => {
  const destroyedFallbackCalls: string[] = [];
  const destroyed = createHarness({
    renderer: "destroyed",
    bearer: trustedBearer,
    fallback: async session => { destroyedFallbackCalls.push(session.sessionId); }
  });
  destroyed.coordinator.requestQuit({ preventDefault: () => {} });
  assert.equal((await destroyed.coordinator.waitForCompletion()).status, "fallback");
  assert.deepEqual(destroyedFallbackCalls, [activeSessionId]);

  const noBearerFallbackCalls: string[] = [];
  const noBearer = createHarness({
    renderer: "destroyed",
    fallback: async session => { noBearerFallbackCalls.push(session.sessionId); }
  });
  noBearer.coordinator.requestQuit({ preventDefault: () => {} });
  assert.equal((await noBearer.coordinator.waitForCompletion()).status, "no-bearer");
  assert.deepEqual(noBearerFallbackCalls, []);
  assert.deepEqual(noBearer.events, ["freeze", "stopWake", "stopSignalR", "closeWindows", "continueQuit"]);
});

test("failed renderer shutdown still completes bounded cleanup and reports fallback failure", async () => {
  const harness = createHarness({
    bearer: trustedBearer,
    fallback: async () => { throw new Error("backend unavailable"); }
  });
  harness.coordinator.requestQuit({ preventDefault: () => {} });
  assert.equal(harness.coordinator.handleShutdownAck({
    sender: harness.sender,
    frame: harness.frame,
    requestId: "0199f1b8-1236-7000-8000-0123456789ab",
    status: "failed"
  }), true);
  const result = await harness.coordinator.waitForCompletion();
  assert.equal(result.status, "fallback-failed");
  assert.equal(result.errorCode, "BACKEND_UNAVAILABLE");
  assert.deepEqual(harness.events, ["freeze", "stopWake", "stopSignalR", "closeWindows", "continueQuit"]);
});

test("a hanging fallback and cleanup hooks cannot hold quit beyond the shared deadline", async () => {
  const never = new Promise<void>(() => {});
  const harness = createHarness({
    renderer: "destroyed",
    bearer: trustedBearer,
    timeoutMs: 20,
    fallback: async () => never,
    stopWake: async () => never,
    stopSignalR: async () => never
  });
  const startedAt = Date.now();
  harness.coordinator.requestQuit({ preventDefault: () => {} });
  const result = await harness.coordinator.waitForCompletion();
  assert.equal(result.status, "fallback-failed");
  assert.equal(result.errorCode, "SHUTDOWN_TIMEOUT");
  assert.ok(Date.now() - startedAt < 250);
  assert.deepEqual(harness.events, ["freeze", "closeWindows", "continueQuit"]);
});

test("quit waits for an in-flight Connected operation before accepting a renderer completion ACK", async () => {
  const sender = {};
  const frame = {};
  const requestId = "0199f1b8-1236-7000-8000-0123456789ab";
  const registry = new DesktopRealtimeSessionRegistry();
  let releasePending!: () => void;
  const pending = new Promise<void>(resolve => { releasePending = resolve; });
  registry.trackPendingConnection(pending);
  const events: string[] = [];
  const dependencies: DesktopShutdownDependencies = {
    getRendererTarget: () => ({
      sender,
      frame,
      isDestroyed: () => false,
      send: () => {}
    }),
    getActiveSession: () => registry.activeSession,
    fallbackMainSession: async () => { events.push("fallback"); },
    clearSession: sessionId => { registry.clearIfCurrent(sessionId); },
    freeze: () => { registry.freeze(); events.push("freeze"); },
    stopWake: () => { events.push("stopWake"); },
    stopSignalR: () => { events.push("stopSignalR"); },
    closeWindows: () => { events.push("closeWindows"); },
    continueQuit: () => { events.push("continueQuit"); },
    waitForPendingOperations: () => registry.waitForPendingConnections(),
    createRequestId: () => requestId,
    timeoutMs: 100
  };
  const coordinator = new DesktopShutdownCoordinator(dependencies);
  coordinator.requestQuit({ preventDefault: () => {} });
  assert.equal(coordinator.handleShutdownAck({ sender, frame, requestId, status: "completed" }), true);
  await Promise.resolve();
  assert.deepEqual(events, ["freeze"]);
  releasePending();
  assert.equal((await coordinator.waitForCompletion()).status, "acknowledged");
  assert.deepEqual(events, ["freeze", "stopWake", "stopSignalR", "closeWindows", "continueQuit"]);
});

test("a completed renderer ACK still falls back when Main registered the session before renderer activation", async () => {
  const sender = {};
  const frame = {};
  const requestId = "0199f1b8-1242-7000-8000-0123456789ab";
  const registry = new DesktopRealtimeSessionRegistry();
  registry.markConnected({ sessionId: activeSessionId, externalSessionId: "provider-session", bearer: trustedBearer });
  let fallbackCalls = 0;
  const coordinator = new DesktopShutdownCoordinator({
    getRendererTarget: () => ({ sender, frame, isDestroyed: () => false, send: () => {} }),
    getActiveSession: () => registry.activeSession,
    fallbackMainSession: async session => {
      fallbackCalls++;
      registry.markTerminalCompleted(session.sessionId);
    },
    clearSession: sessionId => { registry.clearIfCurrent(sessionId); },
    freeze: () => { registry.freeze(); },
    stopWake: () => {},
    stopSignalR: () => {},
    closeWindows: () => {},
    continueQuit: () => {},
    waitForPendingOperations: () => registry.waitForPendingOperations(),
    createRequestId: () => requestId,
    timeoutMs: 100
  });

  coordinator.requestQuit({ preventDefault: () => {} });
  assert.equal(coordinator.handleShutdownAck({ sender, frame, requestId, status: "completed" }), true);
  assert.equal((await coordinator.waitForCompletion()).status, "fallback");
  assert.equal(fallbackCalls, 1);
  assert.equal(registry.activeSession, undefined);
});

test("concurrent terminal finalization uses one in-flight operation and remains visible to quit", async () => {
  const registry = new DesktopRealtimeSessionRegistry();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let terminalCalls = 0;
  const first = registry.runPendingTerminal(activeSessionId, async () => {
    terminalCalls++;
    await gate;
    return true;
  }, terminalOperation());
  const duplicate = registry.runPendingTerminal(activeSessionId, async () => {
    terminalCalls++;
    return true;
  }, terminalOperation());
  assert.equal(first, duplicate);
  await Promise.resolve();
  assert.equal(terminalCalls, 1);

  const waiting = registry.waitForPendingOperations();
  let waitingCompleted = false;
  void waiting.then(() => { waitingCompleted = true; });
  await Promise.resolve();
  assert.equal(waitingCompleted, false);

  release();
  assert.equal(await first, true);
  assert.equal(await waiting, true);
});

test("a failed renderer terminal lets Main perform one fallback after the pending end settles", async () => {
  const sender = {};
  const frame = {};
  const requestId = "0199f1b8-1236-7000-8000-0123456789ab";
  const registry = new DesktopRealtimeSessionRegistry();
  registry.markConnected({ sessionId: activeSessionId, externalSessionId: "provider-session", bearer: trustedBearer });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let fallbackCalls = 0;
  registry.runPendingTerminal(activeSessionId, async () => {
    await gate;
    return false;
  }, terminalOperation());
  const events: string[] = [];
  const coordinator = new DesktopShutdownCoordinator({
    getRendererTarget: () => ({ sender, frame, isDestroyed: () => false, send: () => {} }),
    getActiveSession: () => registry.activeSession,
    fallbackMainSession: async () => { fallbackCalls++; },
    clearSession: sessionId => { registry.clearIfCurrent(sessionId); },
    freeze: () => { registry.freeze(); events.push("freeze"); },
    stopWake: () => { events.push("stopWake"); },
    stopSignalR: () => { events.push("stopSignalR"); },
    closeWindows: () => { events.push("closeWindows"); },
    continueQuit: () => { events.push("continueQuit"); },
    waitForPendingOperations: () => registry.waitForPendingOperations(),
    createRequestId: () => requestId,
    timeoutMs: 100
  });
  coordinator.requestQuit({ preventDefault: () => {} });
  assert.equal(coordinator.handleShutdownAck({ sender, frame, requestId, status: "failed" }), true);
  const completion = coordinator.waitForCompletion();
  await Promise.resolve();
  assert.equal(fallbackCalls, 0);
  release();
  assert.equal((await completion).status, "fallback");
  assert.equal(fallbackCalls, 1);
  assert.deepEqual(events, ["freeze", "stopWake", "stopSignalR", "closeWindows", "continueQuit"]);
});

test("a hanging normal terminal is taken over in the reserved shutdown slice with the same idempotency key", async t => {
  let virtualNow = 10_000;
  t.mock.method(performance, "now", () => virtualNow);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sender = {};
  const frame = {};
  const requestId = "0199f1b8-1236-7000-8000-0123456789ab";
  const terminalKey = "0199f1b8-1238-7000-8000-0123456789ab";
  const terminalIntent = { reason: "user-requested", status: "disconnected" as const };
  const registry = new DesktopRealtimeSessionRegistry();
  registry.markConnected({ sessionId: activeSessionId, externalSessionId: "provider-session", bearer: trustedBearer });
  const never = new Promise<void>(() => {});
  registry.runPendingTerminal(activeSessionId, async () => never, {
    idempotencyKey: terminalKey,
    intent: terminalIntent
  });
  const fallbackSessions: Array<{
    idempotencyKey?: string;
    takeoverPendingTerminal?: boolean;
    reason: string;
    status: string;
    terminalIntent?: { reason: string; status: string };
  }> = [];
  let terminalCalls = 0;
  const events: string[] = [];
  const coordinator = new DesktopShutdownCoordinator({
    getRendererTarget: () => ({ sender, frame, isDestroyed: () => true, send: () => {} }),
    getActiveSession: () => registry.activeSession,
    getPendingTerminalIdempotencyKey: sessionId => registry.getPendingTerminalIdempotencyKey(sessionId),
    getPendingTerminalIntent: sessionId => registry.getPendingTerminalIntent(sessionId),
    fallbackMainSession: async session => {
      fallbackSessions.push({
        idempotencyKey: session.idempotencyKey,
        takeoverPendingTerminal: session.takeoverPendingTerminal,
        reason: session.reason,
        status: session.status,
        terminalIntent: session.terminalIntent
      });
      await registry.takeoverPendingTerminal(session.sessionId, async () => {
        terminalCalls++;
        registry.markTerminalCompleted(session.sessionId);
      }, {
        idempotencyKey: session.idempotencyKey!,
        intent: session.terminalIntent!
      });
    },
    clearSession: sessionId => { registry.clearIfCurrent(sessionId); },
    freeze: () => { registry.freeze(); events.push("freeze"); },
    stopWake: () => { events.push("stopWake"); },
    stopSignalR: () => { events.push("stopSignalR"); },
    closeWindows: () => { events.push("closeWindows"); },
    continueQuit: () => { events.push("continueQuit"); },
    waitForPendingOperations: () => registry.waitForPendingOperations(),
    createRequestId: () => requestId,
    timeoutMs: 80
  });

  coordinator.requestQuit({ preventDefault: () => {} });
  virtualNow += 59;
  t.mock.timers.tick(59);
  await Promise.resolve();
  assert.equal(terminalCalls, 0);
  virtualNow += 1;
  t.mock.timers.tick(1);
  const result = await coordinator.waitForCompletion();
  assert.equal(result.status, "fallback");
  assert.deepEqual(fallbackSessions, [{
    idempotencyKey: terminalKey,
    takeoverPendingTerminal: true,
    reason: terminalIntent.reason,
    status: terminalIntent.status,
    terminalIntent
  }]);
  assert.equal(terminalCalls, 1);
  assert.equal(registry.activeSession, undefined);
  assert.deepEqual(events, ["freeze", "stopWake", "stopSignalR", "closeWindows", "continueQuit"]);
});

test("a failed terminal retry retains its original idempotency key before fallback completion", async () => {
  const registry = new DesktopRealtimeSessionRegistry();
  const terminalKey = "0199f1b8-1239-7000-8000-0123456789ab";
  registry.markConnected({ sessionId: activeSessionId, externalSessionId: "provider-session", bearer: trustedBearer });
  await assert.rejects(registry.runPendingTerminal(
    activeSessionId,
    async () => { throw new Error("backend unavailable"); },
    terminalOperation(terminalKey)));

  let retriedKey: string | undefined;
  await registry.runPendingTerminal(activeSessionId, async () => {
    retriedKey = registry.getPendingTerminalIdempotencyKey(activeSessionId);
    registry.markTerminalCompleted(activeSessionId);
  }, terminalOperation(registry.getPendingTerminalIdempotencyKey(activeSessionId)!));
  assert.equal(retriedKey, terminalKey);
  assert.equal(registry.activeSession, undefined);
});

test("a Main-completed compensation makes later renderer terminal retries a no-op", async () => {
  const registry = new DesktopRealtimeSessionRegistry();
  registry.markConnected({ sessionId: activeSessionId, externalSessionId: "provider-session", bearer: trustedBearer });
  assert.equal(registry.markEnded(activeSessionId), true);

  let terminalCalls = 0;
  const result = await registry.runPendingTerminal(activeSessionId, async () => {
    terminalCalls++;
    return "must-not-send";
  }, terminalOperation("0199f1b8-1240-7000-8000-0123456789ab"));
  assert.equal(result, undefined);
  assert.equal(terminalCalls, 0);
  assert.equal(registry.markConnected({
    sessionId: activeSessionId,
    externalSessionId: "late-provider-session",
    bearer: trustedBearer
  }), false);
});

test("terminal takeover preserves the original request hash when the first response arrives late", async () => {
  const registry = new DesktopRealtimeSessionRegistry();
  const terminalKey = "0199f1b8-1241-7000-8000-0123456789ab";
  const terminalIntent = { reason: "idle-50-minute-rotation", status: "rotated" as const };
  registry.markConnected({ sessionId: activeSessionId, externalSessionId: "provider-session", bearer: trustedBearer });
  let releaseOriginal!: () => void;
  const originalGate = new Promise<void>(resolve => { releaseOriginal = resolve; });
  const requestHashes: Array<{ key: string; reason: string; status: string }> = [];
  const original = registry.runPendingTerminal(activeSessionId, async () => {
    requestHashes.push({ key: terminalKey, ...terminalIntent });
    await originalGate;
    registry.markTerminalCompleted(activeSessionId);
  }, { idempotencyKey: terminalKey, intent: terminalIntent });
  const takeover = registry.takeoverPendingTerminal(activeSessionId, async () => {
    requestHashes.push({
      key: registry.getPendingTerminalIdempotencyKey(activeSessionId)!,
      ...(registry.getPendingTerminalIntent(activeSessionId) ?? terminalIntent)
    });
    registry.markTerminalCompleted(activeSessionId);
  }, {
    idempotencyKey: registry.getPendingTerminalIdempotencyKey(activeSessionId)!,
    intent: registry.getPendingTerminalIntent(activeSessionId)!
  });

  await takeover;
  releaseOriginal();
  await original;
  assert.deepEqual(requestHashes, [
    { key: terminalKey, reason: terminalIntent.reason, status: terminalIntent.status },
    { key: terminalKey, reason: terminalIntent.reason, status: terminalIntent.status }
  ]);
  assert.equal(registry.activeSession, undefined);
});

test("a pending Connected operation is recovered with the original request before quit continues", async () => {
  const sender = {};
  const frame = {};
  const requestId = "0199f1b8-1243-7000-8000-0123456789ab";
  const connectionIntent = {
    sessionId: activeSessionId,
    externalSessionId: "provider-session",
    bearer: trustedBearer,
    idempotencyKey: "0199f1b8-1244-7000-8000-0123456789ab"
  };
  const registry = new DesktopRealtimeSessionRegistry();
  const never = new Promise<void>(() => {});
  registry.trackPendingConnection(Promise.resolve().then(() => never), connectionIntent);
  let recoveryCalls = 0;
  const coordinator = new DesktopShutdownCoordinator({
    getRendererTarget: () => ({ sender, frame, isDestroyed: () => true, send: () => {} }),
    getActiveSession: () => registry.activeSession,
    getRegisteredSessions: () => registry.getRegisteredSessions(),
    getPendingConnectionIntents: () => registry.getPendingConnectionIntents(),
    recoverPendingConnection: intent => {
      recoveryCalls++;
      return registry.takeoverPendingConnection(intent, async () => {
        assert.equal(registry.acceptPendingConnectionDuringShutdown(intent), true);
        registry.markTerminalCompleted(intent.sessionId);
      });
    },
    fallbackMainSession: async () => {},
    clearSession: sessionId => { registry.clearIfCurrent(sessionId); },
    freeze: () => { registry.freeze(); },
    stopWake: () => {},
    stopSignalR: () => {},
    closeWindows: () => {},
    continueQuit: () => {},
    waitForPendingOperations: () => registry.waitForPendingOperations(),
    createRequestId: () => requestId,
    timeoutMs: 80
  });

  coordinator.requestQuit({ preventDefault: () => {} });
  const result = await coordinator.waitForCompletion();
  assert.equal(result.status, "fallback");
  assert.equal(recoveryCalls, 1);
  assert.equal(registry.activeSession, undefined);
  assert.equal(registry.isTerminalCompleted(activeSessionId), true);
  assert.equal(registry.markConnected({
    sessionId: activeSessionId,
    externalSessionId: "late-provider-session",
    bearer: trustedBearer
  }), false);
});

test("an unresponsive Connected recovery reports timeout without inventing a session", async () => {
  const registry = new DesktopRealtimeSessionRegistry();
  const never = new Promise<void>(() => {});
  const connectionIntent = {
    sessionId: activeSessionId,
    externalSessionId: "provider-session",
    bearer: trustedBearer,
    idempotencyKey: "0199f1b8-1245-7000-8000-0123456789ab"
  };
  registry.trackPendingConnection(Promise.resolve().then(() => never), connectionIntent);
  const coordinator = new DesktopShutdownCoordinator({
    getRendererTarget: () => undefined,
    getActiveSession: () => registry.activeSession,
    getRegisteredSessions: () => registry.getRegisteredSessions(),
    getPendingConnectionIntents: () => registry.getPendingConnectionIntents(),
    recoverPendingConnection: () => never,
    fallbackMainSession: async () => {},
    freeze: () => { registry.freeze(); },
    stopWake: () => {},
    stopSignalR: () => {},
    closeWindows: () => {},
    continueQuit: () => {},
    waitForPendingOperations: () => registry.waitForPendingOperations(),
    createRequestId: () => "0199f1b8-1246-7000-8000-0123456789ab",
    timeoutMs: 30
  });

  coordinator.requestQuit({ preventDefault: () => {} });
  const result = await coordinator.waitForCompletion();
  assert.deepEqual(result, { status: "fallback-failed", errorCode: "SHUTDOWN_TIMEOUT" });
  assert.equal(registry.activeSession, undefined);
});

test("a confirmed session gets a fallback attempt while a replacement Connected recovery hangs", async () => {
  const oldSessionId = "0199f1b8-1256-7000-8000-0123456789ab";
  const pendingSessionId = "0199f1b8-1257-7000-8000-0123456789ab";
  const registry = new DesktopRealtimeSessionRegistry();
  registry.markConnected({
    sessionId: oldSessionId,
    externalSessionId: "old-provider",
    bearer: trustedBearer
  });
  const never = new Promise<void>(() => {});
  registry.trackPendingConnection(Promise.resolve().then(() => never), {
    sessionId: pendingSessionId,
    externalSessionId: "pending-provider",
    bearer: trustedBearer,
    idempotencyKey: "0199f1b8-1258-7000-8000-0123456789ab"
  });
  const fallbackSessions: string[] = [];
  let recoveryStarted!: () => void;
  const recoveryStartedPromise = new Promise<void>(resolve => { recoveryStarted = resolve; });
  const coordinator = new DesktopShutdownCoordinator({
    getRendererTarget: () => undefined,
    getActiveSession: () => registry.activeSession,
    getRegisteredSessions: () => registry.getRegisteredSessions(),
    getPendingConnectionIntents: () => registry.getPendingConnectionIntents(),
    recoverPendingConnection: () => {
      recoveryStarted();
      return never;
    },
    fallbackMainSession: async session => {
      fallbackSessions.push(session.sessionId);
      registry.markTerminalCompleted(session.sessionId);
    },
    clearSession: sessionId => { registry.clearIfCurrent(sessionId); },
    freeze: () => { registry.freeze(); },
    stopWake: () => {},
    stopSignalR: () => {},
    closeWindows: () => {},
    continueQuit: () => {},
    waitForPendingOperations: () => registry.waitForPendingOperations(),
    createRequestId: () => "0199f1b8-1259-7000-8000-0123456789ab",
    timeoutMs: 100
  });

  coordinator.requestQuit({ preventDefault: () => {} });
  const completion = coordinator.waitForCompletion();
  await recoveryStartedPromise;
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(fallbackSessions, [oldSessionId]);
  const result = await completion;
  assert.deepEqual(fallbackSessions, [oldSessionId]);
  assert.equal(registry.isTerminalCompleted(oldSessionId), true);
  assert.deepEqual(result, { status: "fallback" });
});

test("quit closes every confirmed session, including an old rotation without a terminal intent", async () => {
  const oldSessionId = "0199f1b8-1247-7000-8000-0123456789ab";
  const currentSessionId = "0199f1b8-1248-7000-8000-0123456789ab";
  const registry = new DesktopRealtimeSessionRegistry();
  registry.markConnected({ sessionId: oldSessionId, externalSessionId: "old-provider", bearer: trustedBearer });
  registry.markConnected({ sessionId: currentSessionId, externalSessionId: "current-provider", bearer: trustedBearer });
  const closed: string[] = [];
  const coordinator = new DesktopShutdownCoordinator({
    getRendererTarget: () => undefined,
    getActiveSession: () => registry.activeSession,
    getRegisteredSessions: () => registry.getRegisteredSessions(),
    getPendingTerminalIdempotencyKey: sessionId => registry.getPendingTerminalIdempotencyKey(sessionId),
    getPendingTerminalIntent: sessionId => registry.getPendingTerminalIntent(sessionId),
    fallbackMainSession: async session => {
      closed.push(session.sessionId);
      const terminal = {
        idempotencyKey: session.idempotencyKey ?? "0199f1b8-1250-7000-8000-0123456789ab",
        intent: session.terminalIntent ?? { reason: session.reason, status: session.status }
      };
      const run = session.takeoverPendingTerminal
        ? registry.takeoverPendingTerminal(session.sessionId, async () => {
          registry.markTerminalCompleted(session.sessionId);
        }, terminal)
        : registry.runPendingTerminal(session.sessionId, async () => {
          registry.markTerminalCompleted(session.sessionId);
        }, terminal);
      await run;
    },
    clearSession: sessionId => { registry.clearIfCurrent(sessionId); },
    freeze: () => { registry.freeze(); },
    stopWake: () => {},
    stopSignalR: () => {},
    closeWindows: () => {},
    continueQuit: () => {},
    waitForPendingOperations: () => registry.waitForPendingOperations(),
    createRequestId: () => "0199f1b8-1251-7000-8000-0123456789ab",
    timeoutMs: 80
  });

  coordinator.requestQuit({ preventDefault: () => {} });
  assert.equal((await coordinator.waitForCompletion()).status, "fallback");
  assert.deepEqual(closed.sort(), [oldSessionId, currentSessionId].sort());
  assert.equal(registry.getRegisteredSessions().length, 0);
});

test("quit takes over a hanging terminal for an old non-active rotation session", async () => {
  const oldSessionId = "0199f1b8-1252-7000-8000-0123456789ab";
  const currentSessionId = "0199f1b8-1253-7000-8000-0123456789ab";
  const oldKey = "0199f1b8-1254-7000-8000-0123456789ab";
  const oldIntent = { reason: "idle-50-minute-rotation", status: "rotated" as const };
  const registry = new DesktopRealtimeSessionRegistry();
  registry.markConnected({ sessionId: oldSessionId, externalSessionId: "old-provider", bearer: trustedBearer });
  registry.markConnected({ sessionId: currentSessionId, externalSessionId: "current-provider", bearer: trustedBearer });
  registry.runPendingTerminal(oldSessionId, async () => new Promise<void>(() => {}), {
    idempotencyKey: oldKey,
    intent: oldIntent
  });
  const takeoverFlags: Array<{ sessionId: string; takeover: boolean; key?: string }> = [];
  const coordinator = new DesktopShutdownCoordinator({
    getRendererTarget: () => undefined,
    getActiveSession: () => registry.activeSession,
    getRegisteredSessions: () => registry.getRegisteredSessions(),
    getPendingTerminalIdempotencyKey: sessionId => registry.getPendingTerminalIdempotencyKey(sessionId),
    getPendingTerminalIntent: sessionId => registry.getPendingTerminalIntent(sessionId),
    fallbackMainSession: async session => {
      takeoverFlags.push({
        sessionId: session.sessionId,
        takeover: session.takeoverPendingTerminal === true,
        key: session.idempotencyKey
      });
      const operation = {
        idempotencyKey: session.idempotencyKey ?? "0199f1b8-1255-7000-8000-0123456789ab",
        intent: session.terminalIntent ?? { reason: session.reason, status: session.status }
      };
      const run = session.takeoverPendingTerminal
        ? registry.takeoverPendingTerminal(session.sessionId, async () => {
          registry.markTerminalCompleted(session.sessionId);
        }, operation)
        : registry.runPendingTerminal(session.sessionId, async () => {
          registry.markTerminalCompleted(session.sessionId);
        }, operation);
      await run;
    },
    clearSession: sessionId => { registry.clearIfCurrent(sessionId); },
    freeze: () => { registry.freeze(); },
    stopWake: () => {},
    stopSignalR: () => {},
    closeWindows: () => {},
    continueQuit: () => {},
    waitForPendingOperations: () => registry.waitForPendingOperations(),
    createRequestId: () => "0199f1b8-1256-7000-8000-0123456789ab",
    timeoutMs: 80
  });

  coordinator.requestQuit({ preventDefault: () => {} });
  assert.equal((await coordinator.waitForCompletion()).status, "fallback");
  assert.deepEqual(takeoverFlags.sort((left, right) => left.sessionId.localeCompare(right.sessionId)), [
    { sessionId: oldSessionId, takeover: true, key: oldKey },
    { sessionId: currentSessionId, takeover: false, key: undefined }
  ].sort((left, right) => left.sessionId.localeCompare(right.sessionId)));
});

test("Main session registry records only successful connects and an old ended rotation cannot clear a replacement", () => {
  const registry = new DesktopRealtimeSessionRegistry();
  assert.equal(registry.activeSession, undefined);
  registry.markConnected({ sessionId: activeSessionId, externalSessionId: "external-a", bearer: trustedBearer });
  registry.markConnected({ sessionId: replacementSessionId, externalSessionId: "external-b", bearer: trustedBearer });
  assert.equal(registry.markEnded(replacementSessionId), true);
  assert.equal(registry.activeSession, undefined);

  registry.markConnected({ sessionId: activeSessionId, externalSessionId: "external-a", bearer: trustedBearer });
  registry.markConnected({ sessionId: secondReplacementSessionId, externalSessionId: "external-b", bearer: trustedBearer });
  assert.equal(registry.markEnded(activeSessionId), false);
  const activeSession = registry.activeSession as DesktopShutdownSession | undefined;
  assert.equal(activeSession?.sessionId, secondReplacementSessionId);
});
