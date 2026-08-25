import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createTextOnlyResponseEvent, realtimeToolNames } from "./index.js";

test("keeps the Phase 0 realtime tool surface bounded", () => {
  assert.deepEqual(realtimeToolNames, ["delegate_task", "get_task_status", "cancel_task", "remember_fact"]);
});

test("creates a text-only response event", () => {
  assert.deepEqual(createTextOnlyResponseEvent(), {
    type: "response.create",
    response: { output_modalities: ["text"] }
  });
});
