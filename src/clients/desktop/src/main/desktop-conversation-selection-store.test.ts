import { strict as assert } from "node:assert";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DesktopConversationSelectionStore } from "./desktop-conversation-selection-store.js";

const conversationA = "0199f1b8-1234-7000-8000-0123456789ab";
const conversationB = "0199f1b8-1235-7000-8000-0123456789ab";

test("conversation selection persists an exact owner-only schema and isolates profiles", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-conversation-selection-"));
  try {
    const first = new DesktopConversationSelectionStore(join(root, "profile-a"), () => new Date("2026-09-10T01:02:03.000Z"));
    const second = new DesktopConversationSelectionStore(join(root, "profile-b"), () => new Date("2026-09-10T04:05:06.000Z"));
    assert.equal(await first.get(), undefined);
    assert.deepEqual(await first.set(conversationA), {
      schemaVersion: 1,
      conversationId: conversationA,
      updatedAt: "2026-09-10T01:02:03.000Z"
    });
    assert.deepEqual(await first.get(), {
      schemaVersion: 1,
      conversationId: conversationA,
      updatedAt: "2026-09-10T01:02:03.000Z"
    });
    assert.equal(await second.get(), undefined);

    const directory = join(root, "profile-a", "desktop");
    const file = join(directory, "conversation-selection.json");
    assert.equal((await lstat(directory)).mode & 0o777, 0o700);
    assert.equal((await lstat(file)).mode & 0o777, 0o600);
    assert.deepEqual(Object.keys(JSON.parse(await readFile(file, "utf8"))).sort(), [
      "conversationId",
      "schemaVersion",
      "updatedAt"
    ]);

    await first.clear();
    assert.equal(await first.get(), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("selection rejects malformed UUID input, corruption, and extra fields fail closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-conversation-selection-invalid-"));
  try {
    const store = new DesktopConversationSelectionStore(root);
    await assert.rejects(() => store.set("not-a-uuid"), /Conversation id is invalid/);
    await mkdir(join(root, "desktop"), { mode: 0o700 });
    await writeFile(
      join(root, "desktop", "conversation-selection.json"),
      JSON.stringify({ schemaVersion: 1, conversationId: conversationB, updatedAt: "invalid", unexpected: true }),
      { mode: 0o600 }
    );
    await chmod(join(root, "desktop", "conversation-selection.json"), 0o600);
    await assert.rejects(() => store.get(), /Conversation selection is invalid/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("selection rejects symlinked storage and never follows a path escape", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-conversation-selection-symlink-"));
  const outside = await mkdtemp(join(tmpdir(), "jarvis-conversation-selection-outside-"));
  try {
    const directory = join(root, "desktop");
    await symlink(outside, directory);
    const store = new DesktopConversationSelectionStore(root);
    await assert.rejects(() => store.get(), /Conversation selection storage is invalid/);
    await assert.rejects(() => store.set(conversationA), /Conversation selection storage is invalid/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("selection fails closed on storage errors instead of treating them as missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-conversation-selection-permission-"));
  try {
    const store = new DesktopConversationSelectionStore(join(root, "\u0000"));
    await assert.rejects(() => store.get(), /Conversation selection storage is invalid/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
