import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  mapWakeWordErrorCode,
  wakeWordErrorCode,
  wakeWordErrorMessage
} from "./wake-word-error.js";

test("wake-word IPC exposes only the allowlisted public error projection", () => {
  assert.equal(wakeWordErrorCode, "unavailable");
  assert.equal(mapWakeWordErrorCode(wakeWordErrorCode), wakeWordErrorMessage);
  assert.equal(
    mapWakeWordErrorCode(
      "/Applications/Jarvis.app/Contents/Resources/model.onnx Bearer sk-provider-secret"),
    wakeWordErrorMessage);
  assert.equal(mapWakeWordErrorCode({ secret: "provider-secret", path: "/opt/private" }), wakeWordErrorMessage);
  assert.ok(wakeWordErrorMessage.length <= 240);
});
