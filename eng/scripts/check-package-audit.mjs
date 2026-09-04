import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

export const AUDIT_COMMAND = "pnpm";
export const AUDIT_ARGS = Object.freeze([
  "audit",
  "--registry=https://registry.npmjs.org",
  "--audit-level=high"
]);
export const MAX_ATTEMPTS = 3;
export const DEFAULT_RETRY_BACKOFF_MS = 250;
export const MAX_RETRY_BACKOFF_MS = 1_000;
export const DEFAULT_PROCESS_TIMEOUT_MS = 300_000;
export const MAX_PROCESS_TIMEOUT_MS = 597_000;
export const PROCESS_TERMINATION_GRACE_MS = 1_000;
export const PROCESS_CLEANUP_WAIT_MS = 1_000;
export const PROCESS_KILL_GRACE_MS = PROCESS_CLEANUP_WAIT_MS;
export const WORKSPACE_QUALITY_JOB_BUDGET_MS = 30 * 60 * 1_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
export const MAX_MAX_OUTPUT_BYTES = 128 * 1024;
export const MAX_SUMMARY_CHARS = 512;

const wait = (milliseconds) => new Promise((resolveWait) => {
  setTimeout(resolveWait, milliseconds);
});

function removeAnsiSequences(value) {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 27) {
      result += value[index];
      continue;
    }
    index += 1;
    if (value[index] === "[") {
      index += 1;
      while (index < value.length) {
        const code = value.charCodeAt(index);
        if (code >= 0x40 && code <= 0x7e) {
          break;
        }
        index += 1;
      }
    }
  }
  return result;
}

export function boundAuditOutput(value, maximumBytes) {
  const text = String(value ?? "");
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength <= maximumBytes) {
    return { value: text, truncated: false };
  }

  let length = maximumBytes;
  let bounded = bytes.subarray(0, length).toString("utf8");
  while (Buffer.byteLength(bounded, "utf8") > maximumBytes && length > 0) {
    length -= 1;
    bounded = bytes.subarray(0, length).toString("utf8");
  }
  return { value: bounded, truncated: true };
}

function truncateSummary(text, maximum = MAX_SUMMARY_CHARS) {
  return text.length <= maximum ? text : `${text.slice(0, maximum - 1)}…`;
}

function extractSafeAuditMarkers(value) {
  const text = removeAnsiSequences(String(value ?? ""));
  const markers = new Set();
  for (const match of text.matchAll(/\b(?:ERR_SOCKET_TIMEOUT|ERR_PNPM_META_FETCH_FAIL|ERR_PNPM_(?:OUTDATED_LOCKFILE|LOCKFILE_MISSING_DEPENDENCY|FROZEN_LOCKFILE|BAD_PM_VERSION|INVALID_WORKSPACE_CONFIGURATION|NO_MATCHING_VERSION|BAD_OPTION|INVALID_OPTION|BAD_PACKAGE_NAME|FETCH_(?:429|500|501|502|503|504))|EACCES|EPERM|ETIMEDOUT|ECONNRESET|EAI_AGAIN)\b/g)) {
    markers.add(match[0]);
  }
  for (const match of text.matchAll(/\bHTTP\s*(?:429|5\d\d)\b/gi)) {
    markers.add(match[0].replace(/\s+/g, " ").toUpperCase());
  }
  for (const match of text.matchAll(/\b(?:status|response|error)(?:\s+code)?\s*[:=]?\s*(?:429|5\d\d)\b/gi)) {
    markers.add(match[0].replace(/\s+/g, " ").toUpperCase());
  }
  return [...markers];
}

export function redactAuditText(value, maximum = MAX_SUMMARY_CHARS) {
  return truncateSummary(extractSafeAuditMarkers(value).join(", "), maximum);
}

export function summarizeAuditFailure({ classification, attempts, stdout = "", stderr = "" }) {
  const markers = redactAuditText(`${stdout}\n${stderr}`);
  const detail = markers.length > 0 ? ` Markers: ${markers}.` : "";
  return truncateSummary(
    `Package audit failed after ${attempts} attempt${attempts === 1 ? "" : "s"} (${classification}).${detail}`
  );
}

function boundedInteger(value, name, maximum) {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${name} must be an integer between 1 and ${maximum}.`);
  }
  return value;
}

function boundedDelay(value, name, maximum) {
  if (!Number.isInteger(value) || value < 0 || value > maximum) {
    throw new TypeError(`${name} must be an integer between 0 and ${maximum}.`);
  }
  return value;
}

export function calculateWorstCaseAuditDuration({
  maxAttempts = MAX_ATTEMPTS,
  processTimeoutMs = DEFAULT_PROCESS_TIMEOUT_MS,
  retryBackoffMs = MAX_RETRY_BACKOFF_MS
} = {}) {
  let retryDelayMs = 0;
  for (let attempt = 1; attempt < maxAttempts; attempt += 1) {
    retryDelayMs += Math.min(retryBackoffMs * 2 ** (attempt - 1), MAX_RETRY_BACKOFF_MS);
  }
  const processAndCleanupMs = processTimeoutMs
    + PROCESS_TERMINATION_GRACE_MS
    + PROCESS_CLEANUP_WAIT_MS;
  return maxAttempts * processAndCleanupMs + retryDelayMs;
}

function normalizeProcessResult(result) {
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    return { valid: false, reason: "malformed-process-result" };
  }

  const hasExitCode = Object.hasOwn(result, "exitCode") || Object.hasOwn(result, "code");
  const exitCode = Object.hasOwn(result, "exitCode") ? result.exitCode : result.code;
  const stdout = result.stdout === undefined ? "" : result.stdout;
  const stderr = result.stderr === undefined ? "" : result.stderr;
  if (!hasExitCode
    || (exitCode !== null && exitCode !== undefined && !Number.isInteger(exitCode))
    || typeof stdout !== "string"
    || typeof stderr !== "string"
    || (result.signal !== undefined && result.signal !== null && typeof result.signal !== "string")
    || (result.cleanupComplete !== undefined && typeof result.cleanupComplete !== "boolean")
    || (result.processGroupGone !== undefined && typeof result.processGroupGone !== "boolean")) {
    return { valid: false, reason: "malformed-process-result" };
  }

  return {
    valid: true,
    exitCode,
    stdout,
    stderr,
    signal: result.signal ?? null,
    timedOut: result.timedOut === true,
    outputTruncated: result.outputTruncated === true,
    processError: result.processError !== undefined && result.processError !== false,
    errorCode: typeof result.errorCode === "string" ? result.errorCode : "",
    errorMessage: typeof result.errorMessage === "string" ? result.errorMessage : "",
    cleanupComplete: result.cleanupComplete,
    processGroupGone: result.processGroupGone
  };
}

function parseAuditJson(output) {
  const trimmed = output.trimStart();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return { present: false, valid: true, hasFinding: false };
  }

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { present: true, valid: false, hasFinding: false };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { present: true, valid: false, hasFinding: false };
  }

  const hasAdvisories = parsed.advisories === undefined || (
    parsed.advisories !== null
    && typeof parsed.advisories === "object"
    && !Array.isArray(parsed.advisories));
  const hasVulnerabilities = parsed.vulnerabilities === undefined || (
    parsed.vulnerabilities !== null
    && typeof parsed.vulnerabilities === "object"
    && !Array.isArray(parsed.vulnerabilities));
  const hasMetadata = parsed.metadata === undefined || (
    parsed.metadata !== null
    && typeof parsed.metadata === "object"
    && !Array.isArray(parsed.metadata));
  const hasActions = parsed.actions === undefined || Array.isArray(parsed.actions);
  const recognized = Object.hasOwn(parsed, "advisories")
    || Object.hasOwn(parsed, "vulnerabilities")
    || Object.hasOwn(parsed, "metadata")
    || Object.hasOwn(parsed, "actions");
  if (!recognized || !hasAdvisories || !hasVulnerabilities || !hasMetadata || !hasActions) {
    return { present: true, valid: false, hasFinding: false };
  }

  const advisories = parsed.advisories ?? {};
  const vulnerabilities = parsed.vulnerabilities ?? {};
  const metadataVulnerabilities = parsed.metadata?.vulnerabilities ?? {};
  const hasPositiveMetadataCount = Object.values(metadataVulnerabilities).some(
    value => Number.isInteger(value) && value > 0
  );
  const hasFinding = Object.keys(advisories).length > 0
    || Object.keys(vulnerabilities).length > 0
    || hasPositiveMetadataCount
    || (parsed.actions?.length ?? 0) > 0;
  return { present: true, valid: true, hasFinding };
}

function hasTextVulnerabilityReport(output) {
  if (/\bno\s+known\s+vulnerabilit(?:y|ies)\b/i.test(output)) {
    return false;
  }
  return /\b(?:vulnerabilit(?:y|ies)|advisories?)\s+found\b/i.test(output)
    || /\b(?:high|critical)\s+severity\b/i.test(output)
    || /\bseverity\s*:\s*(?:high|critical)\b/i.test(output)
    || /\b(?:high|critical)\b[^\n]{0,80}\bvulnerabilit(?:y|ies)\b/i.test(output);
}

function hasImmediateFailureMarker(output) {
  return /\b(?:ERR_PNPM_(?:OUTDATED_LOCKFILE|LOCKFILE_MISSING_DEPENDENCY|FROZEN_LOCKFILE|BAD_PM_VERSION|INVALID_WORKSPACE_CONFIGURATION|NO_MATCHING_VERSION|BAD_OPTION|INVALID_OPTION|BAD_PACKAGE_NAME)|(?:EACCES|EPERM)|(?:permission|access)\s+denied|invalid\s+(?:argument|option)|unknown\s+option)\b/i.test(output);
}

function hasRetryableRegistryStatus(output) {
  return output.split("\n").some(line => {
    if (!/(?:registry(?:\.npmjs\.org)?|npmjs\.org)/i.test(line)) {
      return false;
    }
    return /\b(?:429|5\d\d)\b/.test(line)
      && /(?:\b(?:HTTP|status|response|error)\b|\s-\s|ERR_PNPM_FETCH_|\b5\d\d\s+[A-Za-z])/i.test(line);
  });
}

function isRetryableTransport(normalized) {
  const output = `${normalized.errorCode}\n${normalized.errorMessage}\n${normalized.stdout}\n${normalized.stderr}`;
  if (hasImmediateFailureMarker(output)) {
    return false;
  }
  if (/\bERR_SOCKET_TIMEOUT\b/.test(output)) {
    return true;
  }
  if (/\bERR_PNPM_META_FETCH_FAIL\b/.test(output)) {
    return /\b(?:timeout|timed\s*out|ETIMEDOUT|ECONNRESET|EAI_AGAIN)\b/i.test(output);
  }
  return /\b(?:ETIMEDOUT|ECONNRESET|EAI_AGAIN)\b/.test(output)
    || hasRetryableRegistryStatus(output);
}

export function classifyAuditResult(result) {
  const normalized = normalizeProcessResult(result);
  if (!normalized.valid) {
    return { kind: "malformed", retryable: false, reason: normalized.reason };
  }
  if (normalized.timedOut) {
    return { kind: "child-process-timeout", retryable: false };
  }
  if (normalized.outputTruncated) {
    return { kind: "malformed", retryable: false, reason: "output-limit-exceeded" };
  }
  if (normalized.processError || normalized.signal !== null) {
    return { kind: "abnormal-subprocess", retryable: false };
  }
  if (normalized.exitCode === null || normalized.exitCode === undefined) {
    return { kind: "abnormal-subprocess", retryable: false };
  }
  if (normalized.cleanupComplete === false || normalized.processGroupGone === false) {
    return { kind: "abnormal-subprocess", retryable: false };
  }
  const combinedOutput = `${normalized.stdout}\n${normalized.stderr}`;
  const parsedStdout = parseAuditJson(normalized.stdout);
  const parsedStderr = parseAuditJson(normalized.stderr);
  if (!parsedStdout.valid || !parsedStderr.valid) {
    return { kind: "malformed", retryable: false, reason: "malformed-audit-report" };
  }
  if (normalized.exitCode === 0) {
    return { kind: "success", retryable: false };
  }

  if (parsedStdout.hasFinding || parsedStderr.hasFinding || hasTextVulnerabilityReport(combinedOutput)) {
    return { kind: "vulnerability", retryable: false };
  }
  if (isRetryableTransport(normalized)) {
    return { kind: "retryable-transport", retryable: true };
  }
  return { kind: "unknown", retryable: false };
}

export function createAuditFailure(classification, attempts, result = {}) {
  const message = summarizeAuditFailure({
    classification: classification.kind,
    attempts,
    stdout: result.stdout,
    stderr: result.stderr
  });
  const error = new Error(message);
  error.code = "PACKAGE_AUDIT_FAILED";
  error.classification = classification.kind;
  error.attempts = attempts;
  error.summary = message;
  return error;
}

export async function runPackageAudit({
  runProcess = runAuditProcess,
  sleep = wait,
  maxAttempts = MAX_ATTEMPTS,
  retryBackoffMs = DEFAULT_RETRY_BACKOFF_MS,
  processTimeoutMs = DEFAULT_PROCESS_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  cwd = repositoryRoot
} = {}) {
  if (typeof runProcess !== "function" || typeof sleep !== "function") {
    throw new TypeError("Package audit process and sleep boundaries must be functions.");
  }
  boundedInteger(maxAttempts, "maxAttempts", MAX_ATTEMPTS);
  if (!Number.isInteger(retryBackoffMs) || retryBackoffMs < 0 || retryBackoffMs > MAX_RETRY_BACKOFF_MS) {
    throw new TypeError(`retryBackoffMs must be an integer between 0 and ${MAX_RETRY_BACKOFF_MS}.`);
  }
  boundedInteger(processTimeoutMs, "processTimeoutMs", MAX_PROCESS_TIMEOUT_MS);
  boundedInteger(maxOutputBytes, "maxOutputBytes", MAX_MAX_OUTPUT_BYTES);
  if (calculateWorstCaseAuditDuration({ maxAttempts, processTimeoutMs, retryBackoffMs })
    >= WORKSPACE_QUALITY_JOB_BUDGET_MS) {
    throw new TypeError("Package audit retry budget must fit within the workspace quality job budget.");
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const request = {
      command: AUDIT_COMMAND,
      args: [...AUDIT_ARGS],
      cwd,
      timeoutMs: processTimeoutMs,
      maxOutputBytes
    };
    let result;
    try {
      result = await runProcess(request);
    } catch (error) {
      result = {
        exitCode: null,
        stdout: "",
        stderr: "",
        processError: true,
        errorMessage: error instanceof Error ? error.message : ""
      };
    }
    const classification = classifyAuditResult(result);
    if (classification.kind === "success") {
      return { status: "passed", attempts: attempt };
    }
    if (!classification.retryable || attempt === maxAttempts) {
      throw createAuditFailure(classification, attempt, result);
    }
    await sleep(Math.min(retryBackoffMs * 2 ** (attempt - 1), MAX_RETRY_BACKOFF_MS));
  }

  throw new Error("Package audit did not produce a result.");
}

export function runAuditProcess({
  cwd = repositoryRoot,
  timeoutMs = DEFAULT_PROCESS_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  terminationGraceMs = PROCESS_TERMINATION_GRACE_MS,
  cleanupWaitMs = PROCESS_CLEANUP_WAIT_MS,
  killGraceMs,
  env = process.env,
  spawnProcess = spawn
} = {}) {
  const effectiveCleanupWaitMs = killGraceMs ?? cleanupWaitMs;
  boundedInteger(timeoutMs, "timeoutMs", MAX_PROCESS_TIMEOUT_MS);
  boundedInteger(maxOutputBytes, "maxOutputBytes", MAX_MAX_OUTPUT_BYTES);
  boundedDelay(terminationGraceMs, "terminationGraceMs", PROCESS_TERMINATION_GRACE_MS);
  boundedDelay(effectiveCleanupWaitMs, "cleanupWaitMs", PROCESS_CLEANUP_WAIT_MS);
  return new Promise((resolveProcess) => {
    let child;
    try {
      child = spawnProcess(AUDIT_COMMAND, AUDIT_ARGS, {
        cwd,
        env,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch {
      resolveProcess({ exitCode: null, stdout: "", stderr: "", processError: true });
      return;
    }

    let stdout = "";
    let stderr = "";
    let outputTruncated = false;
    let timedOut = false;
    let settled = false;
    let childClosed = false;
    let closeResult = { exitCode: null, signal: null };
    let timeout;
    let cleanupStarted = false;

    const append = (target, chunk) => {
      const bounded = boundAuditOutput(`${target}${chunk.toString()}`, maxOutputBytes);
      outputTruncated ||= bounded.truncated;
      return bounded.value;
    };

    const processGroupExists = () => {
      if (!child?.pid) {
        return false;
      }
      if (process.platform === "win32") {
        return !childClosed;
      }
      try {
        process.kill(-child.pid, 0);
        return true;
      } catch (error) {
        return error?.code === "EPERM";
      }
    };

    const signalProcessGroup = (signal) => {
      try {
        if (process.platform !== "win32") {
          process.kill(-child.pid, signal);
        } else {
          child.kill(signal);
        }
      } catch {
        try {
          child.kill(signal);
        } catch {
          // The child may have exited between the group check and the signal.
        }
      }
    };

    const destroyProcessResources = () => {
      for (const stream of [child.stdout, child.stderr]) {
        try {
          stream?.destroy?.();
        } catch {
          // The stream may already be closed.
        }
      }
      try {
        child.unref?.();
      } catch {
        // A child that never emitted close may already be detached.
      }
    };

    const finish = ({
      processGroupGone = !processGroupExists(),
      cleanupComplete = childClosed && processGroupGone
    } = {}) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolveProcess({
        ...closeResult,
        stdout,
        stderr,
        timedOut,
        outputTruncated,
        cleanupComplete,
        processGroupGone
      });
    };

    const waitForCleanup = async () => {
      const deadline = Date.now() + effectiveCleanupWaitMs;
      while ((!childClosed || processGroupExists()) && Date.now() < deadline) {
        await wait(Math.min(25, Math.max(1, deadline - Date.now())));
      }
      const processGroupGone = !processGroupExists();
      const cleanupComplete = childClosed && processGroupGone;
      if (!cleanupComplete) {
        destroyProcessResources();
      }
      return { processGroupGone, cleanupComplete };
    };

    const terminateAndWait = async () => {
      signalProcessGroup("SIGTERM");
      await wait(terminationGraceMs);
      if (!childClosed || processGroupExists()) {
        signalProcessGroup("SIGKILL");
      }
      finish(await waitForCleanup());
    };

    const startCleanup = () => {
      if (cleanupStarted) {
        return;
      }
      cleanupStarted = true;
      void terminateAndWait();
    };

    child.stdout?.on("data", (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = append(stderr, chunk);
    });
    child.once("error", error => {
      childClosed = true;
      closeResult = {
        exitCode: null,
        signal: null,
        processError: true,
        errorCode: typeof error?.code === "string" ? error.code : "",
        errorMessage: error instanceof Error ? error.message : ""
      };
      if (!timedOut) {
        if (processGroupExists()) {
          startCleanup();
        } else {
          finish();
        }
      }
    });
    child.once("close", (exitCode, signal) => {
      childClosed = true;
      closeResult = { exitCode, signal };
      if (!timedOut) {
        if (processGroupExists()) {
          startCleanup();
        } else {
          finish();
        }
      }
    });

    timeout = setTimeout(() => {
      if (timedOut || childClosed) {
        return;
      }
      timedOut = true;
      startCleanup();
    }, timeoutMs);
  });
}

async function main() {
  const result = await runPackageAudit();
  console.log(`Package audit passed after ${result.attempts} attempt${result.attempts === 1 ? "" : "s"}.`);
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] !== undefined && resolve(process.argv[1]) === currentFile) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Package audit failed.");
    process.exitCode = 1;
  }
}
