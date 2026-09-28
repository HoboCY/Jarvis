import { strict as assert } from "node:assert";
import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createScenario, runLive } from "./live.mjs";
import { DESKTOP_AUTOMATION_TEST_IDS } from "./desktop-automation.mjs";
import { REQUIRED_SCENARIO_IDS } from "./evidence.mjs";
import { validateEvidenceBundle } from "./evidence.mjs";

const preflightBlocked = {
  schemaVersion: 1,
  status: "BLOCKED_CREDENTIALS",
  mode: "offline",
  network: { providerCalls: 0 },
  checks: {
    platform: { status: "PASS", os: "darwin", arch: "arm64", osVersion: "15.6", errors: [] },
    toolchain: { status: "PASS", errors: [], codexSha256Matches: true },
    credentials: {
      status: "BLOCKED_CREDENTIALS",
      errors: ["MISSING_OPENAI_API_KEY", "MISSING_DEEPSEEK_API_KEY"],
      presence: { userSecretsFound: false, openAiApiKey: false, deepSeekApiKey: false }
    },
    provider: { status: "UNVERIFIED" }
  }
};

const preflightReady = {
  ...preflightBlocked,
  status: "PASS",
  checks: {
    ...preflightBlocked.checks,
    credentials: {
      status: "PASS",
      errors: [],
      presence: { userSecretsFound: true, openAiApiKey: true, deepSeekApiKey: true }
    }
  }
};

test("live runner writes blocked evidence without invoking a provider", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-phase9b-live-blocked-"));
  try {
    await mkdir(join(root, "repo"));
    await mkdir(join(root, "home"));
    await mkdir(join(root, "safe"));
    await chmod(join(root, "safe"), 0o700);
    let driverCalls = 0;
    const result = await runLive({
      repositoryRoot: join(root, "repo"),
      homeDirectory: join(root, "home"),
      baseDirectory: join(root, "safe"),
      baselineSha: "5df7533141107585cfbaa90a9c40d78a7b0b959a",
      candidateSha: "1111111111111111111111111111111111111111",
      preflightResult: preflightBlocked,
      driver: async () => {
        driverCalls += 1;
      }
    });
    assert.equal(result.status, "BLOCKED_CREDENTIALS");
    assert.equal(result.network.providerCalls, 0);
    assert.equal(driverCalls, 0);
    assert.equal(result.evidencePath, `artifacts/live/phase9b/${result.runId}/evidence.json`);
    await assert.doesNotReject(() => validateEvidenceBundle(join(root, "repo", "artifacts", "live", "phase9b", result.runId)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ready live runner reports a missing scenario driver as LIVE_PARTIAL", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-phase9b-live-partial-"));
  try {
    await mkdir(join(root, "repo"));
    await mkdir(join(root, "home"));
    await mkdir(join(root, "safe"));
    await chmod(join(root, "safe"), 0o700);
    const result = await runLive({
      repositoryRoot: join(root, "repo"),
      homeDirectory: join(root, "home"),
      baseDirectory: join(root, "safe"),
      baselineSha: "5df7533141107585cfbaa90a9c40d78a7b0b959a",
      candidateSha: "1111111111111111111111111111111111111111",
      preflightResult: preflightReady
    });
    assert.equal(result.status, "LIVE_PARTIAL");
    assert.equal(result.network.providerCalls, 0);
    assert.equal(result.scenarioStatus, "UNVERIFIED");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("live runner carries provider preflight usage into the hard budget", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-phase9b-live-budget-"));
  try {
    await mkdir(join(root, "repo"));
    await mkdir(join(root, "home"));
    await mkdir(join(root, "safe"));
    await chmod(join(root, "safe"), 0o700);
    const result = await runLive({
      repositoryRoot: join(root, "repo"),
      homeDirectory: join(root, "home"),
      baseDirectory: join(root, "safe"),
      baselineSha: "5df7533141107585cfbaa90a9c40d78a7b0b959a",
      candidateSha: "1111111111111111111111111111111111111111",
      preflightResult: { ...preflightReady, network: { providerCalls: 2 } }
    });
    assert.equal(result.status, "LIVE_PARTIAL");
    assert.equal(result.network.providerCalls, 2);
    assert.equal(result.budgets.used.providerRequests, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("live runner writes canonical budget evidence when preflight usage exceeds the hard budget", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-phase9b-live-budget-overflow-"));
  try {
    await mkdir(join(root, "repo"));
    await mkdir(join(root, "home"));
    await mkdir(join(root, "safe"));
    await chmod(join(root, "safe"), 0o700);
    const result = await runLive({
      repositoryRoot: join(root, "repo"),
      homeDirectory: join(root, "home"),
      baseDirectory: join(root, "safe"),
      baselineSha: "5df7533141107585cfbaa90a9c40d78a7b0b959a",
      candidateSha: "1111111111111111111111111111111111111111",
      budgetOptions: { providerRequests: 1 },
      preflightResult: { ...preflightReady, network: { providerCalls: 2 } },
      driver: async () => {
        throw new Error("driver must not run after budget overflow");
      }
    });
    assert.equal(result.status, "LIVE_BUDGET_EXHAUSTED");
    assert.equal(result.evidence.status, "LIVE_BUDGET_EXHAUSTED");
    assert.deepEqual(result.evidence.errors, [{ category: "BUDGET_EXHAUSTED" }]);
    assert.equal(result.evidence.budgets.used.providerRequests, 0);
    await assert.doesNotReject(() => validateEvidenceBundle(
      join(root, "repo", "artifacts", "live", "phase9b", result.runId)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("live runner preserves the budget exhausted terminal status in evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-phase9b-live-exhausted-"));
  try {
    await mkdir(join(root, "repo"));
    await mkdir(join(root, "home"));
    await mkdir(join(root, "safe"));
    await chmod(join(root, "safe"), 0o700);
    const result = await runLive({
      repositoryRoot: join(root, "repo"),
      homeDirectory: join(root, "home"),
      baseDirectory: join(root, "safe"),
      baselineSha: "5df7533141107585cfbaa90a9c40d78a7b0b959a",
      candidateSha: "1111111111111111111111111111111111111111",
      preflightResult: preflightReady,
      securityRemediationStatus: "RESOLVED_NO_REUSABLE_CREDENTIAL_EXPOSURE",
      driver: async () => {
        const error = new Error("budget exhausted");
        error.code = "BUDGET_EXHAUSTED";
        throw error;
      }
    });
    assert.equal(result.status, "LIVE_BUDGET_EXHAUSTED");
    assert.equal(result.evidence.status, "LIVE_BUDGET_EXHAUSTED");
    assert.equal(result.evidence.errors[0].category, "BUDGET_EXHAUSTED");
    await assert.doesNotReject(() => validateEvidenceBundle(
      join(root, "repo", "artifacts", "live", "phase9b", result.runId)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("live runner keeps budget exhaustion when runtime cleanup also fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-phase9b-live-exhausted-cleanup-"));
  try {
    await mkdir(join(root, "repo"));
    await mkdir(join(root, "home"));
    await mkdir(join(root, "safe"));
    await chmod(join(root, "safe"), 0o700);
    const result = await runLive({
      repositoryRoot: join(root, "repo"),
      homeDirectory: join(root, "home"),
      baseDirectory: join(root, "safe"),
      baselineSha: "5df7533141107585cfbaa90a9c40d78a7b0b959a",
      candidateSha: "1111111111111111111111111111111111111111",
      preflightResult: preflightReady,
      securityRemediationStatus: "RESOLVED_NO_REUSABLE_CREDENTIAL_EXPOSURE",
      stopOwnedProcesses: async () => {
        throw new Error("fixture cleanup failure");
      },
      driver: async () => {
        const error = new Error("budget exhausted");
        error.code = "BUDGET_EXHAUSTED";
        throw error;
      }
    });
    assert.equal(result.status, "LIVE_BUDGET_EXHAUSTED");
    assert.equal(result.evidence.status, "LIVE_BUDGET_EXHAUSTED");
    assert.deepEqual(
      result.evidence.errors.map((error) => error.category),
      ["BUDGET_EXHAUSTED", "CLEANUP_FAILED"]);
    await assert.doesNotReject(() => validateEvidenceBundle(
      join(root, "repo", "artifacts", "live", "phase9b", result.runId)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("driver timeout propagates AbortSignal and stops owned processes before cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-phase9b-live-timeout-"));
  try {
    await mkdir(join(root, "repo"));
    await mkdir(join(root, "home"));
    await mkdir(join(root, "safe"));
    await chmod(join(root, "safe"), 0o700);
    const events = [];
    const result = await runLive({
      repositoryRoot: join(root, "repo"),
      homeDirectory: join(root, "home"),
      baseDirectory: join(root, "safe"),
      baselineSha: "5df7533141107585cfbaa90a9c40d78a7b0b959a",
      candidateSha: "1111111111111111111111111111111111111111",
      preflightResult: preflightReady,
      scenarioTimeoutMs: 20,
      globalTimeoutMs: 20,
      driverDrainTimeoutMs: 100,
      securityRemediationStatus: "RESOLVED_NO_REUSABLE_CREDENTIAL_EXPOSURE",
      stopOwnedProcesses: async () => {
        events.push("stop");
      },
      driver: async ({ signal }) => await new Promise((resolve) => {
        signal.addEventListener("abort", () => {
          events.push("abort");
          resolve({ scenarios: [] });
        }, { once: true });
      })
    });
    assert.equal(result.status, "LIVE_PARTIAL");
    assert.equal(events.includes("abort"), true);
    assert.equal(events.includes("stop"), true);
    assert.equal(events.indexOf("abort") < events.indexOf("stop"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("live runner does not promote a passing subset to PASS", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-phase9b-live-subset-"));
  try {
    await mkdir(join(root, "repo"));
    await mkdir(join(root, "home"));
    await mkdir(join(root, "safe"));
    await chmod(join(root, "safe"), 0o700);
    const result = await runLive({
      repositoryRoot: join(root, "repo"),
      homeDirectory: join(root, "home"),
      baseDirectory: join(root, "safe"),
      baselineSha: "5df7533141107585cfbaa90a9c40d78a7b0b959a",
      candidateSha: "1111111111111111111111111111111111111111",
      preflightResult: preflightReady,
      securityRemediationStatus: "RESOLVED_NO_REUSABLE_CREDENTIAL_EXPOSURE",
      driver: async () => ({
        scenarios: [createScenario("realtime", "PASS", undefined, new Date().toISOString())]
      })
    });
    assert.equal(result.status, "LIVE_PARTIAL");
    assert.equal(result.evidence.status, "LIVE_PARTIAL");
    assert.equal(result.evidence.scenarios.some((scenario) => scenario.id === "acceptance-matrix"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("live runner requires explicit security resolution before promoting a complete driver to PASS", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-phase9b-live-security-"));
  try {
    await mkdir(join(root, "repo"));
    await mkdir(join(root, "home"));
    await mkdir(join(root, "safe"));
    await chmod(join(root, "safe"), 0o700);
    const startedAtUtc = new Date().toISOString();
    let driverCalls = 0;
    const result = await runLive({
      repositoryRoot: join(root, "repo"),
      homeDirectory: join(root, "home"),
      baseDirectory: join(root, "safe"),
      baselineSha: "5df7533141107585cfbaa90a9c40d78a7b0b959a",
      candidateSha: "1111111111111111111111111111111111111111",
      preflightResult: preflightReady,
      driver: async () => {
        driverCalls += 1;
        return {
          scenarios: REQUIRED_SCENARIO_IDS.map((id) => createScenario(id, "PASS", undefined, startedAtUtc, startedAtUtc))
        };
      }
    });
    assert.equal(result.status, "BLOCKED_SECURITY_REMEDIATION");
    assert.equal(result.evidence.status, "BLOCKED_SECURITY_REMEDIATION");
    assert.deepEqual(result.evidence.errors, [{ category: "BLOCKED_SECURITY_REMEDIATION" }]);
    assert.equal(driverCalls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("live runner cannot let preflight provider options bypass its security gate", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-phase9b-live-preflight-security-"));
  try {
    await mkdir(join(root, "repo"));
    await mkdir(join(root, "home"));
    await mkdir(join(root, "safe"));
    await chmod(join(root, "safe"), 0o700);
    let providerCalls = 0;
    const result = await runLive({
      repositoryRoot: join(root, "repo"),
      homeDirectory: join(root, "home"),
      baseDirectory: join(root, "safe"),
      baselineSha: "5df7533141107585cfbaa90a9c40d78a7b0b959a",
      candidateSha: "1111111111111111111111111111111111111111",
      preflightOptions: {
        noProviderCall: false,
        securityRemediationStatus: "RESOLVED_NO_REUSABLE_CREDENTIAL_EXPOSURE",
        providerProbe: async () => {
          providerCalls += 1;
        }
      }
    });
    assert.equal(result.status, "BLOCKED_SECURITY_REMEDIATION");
    assert.equal(result.evidence.status, "BLOCKED_SECURITY_REMEDIATION");
    assert.equal(providerCalls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("live runner persists the bounded desktop automation emission", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-phase9b-live-automation-"));
  try {
    await mkdir(join(root, "repo"));
    await mkdir(join(root, "home"));
    await mkdir(join(root, "safe"));
    await chmod(join(root, "safe"), 0o700);
    const startedAtUtc = new Date().toISOString();
    const automation = {
      status: "PASS",
      states: [{ testId: DESKTOP_AUTOMATION_TEST_IDS.realtimeStatus, value: "connected" }],
      counts: { remoteTrackCount: 1 }
    };
    const result = await runLive({
      repositoryRoot: join(root, "repo"),
      homeDirectory: join(root, "home"),
      baseDirectory: join(root, "safe"),
      baselineSha: "5df7533141107585cfbaa90a9c40d78a7b0b959a",
      candidateSha: "1111111111111111111111111111111111111111",
      preflightResult: preflightReady,
      securityRemediationStatus: "RESOLVED_NO_REUSABLE_CREDENTIAL_EXPOSURE",
      driver: async () => ({
        scenarios: [createScenario("realtime", "PASS", undefined, startedAtUtc)],
        automation
      })
    });
    assert.equal(result.status, "LIVE_PARTIAL");
    assert.deepEqual(result.evidence.desktopAutomation, automation);
    const written = JSON.parse(await readFile(join(root, "repo", result.evidencePath), "utf8"));
    assert.deepEqual(written.desktopAutomation, automation);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
