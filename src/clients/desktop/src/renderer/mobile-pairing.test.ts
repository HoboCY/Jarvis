import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildDesktopMobilePairingInput, mobilePairingFrom } from "./mobile-pairing.js";

test("Desktop mobile pairing seam sends bounded device metadata and idempotency", () => {
  assert.deepEqual(buildDesktopMobilePairingInput("pairing-key-1"), {
    deviceName: "Jarvis Mobile",
    platform: "desktop",
    capabilities: ["microphone", "notifications"],
    idempotencyKey: "pairing-key-1"
  });
  assert.throws(() => buildDesktopMobilePairingInput(" "), /idempotency key/);
});

test("Desktop mobile pairing seam accepts only a one-time code response", () => {
  assert.deepEqual(mobilePairingFrom({ code: "a".repeat(32), expiresAtMs: 1_000 }), {
    code: "a".repeat(32),
    expiresAtMs: 1_000
  });
  assert.throws(() => mobilePairingFrom({ code: "short", expiresAtMs: 1_000 }), /pairing code/);
});
