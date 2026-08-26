import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  MobileApiError,
  MobileApiSession,
  normalizeMobileApiBaseUrl,
  type MobileCredentialStore,
  type StoredMobileRefreshCredential
} from "./MobileApiSession.js";

const firstSession: StoredMobileRefreshCredential = {
  sessionId: "00000000-0000-7000-8000-000000000001",
  refreshToken: "jrefresh_initial",
  refreshTokenExpiresAtMs: Date.now() + 60_000
};

class FakeCredentialStore implements MobileCredentialStore {
  public value: StoredMobileRefreshCredential | null = firstSession;
  public writes = 0;
  public clears = 0;

  async load(): Promise<StoredMobileRefreshCredential | null> {
    return this.value;
  }

  async save(value: StoredMobileRefreshCredential): Promise<void> {
    this.writes++;
    this.value = value;
  }

  async clear(): Promise<void> {
    this.clears++;
    this.value = null;
  }
}

function sessionResponse(accessToken = "jma_access", refreshToken = "jrefresh_rotated") {
  return new Response(JSON.stringify({
    sessionId: firstSession.sessionId,
    deviceId: "00000000-0000-7000-8000-000000000002",
    accessToken,
    accessTokenExpiresAtMs: Date.now() + 15_000,
    refreshToken,
    refreshTokenExpiresAtMs: Date.now() + 60_000
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

test("MobileApiSession keeps access in memory and stores only the refresh credential", async () => {
  const credentials = new FakeCredentialStore();
  const requests: { url: string; headers: Headers }[] = [];
  const session = new MobileApiSession({
    baseUrl: "https://jarvis.test",
    credentials,
    fetcher: async (input, init) => {
      requests.push({ url: String(input), headers: testHeaders(init?.headers) });
      return sessionResponse("jma_from_exchange", "jrefresh_from_exchange");
    }
  });

  await session.exchange("jpair_code");
  assert.equal(session.accessTokenValue, "jma_from_exchange");
  assert.equal(credentials.value?.refreshToken, "jrefresh_from_exchange");
  assert.equal(requests[0]!.headers.get("Authorization"), null);
  assert.equal(requests[0]!.url, "https://jarvis.test/api/v1/mobile-pairings/exchange");
});

test("MobileApiSession serializes refresh and retries a write with the same idempotency key", async () => {
  const credentials = new FakeCredentialStore();
  const requests: { url: string; headers: Headers }[] = [];
  let refreshes = 0;
  let protectedRequests = 0;
  const session = new MobileApiSession({
    baseUrl: "https://jarvis.test",
    credentials,
    fetcher: async (input, init) => {
      const request = { url: String(input), headers: testHeaders(init?.headers) };
      requests.push(request);
      if (request.url.endsWith("/mobile-sessions/refresh")) {
        refreshes++;
        await new Promise(resolve => setTimeout(resolve, 5));
        return sessionResponse("jma_rotated", "jrefresh_rotated");
      }
      protectedRequests++;
      if (protectedRequests <= 2) {
        return new Response(null, { status: 401 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
  });
  const [first, second] = await Promise.all([
    session.postJson("/api/v1/conversations/00000000-0000-7000-8000-000000000003/messages/typed", { text: "one" }, "write-one"),
    session.postJson("/api/v1/conversations/00000000-0000-7000-8000-000000000003/messages/typed", { text: "two" }, "write-two")
  ]);

  assert.deepEqual(first, { ok: true });
  assert.deepEqual(second, { ok: true });
  assert.equal(refreshes, 1);
  const writes = requests.filter(request => request.url.endsWith("/messages/typed"));
  assert.equal(writes.length, 4);
  assert.deepEqual(
    writes.map(request => request.headers.get("Idempotency-Key")),
    ["write-one", "write-two", "write-one", "write-two"]);
  assert.ok(writes.slice(2).every(request => request.headers.get("Authorization") === "Bearer jma_rotated"));
});

test("MobileApiSession clears credentials after a revoked refresh", async () => {
  const credentials = new FakeCredentialStore();
  const session = new MobileApiSession({
    baseUrl: "https://jarvis.test",
    credentials,
    fetcher: async () => new Response(null, { status: 401 })
  });
  const response = await session.request("/api/v1/tasks");
  assert.equal(response.status, 401);
  assert.equal(session.accessTokenValue, undefined);
  assert.equal(credentials.value, null);
  assert.equal(credentials.clears, 1);
});

test("MobileApiSession treats terminal revoke responses as a completed local logout", async () => {
  for (const status of [401, 404]) {
    const credentials = new FakeCredentialStore();
    const session = new MobileApiSession({
      baseUrl: "https://jarvis.test",
      credentials,
      fetcher: async input => {
        if (String(input).endsWith("/mobile-sessions/revoke")) {
          return new Response(null, { status });
        }
        throw new Error("revoke must not refresh first");
      }
    });

    await session.revoke();
    assert.equal(session.accessTokenValue, undefined);
    assert.equal(credentials.value, null);
  }
});

test("MobileApiSession preserves access and refresh after a retryable revoke failure", async () => {
  const credentials = new FakeCredentialStore();
  const session = new MobileApiSession({
    baseUrl: "https://jarvis.test",
    credentials,
    fetcher: async input => {
      if (String(input).endsWith("/mobile-pairings/exchange")) {
        return sessionResponse("jma_live", "jrefresh_live");
      }
      if (String(input).endsWith("/mobile-sessions/revoke")) {
        return new Response(null, { status: 503 });
      }
      throw new Error("unexpected request");
    }
  });

  await session.exchange("jpair_code");
  await assert.rejects(
    session.revoke(),
    error => error instanceof MobileApiError && error.status === 503);
  assert.equal(session.accessTokenValue, "jma_live");
  assert.equal(credentials.value?.refreshToken, "jrefresh_live");
  assert.equal(credentials.clears, 0);
});

test("MobileApiSession preserves both credentials after a network revoke failure", async () => {
  const credentials = new FakeCredentialStore();
  const session = new MobileApiSession({
    baseUrl: "https://jarvis.test",
    credentials,
    fetcher: async input => {
      if (String(input).endsWith("/mobile-pairings/exchange")) {
        return sessionResponse("jma_live", "jrefresh_live");
      }
      throw new Error("network unavailable");
    }
  });

  await session.exchange("jpair_code");
  await assert.rejects(session.revoke(), /network unavailable/);
  assert.equal(session.accessTokenValue, "jma_live");
  assert.equal(credentials.value?.refreshToken, "jrefresh_live");
  assert.equal(credentials.clears, 0);
});

test("MobileApiSession accepts HTTPS and only loopback HTTP development URLs", () => {
  assert.equal(normalizeMobileApiBaseUrl("https://jarvis.example.test/"), "https://jarvis.example.test");
  assert.equal(normalizeMobileApiBaseUrl("http://127.0.0.1:5000/"), "http://127.0.0.1:5000");
  assert.throws(() => normalizeMobileApiBaseUrl("http://192.168.1.10:5000"), /HTTPS/);
  assert.throws(() => normalizeMobileApiBaseUrl("https://user:pass@jarvis.example.test"), /credentials/);
});

function testHeaders(value: unknown): Headers {
  const headers = new Headers();
  if (value instanceof Headers) {
    value.forEach((headerValue, name) => headers.set(name, headerValue));
  } else if (Array.isArray(value)) {
    for (const item of value) {
      if (Array.isArray(item) && item.length === 2) {
        headers.set(String(item[0]), String(item[1]));
      }
    }
  } else if (value && typeof value === "object") {
    for (const [name, headerValue] of Object.entries(value)) {
      headers.set(name, String(headerValue));
    }
  }
  return headers;
}
