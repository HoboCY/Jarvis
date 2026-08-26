import { strict as assert } from "node:assert";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  NotificationProjectionCache,
  createOverlayWindowOptions,
  getTrayCommands,
  shouldHideWindowOnClose,
  type SafeNotificationProjection
} from "./desktop-lifecycle.js";

test("close hides the main window until an explicit quit is requested", () => {
  assert.equal(shouldHideWindowOnClose(false), true);
  assert.equal(shouldHideWindowOnClose(true), false);
});

test("tray exposes only show/hide and quit actions", () => {
  assert.deepEqual(getTrayCommands(true), ["hide", "quit"]);
  assert.deepEqual(getTrayCommands(false), ["show", "quit"]);
});

test("the macOS tray template includes non-empty 1x and 2x PNG assets", async () => {
  const oneXPath = resolve("src/assets/JarvisTemplate.png");
  const twoXPath = resolve("src/assets/JarvisTemplate@2x.png");
  const oneX = await stat(oneXPath);
  const twoX = await stat(twoXPath);
  const oneXBytes = await readFile(oneXPath);
  const twoXBytes = await readFile(twoXPath);

  assert.ok(oneX.size > 0);
  assert.ok(twoX.size > 0);
  assert.equal(oneXBytes.readUInt32BE(16), 16);
  assert.equal(oneXBytes.readUInt32BE(20), 16);
  assert.equal(twoXBytes.readUInt32BE(16), 32);
  assert.equal(twoXBytes.readUInt32BE(20), 32);
});

test("overlay options preserve renderer isolation and stay always on top", () => {
  const options = createOverlayWindowOptions("/tmp/jarvis-preload.js");

  assert.equal(options.alwaysOnTop, true);
  assert.equal(options.webPreferences.contextIsolation, true);
  assert.equal(options.webPreferences.nodeIntegration, false);
  assert.equal(options.webPreferences.sandbox, true);
  assert.equal(options.webPreferences.preload, "/tmp/jarvis-preload.js");
});

test("notification projection strips HTML/secrets, bounds text, and deduplicates by id", () => {
  const cache = new NotificationProjectionCache();
  const first = cache.accept({
    id: "notification-1",
    title: "<b>Task complete</b>",
    body: "Bearer super-secret <script>alert(1)</script> /Users/private/token"
  });
  const duplicate = cache.accept({
    id: "notification-1",
    title: "changed",
    body: "changed"
  });

  assert.deepEqual(first, {
    id: "notification-1",
    title: "Task complete",
    body: "[REDACTED] [REDACTED_PATH]"
  } satisfies SafeNotificationProjection);
  assert.equal(duplicate, undefined);
  assert.equal(cache.accept({ id: "", title: "x", body: "y" }), undefined);
  assert.equal(cache.accept({ id: "notification-2", title: "x".repeat(300), body: "y".repeat(2_000) })?.title.length, 200);
  assert.equal(cache.accept({ id: "notification-3", title: "x", body: "y" })?.id, "notification-3");
});
