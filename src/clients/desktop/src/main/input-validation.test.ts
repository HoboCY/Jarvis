import { strict as assert } from "node:assert";
import { test } from "node:test";
import { isUuid } from "./input-validation.js";

test("accepts RFC UUID v7 source message ids and preserves variant validation", () => {
  assert.equal(isUuid("0198b0a1-0000-7000-8000-000000000001"), true);
  assert.equal(isUuid("0198b0a1-0000-7000-7000-000000000001"), false);
  assert.equal(isUuid("0198b0a1-0000-6000-8000-000000000001"), true);
  assert.equal(isUuid("not-a-uuid"), false);
});
