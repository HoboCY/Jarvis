import { strict as assert } from "node:assert";
import { test } from "node:test";
import { resolveBackendBaseUrl } from "./backend-config.js";

test("Desktop uses the local API port 5004 when no endpoint is configured", () => {
  assert.equal(resolveBackendBaseUrl({}), "http://127.0.0.1:5004");
});

test("Desktop preserves an explicitly configured API endpoint", () => {
  assert.equal(
    resolveBackendBaseUrl({ JARVIS_API_BASE_URL: "https://jarvis.example.test:8443" }),
    "https://jarvis.example.test:8443"
  );
});
