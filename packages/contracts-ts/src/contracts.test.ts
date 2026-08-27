import type { paths } from "./generated/openapi.js";
import { strict as assert } from "node:assert";
import { test } from "node:test";

test("generated OpenAPI exposes the Phase 0 health operation", () => {
  type HealthResponse = paths["/api/v1/phase0/health"]["get"]["responses"][200];

  const responseStatus: keyof HealthResponse = "content";
  assert.equal(responseStatus, "content");
});

test("notification actions require the idempotency header in the generated contract", () => {
  type Parameters = paths["/api/v1/notifications/{notificationId}/actions/{actionId}"]["post"]["parameters"];
  const header: keyof Parameters["header"] = "Idempotency-Key";
  assert.equal(header, "Idempotency-Key");
});
