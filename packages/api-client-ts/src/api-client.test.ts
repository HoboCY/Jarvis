import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createMemoryFact, listTasks, phase0HealthUrl, retractMemoryFact } from "./index.js";

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

test("uses the authenticated memory endpoints with stable idempotency headers", async () => {
  const requests: Request[] = [];
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(new Request(input, init));
    return new Response(JSON.stringify({ saved: true, memoryId: "memory-1" }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  await createMemoryFact(
    "http://127.0.0.1:5000",
    {
      key: "communication.responseLength",
      value: "prefer concise",
      sourceMessageId: "00000000-0000-7000-8000-000000000001",
      sensitive: false
    },
    "remember-call-1",
    { fetcher, bearerToken: "bearer-token" }
  );
  await retractMemoryFact(
    "http://127.0.0.1:5000",
    "00000000-0000-7000-8000-000000000002",
    "retract-call-1",
    { fetcher, bearerToken: "bearer-token" }
  );

  assert.equal(requests[0]!.url, "http://127.0.0.1:5000/api/v1/memory-facts");
  assert.equal(requests[0]!.headers.get("Authorization"), "Bearer bearer-token");
  assert.equal(requests[0]!.headers.get("Idempotency-Key"), "remember-call-1");
  assert.equal(requests[1]!.url, "http://127.0.0.1:5000/api/v1/memory-facts/00000000-0000-7000-8000-000000000002/retract");
  assert.equal(requests[1]!.headers.get("Idempotency-Key"), "retract-call-1");
});
