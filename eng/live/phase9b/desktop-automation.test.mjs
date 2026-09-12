import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  DESKTOP_AUTOMATION_ACTION_IDS,
  DESKTOP_AUTOMATION_TEST_IDS,
  createDesktopAutomationDriver,
  parseDesktopAutomationCommand,
  sanitizeDesktopAutomationOutput,
  sanitizeDesktopScenarioResult
} from "./desktop-automation.mjs";

const sha256 = "0".repeat(64);

function validOutput(overrides = {}) {
  return {
    status: "PASS",
    states: [
      { testId: DESKTOP_AUTOMATION_TEST_IDS.realtimeStatus, value: "connected" },
      { testId: DESKTOP_AUTOMATION_TEST_IDS.remoteTrackCount, value: 1 },
      { testId: DESKTOP_AUTOMATION_TEST_IDS.conversationId, value: randomUUID() }
    ],
    counts: { messageCount: 2, taskCount: 1 },
    ids: { jarvisConversationId: randomUUID() },
    booleans: { audioMuted: true, conversationRestored: true },
    errors: [],
    hashes: { artifactSha256: sha256 },
    ...overrides
  };
}

test("desktop automation reads only fixed data-testid state through the page seam", async () => {
  const values = {
    [DESKTOP_AUTOMATION_TEST_IDS.realtimeStatus]: "connected",
    [DESKTOP_AUTOMATION_TEST_IDS.remoteTrackCount]: 1
  };
  const calls = [];
  const driver = createDesktopAutomationDriver({
    page: {
      readTestId: async (testId) => {
        calls.push(["read", testId]);
        return values[testId];
      },
      clickTestId: async (testId) => {
        calls.push(["click", testId]);
      }
    }
  });

  const snapshot = await driver.run({
    action: "read-state",
    testIds: [DESKTOP_AUTOMATION_TEST_IDS.realtimeStatus, DESKTOP_AUTOMATION_TEST_IDS.remoteTrackCount]
  });
  assert.deepEqual(snapshot, {
    status: "PASS",
    states: [
      { testId: DESKTOP_AUTOMATION_TEST_IDS.realtimeStatus, value: "connected" },
      { testId: DESKTOP_AUTOMATION_TEST_IDS.remoteTrackCount, value: 1 }
    ]
  });

  const click = await driver.run({ action: "click-test-id", testId: DESKTOP_AUTOMATION_ACTION_IDS.pauseSignalr });
  assert.deepEqual(click, { status: "PASS" });
  assert.deepEqual(calls, [
    ["read", DESKTOP_AUTOMATION_TEST_IDS.realtimeStatus],
    ["read", DESKTOP_AUTOMATION_TEST_IDS.remoteTrackCount],
    ["click", DESKTOP_AUTOMATION_ACTION_IDS.pauseSignalr]
  ]);
});

test("desktop automation rejects caller selectors, evaluation, scripts, and unknown fields before the page seam", async () => {
  let calls = 0;
  const driver = createDesktopAutomationDriver({
    page: {
      readTestId: async () => {
        calls += 1;
        return "connected";
      },
      clickTestId: async () => {
        calls += 1;
      }
    }
  });

  for (const command of [
    { action: "read-state", selector: "body" },
    { action: "read-state", evaluate: "document.body.innerText" },
    { action: "click-test-id", testId: DESKTOP_AUTOMATION_ACTION_IDS.pauseSignalr, script: "alert(1)" },
    { action: "read-state", testIds: ["phase9b-unknown-state"] },
    { action: "read-state", unexpected: true }
  ]) {
    assert.throws(
      () => parseDesktopAutomationCommand(command),
      (error) => error.code === "INVALID_AUTOMATION_COMMAND"
    );
    await assert.rejects(
      () => driver.run(command),
      (error) => error.code === "INVALID_AUTOMATION_COMMAND"
    );
  }
  assert.equal(calls, 0);
});

test("cold-start observations admit only bounded terminal identity and artifact restoration state", () => {
  const output = validOutput({ states: [
    { testId: DESKTOP_AUTOMATION_TEST_IDS.terminalTaskCount, value: 2 },
    { testId: DESKTOP_AUTOMATION_TEST_IDS.terminalTaskId, value: randomUUID() },
    { testId: DESKTOP_AUTOMATION_TEST_IDS.terminalTaskStatus, value: "failed" },
    { testId: DESKTOP_AUTOMATION_TEST_IDS.artifactCount, value: 1 },
    { testId: DESKTOP_AUTOMATION_TEST_IDS.artifactRestoreStatus, value: "complete" }
  ] });
  assert.doesNotThrow(() => sanitizeDesktopAutomationOutput(output));
  for (const [testId, value] of [
    [DESKTOP_AUTOMATION_TEST_IDS.terminalTaskCount, 1_000_000],
    [DESKTOP_AUTOMATION_TEST_IDS.terminalTaskId, "private-task-text"],
    [DESKTOP_AUTOMATION_TEST_IDS.artifactRestoreStatus, "private-error-message"]
  ]) {
    assert.throws(() => sanitizeDesktopAutomationOutput({ ...output, states: [{ testId, value }] }),
      { code: "INVALID_AUTOMATION_OUTPUT" });
  }
});

test("desktop automation output allows only bounded state types and rejects secret-shaped or private values", () => {
  assert.doesNotThrow(() => sanitizeDesktopAutomationOutput(validOutput()));
  for (const value of [
    { ...validOutput(), unexpected: "value" },
    { ...validOutput(), states: [{ testId: DESKTOP_AUTOMATION_TEST_IDS.realtimeStatus, value: "sk-proj-123456789012" }] },
    { ...validOutput(), states: [{ testId: DESKTOP_AUTOMATION_TEST_IDS.realtimeStatus, value: "/Users/hobo/private.txt" }] },
    { ...validOutput(), counts: { messageCount: 1, privateText: 2 } },
    { ...validOutput(), booleans: { audioMuted: "Bearer abcdefghijklmnop" } },
    { ...validOutput(), hashes: { artifactSha256: "not-a-sha" } },
    { ...validOutput(), errors: [{ code: "raw-provider-body" }] },
    { ...validOutput(), ids: { threadId: randomUUID() } },
    { ...validOutput(), ids: { requestId: randomUUID() } },
    { ...validOutput(), output: { length: 4096, sha256 } }
  ]) {
    assert.throws(
      () => sanitizeDesktopAutomationOutput(value),
      (error) => error.code === "INVALID_AUTOMATION_OUTPUT"
    );
  }
});

test("desktop automation sanitizes adapter failures without exposing raw messages", async () => {
  const driver = createDesktopAutomationDriver({
    page: {
      readTestId: async () => {
        const error = new Error("/Users/hobo/private.txt Bearer abcdefghijklmnop");
        error.code = "UNKNOWN_PRIVATE_FAILURE";
        throw error;
      },
      clickTestId: async () => {}
    }
  });

  await assert.rejects(
    () => driver.run({ action: "read-state", testIds: [DESKTOP_AUTOMATION_TEST_IDS.realtimeStatus] }),
    (error) => error.code === "AUTOMATION_DRIVER_FAILED"
      && error.message === "Desktop automation failed."
      && !error.message.includes("private.txt")
  );
});

test("desktop automation accepts only fixed A-J and meta scenario ids", () => {
  const startedAtUtc = "2026-09-10T00:00:00.000Z";
  const scenario = {
    id: "realtime",
    status: "PASS",
    startedAtUtc,
    finishedAtUtc: startedAtUtc,
    durationMs: 0
  };
  assert.doesNotThrow(() => sanitizeDesktopScenarioResult({ scenarios: [scenario] }));
  assert.throws(
    () => sanitizeDesktopScenarioResult({
      scenarios: [{ ...scenario, id: "private-observation" }]
    }),
    (error) => error.code === "INVALID_AUTOMATION_OUTPUT"
  );
});
