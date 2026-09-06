import { strict as assert } from "node:assert";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createEvidence,
  hashExternalId,
  REQUIRED_SCENARIO_IDS,
  scanKnownSecrets,
  summarizeOutput,
  validateEvidence,
  validateEvidenceBundle,
  writeLiveEvidence
} from "./evidence.mjs";

const runId = "123e4567-e89b-12d3-a456-426614174000";
const startedAtUtc = "2026-09-06T00:00:00.000Z";
const finishedAtUtc = "2026-09-06T00:00:01.000Z";

function validEvidence(overrides = {}) {
  return createEvidence({
    runId,
    baselineSha: "5df7533141107585cfbaa90a9c40d78a7b0b959a",
    candidateSha: "1111111111111111111111111111111111111111",
    startedAtUtc,
    finishedAtUtc,
    status: "LIVE_PARTIAL",
    platform: { os: "darwin", arch: "arm64", osVersion: "15.6" },
    toolchain: { node: "24.19.0", pnpm: "10.24.0", dotnet: "10.0.100", codex: "0.146.0" },
    provider: {
      electronVersion: "44.0.0",
      realtimeProvider: "AzureOpenAI",
      realtimeModel: "gpt-realtime-2.1-mini",
      realtimeVoice: "alloy",
      responsesProvider: "DeepSeek",
      responsesModel: "deepseek-v4-flash",
      summarizerModel: "deepseek-v4-flash"
    },
    budgets: {
      limits: { providerRequests: 12, realtimeConnections: 4, delegationAttempts: 2, codexTasks: 5, retries: 2 },
      used: { providerRequests: 0, realtimeConnections: 0, delegationAttempts: 0, codexTasks: 0, retries: 0 }
    },
    scenarios: [{
      id: "conversation-voice-text",
      status: "UNVERIFIED",
      startedAtUtc,
      finishedAtUtc,
      durationMs: 1,
      errorCategory: "SCENARIO_DRIVER_UNAVAILABLE",
      output: summarizeOutput("safe output")
    }],
    artifacts: [],
    errors: [{ category: "SCENARIO_DRIVER_UNAVAILABLE" }],
    secretScan: { passed: true },
    ...overrides
  });
}

test("evidence retains only bounded hashes and rejects raw secrets or unknown fields", () => {
  const evidence = validEvidence();
  assert.equal(hashExternalId("realtime-session-123"), createHash("sha256").update("realtime-session-123").digest("hex"));
  assert.deepEqual(summarizeOutput("safe output"), {
    length: 11,
    sha256: "561c03f56ace489bb56fec63df72ebb01e73641954fdceae941253b0c99b6c65"
  });
  assert.equal(scanKnownSecrets(Buffer.from("secret-value"), ["secret-value"]), true);
  assert.doesNotThrow(() => validateEvidence(evidence));
  assert.equal(JSON.stringify(evidence).includes("api-key"), false);

  assert.throws(
    () => validateEvidence({ ...evidence, unexpected: true }),
    (error) => error.code === "INVALID_EVIDENCE"
  );
  assert.throws(
    () => validateEvidence({
      ...evidence,
      scenarios: [{ ...evidence.scenarios[0], output: "raw transcript" }]
    }),
    (error) => error.code === "INVALID_EVIDENCE"
  );
  assert.throws(
    () => validateEvidence({
      ...evidence,
      artifacts: [{ path: "../outside.txt", sha256: "0".repeat(64) }]
    }),
    (error) => error.code === "INVALID_EVIDENCE"
  );
  assert.throws(
    () => validateEvidence({
      ...evidence,
      artifacts: [{ path: "raw.db", sha256: "0".repeat(64) }]
    }),
    (error) => error.code === "INVALID_EVIDENCE"
  );
});

test("PASS evidence requires every approved A-J scenario and no errors", () => {
  assert.throws(
    () => validEvidence({ status: "PASS", scenarios: [], errors: [] }),
    (error) => error.code === "INVALID_EVIDENCE"
  );
  const scenarios = REQUIRED_SCENARIO_IDS.map((id) => ({
    id,
    status: "PASS",
    startedAtUtc,
    finishedAtUtc,
    durationMs: 1
  }));
  assert.doesNotThrow(() => validEvidence({ status: "PASS", scenarios, errors: [] }));
});

test("budget exhausted evidence requires the corresponding terminal error", () => {
  assert.throws(
    () => validEvidence({ status: "LIVE_BUDGET_EXHAUSTED", errors: [] }),
    (error) => error.code === "INVALID_EVIDENCE"
  );
  assert.doesNotThrow(() => validEvidence({
    status: "LIVE_BUDGET_EXHAUSTED",
    errors: [{ category: "BUDGET_EXHAUSTED" }, { category: "CLEANUP_FAILED" }]
  }));
  assert.throws(
    () => validEvidence({
      status: "LIVE_PARTIAL",
      errors: [{ category: "BUDGET_EXHAUSTED" }]
    }),
    (error) => error.code === "INVALID_EVIDENCE"
  );
});

test("evidence accepts RFC 9562 version 7 Jarvis identifiers", () => {
  assert.doesNotThrow(() => validateEvidence(validEvidence({
    scenarios: [{
      id: "realtime",
      status: "PASS",
      startedAtUtc,
      finishedAtUtc,
      durationMs: 1,
      ids: {
        jarvisConversationId: "0199f1b8-1234-7abc-8def-0123456789ab",
        jarvisRealtimeSessionId: "0199f1b8-1235-7abc-8def-0123456789ab",
        jarvisTaskId: "0199f1b8-1236-7abc-8def-0123456789ab",
        jarvisNotificationId: "0199f1b8-1237-7abc-8def-0123456789ab",
        jarvisApprovalId: "0199f1b8-1238-7abc-8def-0123456789ab"
      }
    }]
  })));
});

test("evidence accepts a bounded Codex auth block and hashed thread and turn ids", () => {
  assert.doesNotThrow(() => validateEvidence(validEvidence({
    status: "BLOCKED_CODEX_AUTH",
    scenarios: [{
      id: "cold-start",
      status: "BLOCKED",
      startedAtUtc,
      finishedAtUtc,
      durationMs: 1,
      errorCategory: "BLOCKED_CODEX_AUTH",
      ids: {
        codexTaskIdHash: "0".repeat(64),
        codexThreadIdHash: "1".repeat(64),
        codexTurnIdHash: "2".repeat(64)
      }
    }],
    errors: [{ category: "BLOCKED_CODEX_AUTH" }]
  })));
});

test("DeepSeek background retrieve and cancel cannot be marked PASS", () => {
  assert.throws(
    () => validEvidence({
      scenarios: [{
        id: "responses-background-retrieve",
        status: "PASS",
        startedAtUtc,
        finishedAtUtc,
        durationMs: 1
      }]
    }),
    (error) => error.code === "INVALID_EVIDENCE"
  );
});

test("evidence and relative manifest are atomically written and read back", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-phase9b-evidence-"));
  const repositoryRoot = join(root, "repo");
  try {
    await mkdir(repositoryRoot);
    await mkdir(join(repositoryRoot, "artifacts", "live", "phase9b", runId, "logs"), { recursive: true, mode: 0o700 });
    await chmod(join(repositoryRoot, "artifacts", "live", "phase9b", runId, "logs"), 0o700);
    await writeFile(
      join(repositoryRoot, "artifacts", "live", "phase9b", runId, "logs", "result.txt"),
      "data",
      { mode: 0o600 }
    );
    const result = await writeLiveEvidence({
      repositoryRoot,
      evidence: validEvidence({
        artifacts: [{
          path: "logs/result.txt",
          sha256: createHash("sha256").update("data").digest("hex"),
          bytes: 4
        }]
      })
    });
    assert.equal((await stat(result.directory)).mode & 0o777, 0o700);
    assert.equal((await stat(result.evidencePath)).mode & 0o777, 0o600);
    assert.equal((await stat(result.manifestPath)).mode & 0o777, 0o600);
    const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
    assert.deepEqual(Object.keys(manifest).sort(), ["artifacts", "evidence", "runId", "schemaVersion"]);
    assert.equal(Object.hasOwn(manifest, "selfSha256"), false);
    await assert.doesNotReject(() => validateEvidenceBundle(result.directory));
    await writeFile(join(result.directory, "unlisted.txt"), "must be rejected", { mode: 0o600 });
    await assert.rejects(
      () => validateEvidenceBundle(result.directory),
      (error) => error.code === "INVALID_EVIDENCE"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
