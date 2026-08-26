import { strict as assert } from "node:assert";
import { test } from "node:test";
import { VoiceSessionCoordinator, VoiceSessionCancelledError } from "./VoiceSessionCoordinator.js";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(value => {
    resolve = value;
  });
  return { promise, resolve };
}

async function nextTurn(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
}

test("VoiceSessionCoordinator rejects a backgrounded startup and cleans late resources", async () => {
  const coordinator = new VoiceSessionCoordinator(true);
  const permission = deferred<"granted">();
  let microphoneStops = 0;
  let committed = false;

  const start = coordinator.start(async attempt => {
    await permission.promise;
    const microphone = { stop: () => { microphoneStops += 1; } };
    attempt.adopt(() => microphone.stop());
    attempt.checkpoint();
    committed = true;
    attempt.commit();
  });

  await nextTurn();
  coordinator.setForeground(false);
  permission.resolve("granted");

  await assert.rejects(start, error => error instanceof VoiceSessionCancelledError);
  assert.equal(committed, false);
  assert.equal(microphoneStops, 1);
  await coordinator.stop();
});

test("VoiceSessionCoordinator cancels a committed voice session on background and stop", async () => {
  const coordinator = new VoiceSessionCoordinator(true);
  let sessionStops = 0;
  await coordinator.start(async attempt => {
    attempt.checkpoint();
    attempt.adopt(() => { sessionStops += 1; });
    attempt.commit();
  });

  coordinator.setForeground(false);
  await coordinator.stop();
  assert.equal(sessionStops, 1);
  assert.equal(coordinator.hasActiveSession, false);
});

test("VoiceSessionCoordinator waits for old active cleanup before foreground restart", async () => {
  const coordinator = new VoiceSessionCoordinator(true);
  const oldCleanup = deferred<void>();
  let oldCleanupRuns = 0;
  let newFactoryStarted = false;

  await coordinator.start(async attempt => {
    attempt.adopt(() => {
      oldCleanupRuns += 1;
      return oldCleanup.promise;
    });
    attempt.commit();
  });

  coordinator.setForeground(false);
  coordinator.setForeground(true);
  const restart = coordinator.start(async attempt => {
    newFactoryStarted = true;
    attempt.commit();
  });

  await nextTurn();
  assert.equal(newFactoryStarted, false);
  oldCleanup.resolve();
  await restart;
  assert.equal(newFactoryStarted, true);
  assert.equal(oldCleanupRuns, 1);

  await coordinator.stop();
});

test("VoiceSessionCoordinator requires a foreground checkpoint before commit", async () => {
  const coordinator = new VoiceSessionCoordinator(false);
  await assert.rejects(
    coordinator.start(async attempt => {
      attempt.checkpoint();
      attempt.commit();
    }),
    error => error instanceof VoiceSessionCancelledError);
  assert.equal(coordinator.hasActiveSession, false);
});

test("VoiceSessionCoordinator invalidates every awaited startup checkpoint", async () => {
  for (const backgroundAt of [0, 1, 2, 3]) {
    const coordinator = new VoiceSessionCoordinator(true);
    const gates = [deferred<void>(), deferred<void>(), deferred<void>(), deferred<void>()];
    let cleanups = 0;
    const start = coordinator.start(async attempt => {
      for (const gate of gates) {
        await gate.promise;
        attempt.checkpoint();
        attempt.adopt(() => { cleanups += 1; });
      }
      attempt.commit();
    });

    for (let index = 0; index < backgroundAt; index++) {
      gates[index]!.resolve();
      await nextTurn();
    }
    coordinator.setForeground(false);
    gates[backgroundAt]!.resolve();
    await assert.rejects(start, error => error instanceof VoiceSessionCancelledError);
    assert.equal(cleanups, backgroundAt);
  }
});
