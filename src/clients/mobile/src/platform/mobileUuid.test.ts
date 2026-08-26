import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createMobileIdempotencyKey, createMobileUuid } from "./mobileUuid.js";

test("mobile UUID adapter returns RFC 4122 identifiers without Node-only imports", () => {
  const first = createMobileUuid();
  const second = createMobileUuid();
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(first, second);
  assert.match(createMobileIdempotencyKey("mobile-task"), /^mobile-task-[0-9a-f-]{36}$/);
});
