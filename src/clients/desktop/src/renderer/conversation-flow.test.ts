import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  ConversationSelectionOperationCoordinator,
  restoreSelectedConversation
} from "./conversation-flow.js";

const selectedId = "0199f1b8-1234-7000-8000-0123456789ab";
const selected = {
  schemaVersion: 1,
  conversationId: selectedId,
  updatedAt: "2026-09-10T01:02:03.000Z"
};

test("selected conversation is loaded before the caller connects", async () => {
  const calls: string[] = [];
  const result = await restoreSelectedConversation({
    readSelection: async () => selected,
    load: async id => {
      calls.push(`load:${id}`);
      return { id };
    },
    clear: async () => { calls.push("clear"); },
    create: async () => {
      calls.push("create");
      return { id: "created" };
    },
    isNotFound: () => false
  });
  assert.deepEqual(result, { status: "restored", conversation: { id: selectedId } });
  assert.deepEqual(calls, [`load:${selectedId}`]);
});

test("a stale selection is cleared before creating exactly one replacement", async () => {
  const calls: string[] = [];
  const result = await restoreSelectedConversation({
    readSelection: async () => selected,
    load: async () => {
      calls.push("load");
      throw new Error("not found");
    },
    clear: async () => { calls.push("clear"); },
    create: async () => {
      calls.push("create");
      return { id: "created" };
    },
    isNotFound: error => error instanceof Error && error.message === "not found"
  });
  assert.deepEqual(result, { status: "created", conversation: { id: "created" } });
  assert.deepEqual(calls, ["load", "clear", "create"]);
});

test("a transient selected conversation failure preserves the selection and never creates an empty conversation", async () => {
  let createCalls = 0;
  const result = await restoreSelectedConversation({
    readSelection: async () => selected,
    load: async () => { throw new Error("backend unavailable"); },
    clear: async () => { throw new Error("clear must not run"); },
    create: async () => {
      createCalls++;
      return { id: "created" };
    },
    isNotFound: () => false
  });
  assert.deepEqual(result, { status: "retryable", conversationId: selectedId });
  assert.equal(createCalls, 0);
});

test("without a selection the restore flow creates one conversation", async () => {
  let createCalls = 0;
  const result = await restoreSelectedConversation({
    readSelection: async () => null,
    load: async () => ({ id: "unreachable" }),
    clear: async () => {},
    create: async () => {
      createCalls++;
      return { id: "created" };
    },
    isNotFound: () => false
  });
  assert.deepEqual(result, { status: "created", conversation: { id: "created" } });
  assert.equal(createCalls, 1);
});

test("a late restore generation cannot replace a newer manual conversation", () => {
  const coordinator = new ConversationSelectionOperationCoordinator();
  const restoreGeneration = coordinator.begin();
  const manualGeneration = coordinator.begin();

  assert.equal(coordinator.markActive(selectedId, restoreGeneration), false);
  assert.equal(coordinator.markActive("0199f1b8-1235-7000-8000-0123456789ab", manualGeneration), true);
  assert.equal(coordinator.isPersisted(selectedId), false);
});

test("selection persistence is tied to the active generation and serializes late writes", async () => {
  const coordinator = new ConversationSelectionOperationCoordinator();
  const firstGeneration = coordinator.begin();
  assert.equal(coordinator.markActive(selectedId, firstGeneration), true);
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
  const writes: string[] = [];
  const firstWrite = coordinator.persist(firstGeneration, selectedId, async () => {
    writes.push("first");
    await firstGate;
  });
  await Promise.resolve();
  await Promise.resolve();

  const secondId = "0199f1b8-1235-7000-8000-0123456789ab";
  const secondGeneration = coordinator.begin();
  assert.equal(coordinator.markActive(secondId, secondGeneration), true);
  const secondWrite = coordinator.persist(secondGeneration, secondId, async () => {
    writes.push("second");
  });

  releaseFirst();
  assert.equal(await firstWrite, false);
  assert.equal(await secondWrite, true);
  assert.deepEqual(writes, ["first", "second"]);
  assert.equal(coordinator.isPersisted(secondId), true);
  assert.equal(coordinator.isPersisted(selectedId), false);
});

test("a realtime connect ownership snapshot rejects a late response after selection changes", async () => {
  const coordinator = new ConversationSelectionOperationCoordinator();
  const generation = coordinator.begin();
  assert.equal(coordinator.markActive(selectedId, generation), true);
  const snapshot = coordinator.capture(selectedId);
  let activeConversationId = selectedId;

  assert.equal(coordinator.owns(snapshot, selectedId, false), true);
  let publishedConversationId: string | undefined;
  const lateRefresh = Promise.resolve().then(() => {
    if (coordinator.owns(snapshot, activeConversationId, false)) {
      publishedConversationId = selectedId;
    }
  });
  const nextGeneration = coordinator.begin();
  const nextId = "0199f1b8-1235-7000-8000-0123456789ab";
  assert.equal(coordinator.markActive(nextId, nextGeneration), true);
  activeConversationId = nextId;
  await lateRefresh;
  assert.equal(publishedConversationId, undefined);
  assert.equal(coordinator.owns(snapshot, selectedId, false), false);
  assert.equal(coordinator.owns(snapshot, nextId, false), false);
  assert.equal(coordinator.owns(snapshot, selectedId, true), false);
});

test("same-conversation reloads keep the active realtime binding owned", () => {
  const coordinator = new ConversationSelectionOperationCoordinator();
  const firstGeneration = coordinator.begin();
  assert.equal(coordinator.markActive(selectedId, firstGeneration), true);
  assert.equal(coordinator.markPersisted(selectedId, firstGeneration), true);
  const snapshot = coordinator.capture(selectedId);

  const reloadGeneration = coordinator.begin();
  assert.equal(coordinator.markActive(selectedId, reloadGeneration), true);
  assert.equal(coordinator.owns(snapshot, selectedId, false), true);
});

test("a failed conversation switch restores the previous realtime binding", () => {
  const coordinator = new ConversationSelectionOperationCoordinator();
  const firstGeneration = coordinator.begin();
  assert.equal(coordinator.markActive(selectedId, firstGeneration), true);
  assert.equal(coordinator.markPersisted(selectedId, firstGeneration), true);
  const snapshot = coordinator.capture(selectedId);

  const failedSwitchGeneration = coordinator.begin();
  assert.equal(coordinator.markActive("0199f1b8-1235-7000-8000-0123456789ab", failedSwitchGeneration), true);
  assert.equal(coordinator.markActive(selectedId, failedSwitchGeneration), true);
  assert.equal(coordinator.markPersisted(selectedId, failedSwitchGeneration), true);
  assert.equal(coordinator.owns(snapshot, selectedId, false), true);
});

test("a committed round trip cannot revive an older realtime binding", () => {
  const coordinator = new ConversationSelectionOperationCoordinator();
  const firstGeneration = coordinator.begin();
  assert.equal(coordinator.markActive(selectedId, firstGeneration), true);
  assert.equal(coordinator.markPersisted(selectedId, firstGeneration), true);
  const staleSnapshot = coordinator.capture(selectedId);

  const nextGeneration = coordinator.begin();
  const nextId = "0199f1b8-1235-7000-8000-0123456789ab";
  assert.equal(coordinator.markActive(nextId, nextGeneration), true);
  assert.equal(coordinator.markPersisted(nextId, nextGeneration), true);
  const returnGeneration = coordinator.begin();
  assert.equal(coordinator.markActive(selectedId, returnGeneration), true);
  assert.equal(coordinator.markPersisted(selectedId, returnGeneration), true);

  assert.equal(coordinator.owns(staleSnapshot, selectedId, false), false);
});
