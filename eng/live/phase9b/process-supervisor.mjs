import { spawn as nodeSpawn } from "node:child_process";
import { isAbsolute } from "node:path";

const SAFE_ENV_KEYS = new Set([
  "PATH",
  "LANG",
  "LC_ALL",
  "CODEX_HOME",
  "JARVIS_ALLOWED_ROOT",
  "JARVIS_DESKTOP_PROFILE",
  "JARVIS_API_BASE_URL",
  "JARVIS_LOCAL_BEARER",
  "JARVIS_PHASE9B_LIVE",
  "JARVIS_PHASE9B_RUN_ID",
  "JARVIS_PHASE9B_OWNER_MARKER",
  "JARVIS_PHASE9B_ADMISSION_DESCRIPTOR",
  "JARVIS_PHASE9B_REALTIME_CALL_URL",
  "JARVIS_PHASE9B_ROTATION_AFTER_MS",
  "ASPNETCORE_URLS",
  "DOTNET_ENVIRONMENT",
  "NODE_ENV",
  "ConnectionStrings__Jarvis",
  "Authentication__BearerToken",
  "OpenAI__SafetyIdentifierSalt"
]);
const SECRET_ARGUMENT_PATTERN = /(?:^|[-_])(?:api[-_]?key|access[-_]?token|bearer(?:[-_]?token)?|authorization)(?:=|$)/i;
const KNOWN_SECRET_PATTERN = /\b(?:sk-(?:proj|admin|service|svcacct)-[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._-]{16,})\b/;

export class ProcessSupervisor {
  #ownedProcesses = new Set();

  constructor({
    spawnProcess = nodeSpawn,
    maxRestarts = 0,
    timeoutMs = 30_000,
    killGraceMs = 1_000,
    maxOutputBytes = 128 * 1024
  } = {}) {
    if (!Number.isSafeInteger(maxRestarts) || maxRestarts < 0 || maxRestarts > 2) {
      throw new RangeError("Process restart budget is invalid.");
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 10 * 60 * 1000) {
      throw new RangeError("Process timeout is invalid.");
    }
    if (!Number.isSafeInteger(killGraceMs) || killGraceMs < 0 || killGraceMs > 30_000) {
      throw new RangeError("Process kill grace is invalid.");
    }
    if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 0 || maxOutputBytes > 4 * 1024 * 1024) {
      throw new RangeError("Process output limit is invalid.");
    }
    this.spawnProcess = spawnProcess;
    this.maxRestarts = maxRestarts;
    this.timeoutMs = timeoutMs;
    this.killGraceMs = killGraceMs;
    this.maxOutputBytes = maxOutputBytes;
  }

  async run(command, args = [], { cwd, env, secretValues = [], timeoutMs = this.timeoutMs } = {}) {
    assertTimeout(timeoutMs);
    assertSafeProcessLaunch(command, args, { secretValues });
    if (cwd !== undefined && (!isAbsolute(cwd) || cwd.length > 1024)) {
      throw safeError("UNSAFE_PROCESS_CWD", "Process cwd is invalid.");
    }
    const safeEnvironment = sanitizeProcessEnvironment(env);
    let restarts = 0;
    let result;
    while (true) {
      result = await this.#runOnce(command, args, {
        cwd,
        env: safeEnvironment,
        timeoutMs,
        secretValues
      });
      if (result.status === "PASS" || result.errorCategory === "SECRET_DETECTED" || restarts >= this.maxRestarts) {
        return { ...result, restarts, attempts: restarts + 1 };
      }
      restarts += 1;
    }
  }

  async stopAll() {
    const processes = [...this.#ownedProcesses];
    await Promise.all(processes.map(async (child) => {
      try {
        await terminateOwnedProcess(child, this.#ownedProcesses, this.killGraceMs);
      } finally {
        this.#ownedProcesses.delete(child);
      }
    }));
  }

  /**
   * Start a long-lived owned process. `run` is intentionally bounded to a
   * command completion; live services need the same ownership, output scan,
   * and process-group cleanup while remaining available for observations.
   */
  async start(command, args = [], { cwd, env, secretValues = [] } = {}) {
    assertSafeProcessLaunch(command, args, { secretValues });
    if (cwd !== undefined && (!isAbsolute(cwd) || cwd.length > 1024)) {
      throw safeError("UNSAFE_PROCESS_CWD", "Process cwd is invalid.");
    }
    const safeEnvironment = sanitizeProcessEnvironment(env);
    let child;
    try {
      child = this.spawnProcess(command, args, {
        cwd,
        env: safeEnvironment,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch (error) {
      throw safeError("PROCESS_START_FAILED", "Process could not be started.", error);
    }

    this.#ownedProcesses.add(child);
    const stdout = createOutputSummary(this.maxOutputBytes, secretValues);
    const stderr = createOutputSummary(this.maxOutputBytes, secretValues);
    let secretDetected = false;
    let settled = false;
    let finishResult;
    let resolveCompletion;
    const completion = new Promise((resolve) => {
      resolveCompletion = resolve;
    });
    const finish = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      finishResult = {
        status: secretDetected ? "FAIL" : value.exitCode === 0 ? "PASS" : "FAIL",
        errorCategory: secretDetected ? "SECRET_DETECTED" : value.errorCategory ?? null,
        exitCode: value.exitCode ?? null,
        signal: value.signal ?? null,
        stdout: stdout.finish(),
        stderr: stderr.finish(),
        ...(secretDetected ? { outputSuppressed: true } : {})
      };
      this.#ownedProcesses.delete(child);
      resolveCompletion(finishResult);
    };
    const terminate = () => terminateOwnedProcess(child, this.#ownedProcesses, this.killGraceMs)
      .catch(() => {});
    const attach = (stream, summary) => {
      stream?.on?.("data", (chunk) => {
        if (summary.add(chunk)) {
          secretDetected = true;
          void terminate();
        }
      });
    };
    attach(child.stdout, stdout);
    attach(child.stderr, stderr);
    child.once?.("error", (error) => finish({
      exitCode: null,
      signal: null,
      errorCategory: secretDetected ? "SECRET_DETECTED" : error?.code === "ENOENT" ? "PROCESS_START_FAILED" : "PROCESS_ERROR"
    }));
    child.once?.("close", (exitCode, signal) => finish({ exitCode, signal }));

    const stop = async () => {
      await terminateOwnedProcess(child, this.#ownedProcesses, this.killGraceMs).catch(() => {});
      return await completion;
    };
    return Object.freeze({
      pid: Number.isInteger(child.pid) ? child.pid : null,
      isRunning: () => !settled && !hasExited(child),
      waitForExit: async () => await completion,
      stop,
      result: () => finishResult
    });
  }

  async #runOnce(command, args, { cwd, env, timeoutMs, secretValues }) {
    let child;
    try {
      child = this.spawnProcess(command, args, {
        cwd,
        env,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch {
      return {
        status: "FAIL",
        errorCategory: "PROCESS_START_FAILED",
        exitCode: null,
        signal: null,
        stdout: emptyOutputSummary(),
        stderr: emptyOutputSummary()
      };
    }

    this.#ownedProcesses.add(child);
    const stdout = createOutputSummary(this.maxOutputBytes, secretValues);
    const stderr = createOutputSummary(this.maxOutputBytes, secretValues);
    let secretDetected = false;
    let terminationPromise;
    const terminate = () => {
      if (terminationPromise === undefined) {
        terminationPromise = terminateOwnedProcess(
          child,
          this.#ownedProcesses,
          this.killGraceMs
        ).catch(() => {});
      }
      return terminationPromise;
    };
    const attach = (stream, summary) => {
      stream?.on?.("data", (chunk) => {
        if (summary.add(chunk)) {
          secretDetected = true;
          void terminate();
        }
      });
    };
    attach(child.stdout, stdout);
    attach(child.stderr, stderr);

    let timedOut = false;
    let settled = false;
    let timeoutHandle;
    const completion = new Promise((resolve) => {
      const finish = (value) => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(value);
      };
      child.once?.("error", () => finish({
        exitCode: null,
        signal: null,
        errorCategory: secretDetected ? "SECRET_DETECTED" : "PROCESS_ERROR"
      }));
      child.once?.("close", (exitCode, signal) => finish({
        exitCode,
        signal,
        errorCategory: secretDetected ? "SECRET_DETECTED" : null
      }));
      timeoutHandle = setTimeout(async () => {
        timedOut = true;
        await terminate();
        finish({ exitCode: null, signal: "SIGTERM", errorCategory: "TIMEOUT" });
      }, timeoutMs);
    });
    const processResult = await completion;
    clearTimeout(timeoutHandle);
    await terminate();
    this.#ownedProcesses.delete(child);
    const outputSuppressed = secretDetected || stdout.hasSecret() || stderr.hasSecret();
    return {
      status: outputSuppressed ? "FAIL" : timedOut ? "TIMEOUT" : processResult.exitCode === 0 ? "PASS" : "FAIL",
      errorCategory: outputSuppressed ? "SECRET_DETECTED" : timedOut ? "TIMEOUT" : processResult.errorCategory,
      exitCode: processResult.exitCode,
      signal: processResult.signal,
      stdout: stdout.finish(),
      stderr: stderr.finish(),
      ...(outputSuppressed ? { outputSuppressed: true } : {})
    };
  }
}

export function assertSafeProcessLaunch(command, args = [], { secretValues = [] } = {}) {
  if (typeof command !== "string" || command.length === 0 || command.length > 1024) {
    throw safeError("UNSAFE_PROCESS_ARGUMENTS", "Process command is invalid.");
  }
  if (!Array.isArray(args) || args.length > 128 || args.some((arg) => typeof arg !== "string" || arg.length > 2048)) {
    throw safeError("UNSAFE_PROCESS_ARGUMENTS", "Process arguments are invalid.");
  }
  if (!Array.isArray(secretValues)) {
    throw safeError("UNSAFE_PROCESS_ARGUMENTS", "Secret values are invalid.");
  }
  for (const arg of [command, ...args]) {
    if (SECRET_ARGUMENT_PATTERN.test(arg)
        || /^OPENAI_API_KEY=/i.test(arg)
        || /^DEEPSEEK_API_KEY=/i.test(arg)
        || /^AUTHENTICATION__BEARERTOKEN=/i.test(arg)) {
      throw safeError("UNSAFE_PROCESS_ARGUMENTS", "Process arguments cannot carry credentials.");
    }
    for (const secret of secretValues) {
      if (typeof secret === "string" && secret.length > 0 && arg.includes(secret)) {
        throw safeError("UNSAFE_PROCESS_ARGUMENTS", "Process arguments cannot carry credentials.");
      }
    }
  }
}

function assertTimeout(timeoutMs) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 10 * 60 * 1000) {
    throw safeError("INVALID_PROCESS_TIMEOUT", "Process timeout is invalid.");
  }
}

export function sanitizeProcessEnvironment(environment = {}) {
  if (environment === null || typeof environment !== "object" || Array.isArray(environment)) {
    throw safeError("UNSAFE_PROCESS_ENVIRONMENT", "Process environment is invalid.");
  }
  const safe = {};
  for (const [key, value] of Object.entries(environment)) {
    if (SAFE_ENV_KEYS.has(key) && typeof value === "string" && value.length <= 4096) {
      safe[key] = value;
    }
  }
  return safe;
}

export async function terminateOwnedProcess(child, ownedProcesses, killGraceMs = 1_000) {
  if (!ownedProcesses.has(child)) {
    throw safeError("PROCESS_NOT_OWNED", "Process is not owned by this supervisor.");
  }
  const pid = Number.isInteger(child.pid) ? child.pid : null;
  const groupAlive = pid !== null && isProcessGroupAlive(pid);
  if (!groupAlive && pid !== null && hasExited(child)) {
    return;
  }
  sendSignal(child, pid, "SIGTERM");
  await waitForChildClose(child, killGraceMs);
  if (pid !== null && isProcessGroupAlive(pid)) {
    sendSignal(child, pid, "SIGKILL");
    await waitForGroupExit(pid, killGraceMs);
  } else if (!hasExited(child)) {
    try {
      child.kill?.("SIGKILL");
    } catch {
      // A process that already exited is safe to ignore.
    }
  }
}

function hasExited(child) {
  return child?.exitCode !== null && child?.exitCode !== undefined
    || child?.signalCode !== null && child?.signalCode !== undefined;
}

function isProcessGroupAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid || process.platform === "win32") {
    return false;
  }
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function waitForChildClose(child, timeoutMs) {
  if (hasExited(child) || typeof child?.once !== "function") {
    return;
  }
  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.off?.("close", finish);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    child.once("close", finish);
  });
}

async function waitForGroupExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (isProcessGroupAlive(pid)) {
    if (Date.now() >= deadline) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function sendSignal(child, pid, signal) {
  if (pid !== null && process.platform !== "win32") {
    try {
      process.kill(-pid, signal);
      return;
    } catch (error) {
      if (error?.code !== "ESRCH") {
        // The child is still owned; fallback to its handle rather than ever
        // targeting an unrelated pid.
      }
    }
  }
  try {
    child.kill?.(signal);
  } catch {
    // A process that already exited is safe to ignore.
  }
}

function createOutputSummary(maxBytes, secretValues) {
  const knownSecrets = [...new Set((secretValues ?? [])
    .filter((value) => typeof value === "string" && value.length > 0 && value.length <= 4096))];
  const maxTailLength = Math.max(511, ...knownSecrets.map((secret) => secret.length - 1));
  let tail = "";
  let observed = false;
  let secretDetected = false;
  return {
    add(chunk) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      const text = bytes.toString("utf8");
      observed = observed || bytes.length > 0;
      const probe = tail + text;
      if (knownSecrets.some((secret) => probe.includes(secret)) || KNOWN_SECRET_PATTERN.test(probe)) {
        secretDetected = true;
      }
      tail = probe.slice(-maxTailLength);
      return secretDetected;
    },
    hasSecret() {
      return secretDetected;
    },
    finish() {
      return { observed, suppressed: secretDetected };
    }
  };
}

function emptyOutputSummary() {
  return { observed: false, suppressed: false };
}

function safeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
