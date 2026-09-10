import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createBudgetTracker, withTimeout } from "./budgets.mjs";
import { createRunIsolation } from "./isolation.mjs";
import {
  createEvidence,
  REQUIRED_SCENARIO_IDS,
  scanKnownSecrets,
  validateSecurityRemediationStatus,
  writeLiveEvidence
} from "./evidence.mjs";
import { runPreflight } from "./preflight.mjs";
import { createSafeScenarioDriver } from "./desktop-automation.mjs";

const DEFAULT_BASELINE_SHA = "0000000000000000000000000000000000000000";
const DEFAULT_CANDIDATE_SHA = "0000000000000000000000000000000000000000";

export async function runLive({
  repositoryRoot = process.cwd(),
  homeDirectory = homedir(),
  baseDirectory,
  runId = randomUUID(),
  baselineSha,
  candidateSha,
  preflightResult,
  preflightOptions = {},
  driver,
  securityRemediationStatus,
  scenarioTimeoutMs = 120_000,
  globalTimeoutMs = 15 * 60 * 1000,
  driverDrainTimeoutMs = 5_000,
  processStopTimeoutMs = 30_000,
  budgetOptions,
  secretValues = [],
  providerMetadata,
  processSupervisor,
  stopOwnedProcesses
} = {}) {
  const startedAtUtc = new Date().toISOString();
  const securityStatus = securityRemediationStatus === undefined
    ? "UNVERIFIED"
    : validateSecurityRemediationStatus(securityRemediationStatus);
  const preflightProviderCallRequested = preflightOptions.noProviderCall === false;
  const preflightSecurityGateBlocked = preflightProviderCallRequested
    && securityStatus !== "RESOLVED_NO_REUSABLE_CREDENTIAL_EXPOSURE";
  const preflight = preflightResult ?? await runPreflight({
    repositoryRoot,
    homeDirectory,
    ...preflightOptions,
    noProviderCall: preflightSecurityGateBlocked
      ? true
      : preflightOptions.noProviderCall ?? true,
    securityRemediationStatus: securityStatus
  });
  const budget = createBudgetTracker(budgetOptions);
  const preflightProviderCalls = preflight.network?.providerCalls ?? 0;
  let preflightBudgetError;
  try {
    if (!Number.isSafeInteger(preflightProviderCalls) || preflightProviderCalls < 0) {
      throw new Error("invalid provider call count");
    }
    if (preflightProviderCalls > 0) {
      budget.consume("providerRequests", preflightProviderCalls);
    }
  } catch (error) {
    preflightBudgetError = safeError("BUDGET_EXHAUSTED", "Provider request budget is exhausted.", error);
  }
  const isolation = await createRunIsolation({
    repositoryRoot,
    homeDirectory,
    baseDirectory,
    runId
  });
  let scenarios = [];
  let status = "LIVE_PARTIAL";
  let runError;
  let cleanupError;
  let desktopAutomation;
  let securityGateBlocked = preflightSecurityGateBlocked;
  let driverTask;
  let driverSettled = true;
  let secretDetected = false;
  const scanSecrets = (value) => {
    const detected = scanKnownSecrets(value, secretValues);
    secretDetected ||= detected;
    return detected;
  };
  const stopProcesses = stopOwnedProcesses === undefined
    ? typeof processSupervisor?.stopAll === "function"
      ? () => processSupervisor.stopAll()
      : async () => {}
    : stopOwnedProcesses;
  const scenarioStartedAtUtc = new Date().toISOString();
  try {
    if (securityGateBlocked) {
      scenarios = [createScenario(
        "security-remediation",
        "BLOCKED",
        "BLOCKED_SECURITY_REMEDIATION",
        scenarioStartedAtUtc
      )];
      status = "BLOCKED_SECURITY_REMEDIATION";
    } else if (preflightBudgetError !== undefined) {
      throw preflightBudgetError;
    } else if (preflight.status === "BLOCKED_CREDENTIALS") {
      scenarios = [createScenario(
        "preflight",
        "BLOCKED",
        "BLOCKED_CREDENTIALS",
        scenarioStartedAtUtc
      )];
      status = "BLOCKED_CREDENTIALS";
    } else if (typeof preflight.status === "string" && preflight.status.startsWith("BLOCKED")) {
      scenarios = [createScenario(
        "preflight",
        "BLOCKED",
        preflightErrorCategory(preflight.status),
        scenarioStartedAtUtc
      )];
      status = preflight.status;
    } else if (typeof driver === "function"
        && securityStatus !== "RESOLVED_NO_REUSABLE_CREDENTIAL_EXPOSURE") {
      scenarios = [createScenario(
        "security-remediation",
        "BLOCKED",
        "BLOCKED_SECURITY_REMEDIATION",
        scenarioStartedAtUtc
      )];
      status = "BLOCKED_SECURITY_REMEDIATION";
      securityGateBlocked = true;
    } else if (typeof driver !== "function") {
      scenarios = [createScenario(
        "desktop-golden-path",
        "UNVERIFIED",
        "SCENARIO_DRIVER_UNAVAILABLE",
        scenarioStartedAtUtc
      )];
      status = "LIVE_PARTIAL";
    } else {
      const safeDriver = createSafeScenarioDriver(driver);
      const driverResult = await withTimeout(
        (signal) => {
          driverSettled = false;
          driverTask = Promise.resolve().then(() => safeDriver({
            isolation,
            budget,
            preflight,
            signal,
            processSupervisor,
            stopOwnedProcesses: stopProcesses,
            scanSecrets,
            runScenario: (operation) => withTimeout(operation, scenarioTimeoutMs, { signal })
          }));
          driverTask.then(
            () => { driverSettled = true; },
            () => { driverSettled = true; }
          );
          driverTask.catch(() => {});
          return driverTask;
        },
        globalTimeoutMs
      );
      if (secretDetected || scanSecrets(driverResult)) {
        throw safeError("SECRET_DETECTED", "Known secret detected in driver output.");
      }
      if (!Array.isArray(driverResult?.scenarios) || driverResult.scenarios.length === 0) {
        throw safeError("VALIDATION_FAILED", "Scenario driver returned no scenarios.");
      }
      scenarios = driverResult.scenarios;
      desktopAutomation = driverResult.automation;
      status = aggregateStatus(scenarios);
      if (status === "PASS" && !hasCompleteScenarioSet(scenarios)) {
        status = "LIVE_PARTIAL";
        scenarios = [
          ...scenarios,
          createScenario(
            "acceptance-matrix",
            "UNVERIFIED",
            "VALIDATION_FAILED",
            new Date().toISOString())
        ];
      }
    }
  } catch (error) {
    runError = error;
    const errorCategory = driverErrorCategory(error);
    scenarios = [createScenario(
      "desktop-golden-path",
      errorCategory === "TIMEOUT" ? "UNVERIFIED" : "FAIL",
      errorCategory,
      scenarioStartedAtUtc
    )];
    status = errorCategory === "BUDGET_EXHAUSTED"
      ? "LIVE_BUDGET_EXHAUSTED"
      : errorCategory === "TIMEOUT" ? "LIVE_PARTIAL" : "FAIL";
  }

  try {
    await withTimeout(() => stopProcesses(), processStopTimeoutMs);
  } catch (error) {
    cleanupError = error;
    if (status !== "LIVE_BUDGET_EXHAUSTED") {
      status = "FAIL";
    }
    scenarios.push(createScenario("process-cleanup", "FAIL", "CLEANUP_FAILED", new Date().toISOString()));
  }
  if (driverTask !== undefined && !driverSettled) {
    await settleDriver(driverTask, driverDrainTimeoutMs);
  }
  if (driverTask !== undefined && !driverSettled) {
    cleanupError = safeError("CLEANUP_FAILED", "Scenario driver did not settle before cleanup.");
    if (status !== "LIVE_BUDGET_EXHAUSTED") {
      status = "FAIL";
    }
    scenarios.push(createScenario("cleanup", "FAIL", "CLEANUP_FAILED", new Date().toISOString()));
  } else {
    try {
      await isolation.cleanup();
    } catch (error) {
      cleanupError = error;
      if (status !== "LIVE_BUDGET_EXHAUSTED") {
        status = "FAIL";
      }
      scenarios.push(createScenario("cleanup", "FAIL", "CLEANUP_FAILED", new Date().toISOString()));
    }
  }

  const finishedAtUtc = new Date().toISOString();
  const metadata = providerMetadata ?? {
    electronVersion: "44.0.0",
    realtimeProvider: "AzureOpenAI",
    realtimeModel: "unknown-model",
    realtimeVoice: "alloy",
    responsesProvider: "DeepSeek",
    responsesModel: "unknown-model",
    summarizerModel: "unknown-model"
  };
  const platform = preflight.checks?.platform ?? {
    os: process.platform,
    arch: process.arch,
    osVersion: "unknown"
  };
  const toolchain = preflight.checks?.toolchain ?? {
    node: process.versions.node,
    pnpm: "unknown",
    dotnet: "unknown",
    codex: "unknown"
  };
  const evidence = createEvidence({
    runId,
    baselineSha: baselineSha ?? await resolveGitSha(repositoryRoot, "origin/main") ?? DEFAULT_BASELINE_SHA,
    candidateSha: candidateSha ?? await resolveGitSha(repositoryRoot, "HEAD") ?? DEFAULT_CANDIDATE_SHA,
    startedAtUtc,
    finishedAtUtc,
    status,
    platform: {
      os: toEvidenceOs(platform.os),
      arch: toEvidenceArch(platform.arch),
      osVersion: String(platform.osVersion ?? "unknown").slice(0, 64)
    },
    toolchain: {
      node: String(toolchain.node ?? "unknown").slice(0, 32),
      pnpm: String(toolchain.pnpm ?? "unknown").slice(0, 32),
      dotnet: String(toolchain.dotnet ?? "unknown").slice(0, 32),
      codex: String(toolchain.codex ?? "unknown").slice(0, 32)
    },
    provider: metadata,
    budgets: {
      limits: budget.snapshot().limits,
      used: budget.snapshot().used
    },
    scenarios,
    artifacts: [],
    errors: [
      ...(runError === undefined ? [] : [{ category: driverErrorCategory(runError) }]),
      ...(cleanupError === undefined ? [] : [{ category: "CLEANUP_FAILED" }]),
      ...(securityGateBlocked ? [{ category: "BLOCKED_SECURITY_REMEDIATION" }] : [])
    ],
    secretScan: { passed: true },
    securityRemediation: {
      status: securityGateBlocked ? "BLOCKED_SECURITY_REMEDIATION" : securityStatus
    },
    ...(desktopAutomation === undefined ? {} : { desktopAutomation })
  });
  const written = await writeLiveEvidence({ repositoryRoot, evidence, secretValues });
  const relativeEvidencePath = `artifacts/live/phase9b/${runId}/evidence.json`;
  return {
    status,
    runId,
    scenarioStatus: scenarios[0]?.status ?? "UNVERIFIED",
    network: { providerCalls: budget.snapshot().used.providerRequests },
    budgets: evidence.budgets,
    evidencePath: relativeEvidencePath,
    manifestPath: `artifacts/live/phase9b/${runId}/manifest.json`,
    evidence,
    written: Boolean(written)
  };
}

export function createScenario(id, status, errorCategory, startedAtUtc, finishedAtUtc = new Date().toISOString()) {
  const started = Date.parse(startedAtUtc);
  const finished = Date.parse(finishedAtUtc);
  return {
    id,
    status,
    startedAtUtc,
    finishedAtUtc,
    durationMs: Math.max(0, Math.min(10 * 60 * 1000, finished - started)),
    errorCategory
  };
}

export async function resolveGitSha(repositoryRoot, ref) {
  if (typeof repositoryRoot !== "string" || typeof ref !== "string") {
    return null;
  }
  return await new Promise((resolveSha) => {
    let output = "";
    let done = false;
    const finish = (value) => {
      if (!done) {
        done = true;
        resolveSha(value);
      }
    };
    let child;
    try {
      child = spawn("git", ["-C", repositoryRoot, "rev-parse", ref], {
        stdio: ["ignore", "pipe", "ignore"]
      });
    } catch {
      finish(null);
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(null);
    }, 5_000);
    timer.unref?.();
    child.stdout?.on("data", (chunk) => {
      output += String(chunk).slice(0, 128);
    });
    child.once("error", () => {
      clearTimeout(timer);
      finish(null);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      const sha = output.trim();
      finish(code === 0 && /^[a-f0-9]{40,64}$/.test(sha) ? sha : null);
    });
  });
}

async function settleDriver(driverTask, timeoutMs) {
  try {
    await withTimeout(driverTask, timeoutMs);
  } catch {
    // The abort signal and process supervisor own the actual cancellation;
    // this bounded drain only prevents cleanup from racing a quick unwind.
  }
}

function preflightErrorCategory(status) {
  if (status === "BLOCKED_CODEX_AUTH") {
    return "BLOCKED_CODEX_AUTH";
  }
  if (status === "BLOCKED_PROVIDER_CONFIG") {
    return "INVALID_PROVIDER_CONFIG";
  }
  if (status === "BLOCKED_PROVIDER_ACCESS") {
    return "BLOCKED_PROVIDER_ACCESS";
  }
  return "BLOCKED_TOOLCHAIN";
}

function driverErrorCategory(error) {
  const category = error?.code;
  return new Set([
    "BLOCKED_PROVIDER_ACCESS",
    "BLOCKED_CODEX_AUTH",
    "BUDGET_EXHAUSTED",
    "CLEANUP_FAILED",
    "INVALID_PROVIDER_CONFIG",
    "INVALID_AUTOMATION_OUTPUT",
    "PROCESS_ERROR",
    "PROCESS_START_FAILED",
    "SECRET_DETECTED",
    "TIMEOUT",
    "UNSUPPORTED_DEEPSEEK_BACKGROUND",
    "VALIDATION_FAILED"
  ]).has(category)
    ? category
    : "SCENARIO_DRIVER_FAILED";
}

function aggregateStatus(scenarios) {
  if (scenarios.every((scenario) => scenario.status === "PASS")) {
    return "PASS";
  }
  if (scenarios.some((scenario) => scenario.status === "FAIL")) {
    return "FAIL";
  }
  return "LIVE_PARTIAL";
}

function hasCompleteScenarioSet(scenarios) {
  if (!Array.isArray(scenarios) || scenarios.length !== REQUIRED_SCENARIO_IDS.length) {
    return false;
  }
  const ids = new Set(scenarios.map((scenario) => scenario?.id));
  return ids.size === REQUIRED_SCENARIO_IDS.length
    && REQUIRED_SCENARIO_IDS.every((id) => ids.has(id));
}

function toEvidenceOs(value) {
  return new Set(["darwin", "linux", "win32", "unknown", "unsupported"]).has(value)
    ? value
    : "unsupported";
}

function toEvidenceArch(value) {
  return new Set(["arm64", "x64", "unknown", "unsupported"]).has(value)
    ? value
    : "unsupported";
}

function safeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] !== undefined && resolve(process.argv[1]) === currentFile) {
  try {
    const result = await runLive({
      repositoryRoot: process.cwd(),
      preflightOptions: {
        codexPath: process.env.PHASE9B_CODEX_PATH,
        noProviderCall: true
      },
      securityRemediationStatus: process.env.PHASE9B_SECURITY_REMEDIATION_STATUS
    });
    process.stdout.write(`${JSON.stringify({
      schemaVersion: 1,
      status: result.status,
      runId: result.runId,
      scenarioStatus: result.scenarioStatus,
      network: result.network,
      budgets: result.budgets,
      evidencePath: result.evidencePath,
      manifestPath: result.manifestPath
    })}\n`);
    process.exitCode = result.status === "FAIL"
      || result.status === "LIVE_BUDGET_EXHAUSTED"
      || result.status.startsWith("BLOCKED") ? 1 : 0;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      schemaVersion: 1,
      status: error?.code === "BUDGET_EXHAUSTED" ? "LIVE_BUDGET_EXHAUSTED" : "FAIL",
      errorCategory: error.code ?? "LIVE_RUN_FAILED",
      network: { providerCalls: 0 }
    })}\n`);
    process.exitCode = 1;
  }
}
