import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ADMISSION_KINDS,
  createAdmissionClient,
  createAdmissionServer,
  readAdmissionDescriptor
} from "./admission.mjs";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "jarvis-phase9b-admission-"));
  const runId = randomUUID();
  const marker = join(root, ".phase9b-owner.json");
  await chmod(root, 0o700);
  await writeFile(marker, `${JSON.stringify({
    schemaVersion: 1,
    runId,
    pid: process.pid,
    createdAtUtc: new Date().toISOString()
  })}\n`, { mode: 0o600 });
  return { root, runId };
}

test("admission server writes a private descriptor and reserves atomically", async () => {
  const value = await fixture();
  try {
    const server = await createAdmissionServer({
      root: value.root,
      runId: value.runId,
      limits: { providerRequests: 2 }
    });
    try {
      const descriptor = await readAdmissionDescriptor(server.descriptorPath);
      assert.deepEqual(Object.keys(descriptor).sort(), [
        "endpoint", "ledgerFile", "ownerPid", "ownerUid", "root", "runId",
        "schemaVersion", "tokenFile"
      ]);
      assert.equal(descriptor.runId, value.runId);
      assert.equal(descriptor.root, value.root);
      assert.match(descriptor.endpoint, /^http:\/\/127\.0\.0\.1:\d+$/);
      assert.equal((await stat(server.descriptorPath)).mode & 0o777, 0o600);
      assert.equal((await stat(server.tokenPath)).mode & 0o777, 0o600);
      assert.deepEqual(await server.snapshot(), {
        limits: {
          providerRequests: 2,
          realtimeConnections: 4,
          delegationAttempts: 2,
          codexTasks: 5,
          retries: 2
        },
        used: {
          providerRequests: 0,
          realtimeConnections: 0,
          delegationAttempts: 0,
          codexTasks: 0,
          retries: 0
        },
        remaining: {
          providerRequests: 2,
          realtimeConnections: 4,
          delegationAttempts: 2,
          codexTasks: 5,
          retries: 2
        }
      });
      const client = createAdmissionClient({ descriptorPath: server.descriptorPath });
      const requestKey = `provider:${randomUUID()}`;
      const first = await client.reserve({
        kind: "providerRequests",
        logicalId: randomUUID(),
        requestKey
      });
      assert.equal(first.status, "RESERVED");
      assert.equal(first.replayed, false);
      const replay = await client.reserve({
        kind: "providerRequests",
        logicalId: first.logicalId,
        requestKey
      });
      assert.deepEqual({ ...replay, replayed: false }, first);
      assert.equal(replay.replayed, true);
      assert.equal((await client.reserve({
        kind: "providerRequests",
        logicalId: randomUUID(),
        requestKey: `provider:${randomUUID()}`
      })).remaining, 0);
      await assert.rejects(
        () => client.reserve({
          kind: "providerRequests",
          logicalId: randomUUID(),
          requestKey: `provider:${randomUUID()}`
        }),
        error => error.code === "BUDGET_EXHAUSTED"
      );
      const ledger = JSON.parse(await readFile(server.ledgerPath, "utf8"));
      assert.equal(ledger.used.providerRequests, 2);
      assert.equal(ledger.requests.length, 2);
      assert.equal((await server.snapshot()).used.providerRequests, 2);
    } finally {
      await server.stop();
      await server.stop();
    }
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("admission rejects invalid authentication, request fields, and redirects", async () => {
  const value = await fixture();
  try {
    const server = await createAdmissionServer({
      root: value.root,
      runId: value.runId,
      limits: { providerRequests: 1 }
    });
    try {
      const descriptor = await readAdmissionDescriptor(server.descriptorPath);
      const token = JSON.parse(await readFile(server.tokenPath, "utf8"));
      const unauthorized = await fetch(`${descriptor.endpoint}/reserve`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer wrong" },
        body: JSON.stringify({
          schemaVersion: 1,
          runId: value.runId,
          kind: "providerRequests",
          logicalId: randomUUID(),
          requestKey: `provider:${randomUUID()}`,
          amount: 1
        })
      });
      assert.equal(unauthorized.status, 401);
      assert.deepEqual(await unauthorized.json(), {
        schemaVersion: 1,
        status: "REJECTED",
        errorCategory: "ADMISSION_UNAUTHORIZED"
      });

      const invalid = await fetch(`${descriptor.endpoint}/reserve`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({
          schemaVersion: 1,
          runId: value.runId,
          kind: "providerRequests",
          logicalId: "not-a-uuid",
          requestKey: "arbitrary",
          amount: 2,
          extra: true
        })
      });
      assert.equal(invalid.status, 400);
      assert.deepEqual(await invalid.json(), {
        schemaVersion: 1,
        status: "REJECTED",
        errorCategory: "ADMISSION_INVALID"
      });

      const redirected = await fetch(`${descriptor.endpoint}/reserve`, {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({
          schemaVersion: 1,
          runId: value.runId,
          kind: "unknown",
          logicalId: randomUUID(),
          requestKey: "provider:redirect",
          amount: 1
        })
      });
      assert.equal(redirected.status, 400);
    } finally {
      await server.stop();
    }
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("concurrent reservations cannot cross a hard boundary", async () => {
  const value = await fixture();
  try {
    const server = await createAdmissionServer({
      root: value.root,
      runId: value.runId,
      limits: { retries: 1 }
    });
    try {
      const client = createAdmissionClient({ descriptorPath: server.descriptorPath });
      const responses = await Promise.allSettled([
        client.reserve({ kind: "retries", logicalId: randomUUID(), requestKey: "retry:a" }),
        client.reserve({ kind: "retries", logicalId: randomUUID(), requestKey: "retry:b" })
      ]);
      assert.equal(responses.filter(result => result.status === "fulfilled").length, 1);
      assert.equal(responses.filter(result => result.status === "rejected")[0]?.reason?.code, "BUDGET_EXHAUSTED");
    } finally {
      await server.stop();
    }
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("budget exhaustion emits one asynchronous fatal signal after rejection", async () => {
  const value = await fixture();
  const categories = [];
  try {
    const server = await createAdmissionServer({
      root: value.root,
      runId: value.runId,
      limits: { providerRequests: 1 },
      onFatal: async (category) => {
        await new Promise(resolve => setImmediate(resolve));
        categories.push(category);
      }
    });
    try {
      const client = createAdmissionClient({ descriptorPath: server.descriptorPath });
      await client.reserve({
        kind: "providerRequests",
        logicalId: randomUUID(),
        requestKey: `provider:${randomUUID()}`
      });
      await assert.rejects(
        () => client.reserve({
          kind: "providerRequests",
          logicalId: randomUUID(),
          requestKey: `provider:${randomUUID()}`
        }),
        error => error.code === "BUDGET_EXHAUSTED"
      );
      await assert.rejects(
        () => client.reserve({
          kind: "retries",
          logicalId: randomUUID(),
          requestKey: `retry:${randomUUID()}`
        }),
        error => error.code === "BUDGET_EXHAUSTED"
      );
      await server.waitForFatal();
      assert.deepEqual(categories, ["BUDGET_EXHAUSTED"]);
      await server.waitForFatal();
      assert.deepEqual(categories, ["BUDGET_EXHAUSTED"]);
      const ledger = JSON.parse(await readFile(server.ledgerPath, "utf8"));
      assert.equal(ledger.requests.length, 1);
      assert.equal(ledger.used.retries, 0);
    } finally {
      await server.stop();
    }
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("admission keeps the fixed budget kind set", () => {
  assert.deepEqual(ADMISSION_KINDS, [
    "providerRequests", "realtimeConnections", "delegationAttempts", "codexTasks", "retries"
  ]);
});
