import { strict as assert } from "node:assert";
import { test } from "node:test";
import { listTasks, phase0HealthUrl } from "./index.js";

test("builds the generated Phase 0 endpoint path", () => {
  assert.equal(phase0HealthUrl("http://127.0.0.1:5000"), "http://127.0.0.1:5000/api/v1/phase0/health");
});

test("passes an opaque task cursor through the generated client", async () => {
  let requestedUrl = "";
  await listTasks("http://127.0.0.1:5000", {
    conversationId: "conversation-1",
    cursor: "eyJjcmVhdGVkQXRNcyI6MSwiaWQiOiIxIn0",
    limit: 2
  }, {
    fetcher: async input => {
      requestedUrl = String(input);
      return new Response(JSON.stringify({ items: [], nextCursor: null }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
  });

  const url = new URL(requestedUrl);
  assert.equal(url.searchParams.get("cursor"), "eyJjcmVhdGVkQXRNcyI6MSwiaWQiOiIxIn0");
  assert.equal(url.searchParams.get("limit"), "2");
});
