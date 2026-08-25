import type { paths } from "./generated/openapi.js";
import { strict as assert } from "node:assert";
import { test } from "node:test";

test("generated OpenAPI exposes the Phase 0 health operation", () => {
  type HealthResponse = paths["/api/v1/phase0/health"]["get"]["responses"][200];

  const responseStatus: keyof HealthResponse = "content";
  assert.equal(responseStatus, "content");
});
