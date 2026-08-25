import { strict as assert } from "node:assert";
import { test } from "node:test";
import { isAllowedExternalUrl, isAllowedNavigation, secureWebPreferences } from "./main/security.js";

test("Electron renderer security flags stay locked", () => {
  assert.equal(secureWebPreferences.contextIsolation, true);
  assert.equal(secureWebPreferences.nodeIntegration, false);
  assert.equal(secureWebPreferences.sandbox, true);
  assert.equal(secureWebPreferences.webSecurity, true);
});

test("navigation only permits the exact renderer entry URL", () => {
  const entryUrl = "file:///tmp/jarvis/index.html";

  assert.equal(isAllowedNavigation(entryUrl, entryUrl), true);
  assert.equal(isAllowedNavigation("file:///tmp/jarvis/other.html", entryUrl), false);
  assert.equal(isAllowedNavigation("file:///tmp/jarvis/./index.html", entryUrl), false);
  assert.equal(isAllowedNavigation("file:///tmp/jarvis/index.html?unsafe=1", entryUrl), false);
  assert.equal(isAllowedNavigation("app://jarvis/index.html", entryUrl), false);
  assert.equal(isAllowedNavigation("https://example.com", entryUrl), false);
  assert.equal(isAllowedNavigation("not a URL", entryUrl), false);
  assert.equal(isAllowedNavigation("app://jarvis/index.html", "app://jarvis/index.html"), false);
  assert.equal(isAllowedNavigation("https://example.com", "https://example.com"), false);
  assert.equal(isAllowedNavigation("http://localhost:5173/", "http://localhost:5173/"), true);
});

test("external navigation only permits explicit HTTP(S) URLs", () => {
  assert.equal(isAllowedExternalUrl("https://example.com"), true);
  assert.equal(isAllowedExternalUrl("http://127.0.0.1:3000"), true);
  assert.equal(isAllowedExternalUrl("file:///tmp/jarvis/index.html"), false);
  assert.equal(isAllowedExternalUrl("app://jarvis/index.html"), false);
  assert.equal(isAllowedExternalUrl("javascript:alert(1)"), false);
  assert.equal(isAllowedExternalUrl("not a URL"), false);
});
