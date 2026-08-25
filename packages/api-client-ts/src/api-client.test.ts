import { strict as assert } from "node:assert";
import { test } from "node:test";
import { phase0HealthUrl } from "./index.js";

test("builds the generated Phase 0 endpoint path", () => {
  assert.equal(phase0HealthUrl("http://127.0.0.1:5000"), "http://127.0.0.1:5000/api/v1/phase0/health");
});
