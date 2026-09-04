import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  boundAuditOutput,
  calculateWorstCaseAuditDuration,
  classifyAuditResult,
  DEFAULT_PROCESS_TIMEOUT_MS,
  MAX_ATTEMPTS,
  MAX_PROCESS_TIMEOUT_MS,
  MAX_RETRY_BACKOFF_MS,
  MAX_SUMMARY_CHARS,
  runAuditProcess,
  runPackageAudit,
  summarizeAuditFailure,
  WORKSPACE_QUALITY_JOB_BUDGET_MS
} from "./check-package-audit.mjs";

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessGone(pid, timeoutMs = 1_500) {
  const deadline = Date.now() + timeoutMs;
  while (processExists(pid) && Date.now() < deadline) {
    await delay(25);
  }
  return !processExists(pid);
}

test("package audit retries a socket timeout and succeeds on the next bounded attempt", async () => {
  const calls = [];
  const delays = [];
  const result = await runPackageAudit({
    runProcess: async (request) => {
      calls.push(request);
      return calls.length === 1
        ? { exitCode: 1, stdout: "", stderr: "ERR_SOCKET_TIMEOUT registry.npmjs.org" }
        : { exitCode: 0, stdout: "No known vulnerabilities found", stderr: "" };
    },
    sleep: async (milliseconds) => delays.push(milliseconds),
    retryBackoffMs: 1
  });

  assert.equal(result.status, "passed");
  assert.equal(result.attempts, 2);
  assert.equal(calls.length, 2);
  assert.deepEqual(delays, [1]);
  assert.deepEqual(calls[0].args, [
    "audit",
    "--registry=https://registry.npmjs.org",
    "--audit-level=high"
  ]);
});

test("package audit exhausts the bounded budget for repeated transport timeouts", async () => {
  const calls = [];
  const delays = [];
  await assert.rejects(
    () => runPackageAudit({
      maxAttempts: 3,
      runProcess: async (request) => {
        calls.push(request);
        return { exitCode: 1, stdout: "", stderr: "ERR_SOCKET_TIMEOUT" };
      },
      sleep: async (milliseconds) => delays.push(milliseconds),
      retryBackoffMs: 2
    }),
    error => error?.classification === "retryable-transport" && error.attempts === 3
  );
  assert.equal(calls.length, 3);
  assert.deepEqual(delays, [2, 4]);
});

test("package audit fails immediately when the child process itself times out", async () => {
  const calls = [];
  const delays = [];

  await assert.rejects(
    () => runPackageAudit({
      maxAttempts: 3,
      runProcess: async (request) => {
        calls.push(request);
        return { exitCode: null, stdout: "", stderr: "", timedOut: true };
      },
      sleep: async (milliseconds) => delays.push(milliseconds),
      retryBackoffMs: 1
    }),
    error => error?.classification === "child-process-timeout"
      && error.attempts === 1,
    "a child-process timeout is a bounded immediate failure"
  );

  assert.equal(calls.length, 1);
  assert.deepEqual(delays, []);
});

test("package audit retries a metadata fetch timeout only when its nested cause is transient", async () => {
  const calls = [];
  const result = await runPackageAudit({
    runProcess: async (request) => {
      calls.push(request);
      return calls.length === 1
        ? {
          exitCode: 1,
          stdout: "",
          stderr: "ERR_PNPM_META_FETCH_FAIL GET https://registry.npmjs.org/foo: ETIMEDOUT"
        }
        : { exitCode: 0, stdout: "No known vulnerabilities found", stderr: "" };
    },
    sleep: async () => {},
    retryBackoffMs: 0
  });

  assert.equal(result.status, "passed");
  assert.equal(result.attempts, 2);
});

test("package audit recognizes the explicit transient network error codes", async () => {
  const transientErrors = ["ETIMEDOUT", "ECONNRESET", "EAI_AGAIN"];
  for (const transientError of transientErrors) {
    let calls = 0;
    const result = await runPackageAudit({
      runProcess: async () => {
        calls += 1;
        return calls === 1
          ? { exitCode: 1, stdout: "", stderr: transientError }
          : { exitCode: 0, stdout: "No known vulnerabilities found", stderr: "" };
      },
      sleep: async () => {},
      retryBackoffMs: 0
    });
    assert.equal(result.status, "passed", transientError);
    assert.equal(calls, 2, transientError);
  }
});

test("package audit fails a valid vulnerability report without retrying it", async () => {
  const calls = [];
  await assert.rejects(
    () => runPackageAudit({
      maxAttempts: 3,
      runProcess: async (request) => {
        calls.push(request);
        return {
          exitCode: 1,
          stdout: JSON.stringify({
            auditReportVersion: 2,
            vulnerabilities: {
              "unsafe-package": { severity: "high" }
            },
            metadata: { vulnerabilities: { high: 1 } }
          }),
          stderr: "ERR_SOCKET_TIMEOUT should not mask the report"
        };
      },
      sleep: async () => {}
    }),
    error => error?.classification === "vulnerability" && error.attempts === 1
  );
  assert.equal(calls.length, 1);
});

test("package audit does not retry an unknown non-zero exit", async () => {
  const calls = [];
  await assert.rejects(
    () => runPackageAudit({
      runProcess: async (request) => {
        calls.push(request);
        return { exitCode: 1, stdout: "", stderr: "ERR_PNPM_UNKNOWN_FAILURE" };
      },
      sleep: async () => {}
    }),
    error => error?.classification === "unknown" && error.attempts === 1
  );
  assert.equal(calls.length, 1);
});

test("package audit rejects malformed structured output immediately", async () => {
  const calls = [];
  await assert.rejects(
    () => runPackageAudit({
      runProcess: async (request) => {
        calls.push(request);
        return { exitCode: 1, stdout: "{not-json", stderr: "" };
      },
      sleep: async () => {}
    }),
    error => error?.classification === "malformed" && error.attempts === 1
  );
  assert.equal(calls.length, 1);
});

test("package audit rejects malformed process results without retrying", async () => {
  let calls = 0;
  await assert.rejects(
    () => runPackageAudit({
      runProcess: async () => {
        calls += 1;
        return { exitCode: "1", stdout: "", stderr: "" };
      },
      sleep: async () => {}
    }),
    error => error?.classification === "malformed" && error.attempts === 1
  );
  assert.equal(calls, 1);
});

test("package audit retries only explicit registry throttling and retryable server responses", async () => {
  const calls = [];
  const result = await runPackageAudit({
    runProcess: async (request) => {
      calls.push(request);
      if (calls.length === 1) {
        return {
          exitCode: 1,
          stdout: "",
          stderr: "ERR_PNPM_FETCH_429 GET https://registry.npmjs.org/foo: Too Many Requests - 429"
        };
      }
      if (calls.length === 2) {
        return {
          exitCode: 1,
          stdout: "",
          stderr: "GET https://registry.npmjs.org/foo: 503 Service Unavailable"
        };
      }
      return { exitCode: 0, stdout: "No known vulnerabilities found", stderr: "" };
    },
    sleep: async () => {},
    retryBackoffMs: 0
  });

  assert.equal(result.status, "passed");
  assert.equal(result.attempts, 3);
});

test("package audit does not retry lockfile, permission, or bare metadata failures", async () => {
  for (const stderr of [
    "ERR_PNPM_OUTDATED_LOCKFILE ERR_SOCKET_TIMEOUT",
    "EACCES: permission denied, open package.json",
    "ERR_PNPM_META_FETCH_FAIL GET https://registry.npmjs.org/foo"
  ]) {
    let calls = 0;
    await assert.rejects(
      () => runPackageAudit({
        runProcess: async () => {
          calls += 1;
          return { exitCode: 1, stdout: "", stderr };
        },
        sleep: async () => {}
      }),
      error => error?.classification === "unknown" && error.attempts === 1
    );
    assert.equal(calls, 1, stderr);
  }
});

test("package audit failure summaries are bounded and redact secrets and absolute paths", () => {
  const secret = "sk-proj-012345678901234567890123456789";
  const summary = summarizeAuditFailure({
    classification: "unknown",
    attempts: 1,
    stdout: `${secret}\n/Users/hobo/projects/jarvis/package.json\n${"x".repeat(2_000)}`,
    stderr: "NPM_TOKEN=do-not-print"
  });

  assert.ok(summary.length <= MAX_SUMMARY_CHARS);
  assert.doesNotMatch(summary, /sk-proj-/);
  assert.doesNotMatch(summary, /NPM_TOKEN=do-not-print/);
  assert.doesNotMatch(summary, /\/Users\/hobo\/projects\/jarvis/);
});

test("package audit summaries redact path-shaped values in structured error text", () => {
  const summary = summarizeAuditFailure({
    classification: "unknown",
    attempts: 1,
    stderr: 'cwd="/opt/runner/work/jarvis/package.json" path=/private/tmp/audit.log'
  });

  assert.doesNotMatch(summary, /\/opt\/runner\/work\/jarvis/);
  assert.doesNotMatch(summary, /\/private\/tmp\/audit\.log/);
});

test("package audit fails an abnormal subprocess without exposing its error", async () => {
  await assert.rejects(
    () => runPackageAudit({
      runProcess: async () => {
        throw new Error("spawn failed at /Users/hobo/projects/jarvis with token=secret");
      }
    }),
    error => error?.classification === "abnormal-subprocess"
      && error.attempts === 1
      && !error.message.includes("/Users/hobo")
      && !error.message.includes("secret")
  );
});

test("package audit output capture is bounded in UTF-8 bytes", () => {
  const bounded = boundAuditOutput("秘密".repeat(100), 17);

  assert.ok(Buffer.byteLength(bounded.value) <= 17);
  assert.equal(bounded.truncated, true);
});

test("default audit deadline covers pnpm's known transport retry window within CI budget", async () => {
  assert.ok(DEFAULT_PROCESS_TIMEOUT_MS > 250_000);
  assert.ok(MAX_PROCESS_TIMEOUT_MS <= 600_000);
  assert.ok(calculateWorstCaseAuditDuration({
    maxAttempts: MAX_ATTEMPTS,
    processTimeoutMs: MAX_PROCESS_TIMEOUT_MS,
    retryBackoffMs: MAX_RETRY_BACKOFF_MS
  }) < WORKSPACE_QUALITY_JOB_BUDGET_MS);

  let request;
  await runPackageAudit({
    runProcess: async value => {
      request = value;
      return { exitCode: 0, stdout: "No known vulnerabilities found", stderr: "" };
    }
  });
  assert.ok(request.timeoutMs > 250_000);
});

test("failure summaries use safe audit markers instead of echoing arbitrary JSON", () => {
  const summary = summarizeAuditFailure({
    classification: "unknown",
    attempts: 1,
    stdout: JSON.stringify({
      NPM_TOKEN: "synthetic-secret-value",
      password: "json-password-value",
      apiKey: "json-api-key-value",
      authorization: "Bearer json-bearer-value",
      path: "/tmp",
      windowsPath: "C:\\Users\\runner\\secret.json"
    }),
    stderr: "ERR_PNPM_UNKNOWN_FAILURE"
  });

  assert.ok(summary.length <= MAX_SUMMARY_CHARS);
  for (const secret of [
    "synthetic-secret-value",
    "json-password-value",
    "json-api-key-value",
    "json-bearer-value",
    "/tmp",
    "C:\\Users\\runner\\secret.json"
  ]) {
    assert.doesNotMatch(summary, new RegExp(secret.replace(/[\\/.*+?()[\]{}|^-]/g, "\\$&")));
  }
  assert.match(summary, /unknown/);
});

test("failure summaries only expose exact allowlisted error markers", () => {
  const summary = summarizeAuditFailure({
    classification: "retryable-transport",
    attempts: 2,
    stderr: "ERR_SECRET_SYNTHETIC_VALUE_123 ERR_SOCKET_TIMEOUT "
      + "ERR_PNPM_META_FETCH_FAIL ETIMEDOUT ECONNRESET EAI_AGAIN HTTP 503"
  });

  assert.doesNotMatch(summary, /ERR_SECRET_SYNTHETIC_VALUE_123/);
  for (const marker of [
    "ERR_SOCKET_TIMEOUT",
    "ERR_PNPM_META_FETCH_FAIL",
    "ETIMEDOUT",
    "ECONNRESET",
    "EAI_AGAIN",
    "HTTP 503"
  ]) {
    assert.match(summary, new RegExp(marker.replace(/[.*+?()[\]{}|^-]/g, "\\$&")));
  }
});

test("a non-closing child settles after bounded cleanup and cannot pass", async () => {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  stdout.destroyed = false;
  stderr.destroyed = false;
  stdout.destroy = () => { stdout.destroyed = true; };
  stderr.destroy = () => { stderr.destroyed = true; };
  const child = new EventEmitter();
  child.pid = 999_999;
  child.stdout = stdout;
  child.stderr = stderr;
  child.signals = [];
  child.kill = signal => { child.signals.push(signal); return true; };
  child.unrefCalled = false;
  child.unref = () => { child.unrefCalled = true; };
  const startedAt = Date.now();

  const runPromise = runAuditProcess({
    timeoutMs: 25,
    terminationGraceMs: 25,
    cleanupWaitMs: 25,
    spawnProcess: () => child
  });
  const result = await Promise.race([
    runPromise,
    delay(250).then(() => undefined)
  ]);

  assert.ok(Date.now() - startedAt < 250);
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(stdout.destroyed, true);
  assert.equal(stderr.destroyed, true);
  assert.equal(child.unrefCalled, true);
  assert.equal(result.cleanupComplete, false);
  assert.equal(classifyAuditResult(result).kind, "child-process-timeout");
});

test("incomplete cleanup is abnormal even when the child reports exit code zero", () => {
  const classification = classifyAuditResult({
    exitCode: 0,
    stdout: "",
    stderr: "",
    cleanupComplete: false,
    processGroupGone: false
  });

  assert.equal(classification.kind, "abnormal-subprocess");
  assert.equal(classification.retryable, false);
});

test("real audit supervisor waits for close and kills an ignored-SIGTERM process group", {
  skip: process.platform === "win32"
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "jarvis-package-audit-shim-"));
  const shimPath = join(directory, "pnpm");
  const pidPath = join(directory, "pids.json");
  await writeFile(shimPath, `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const pidPath = process.env.JARVIS_AUDIT_SHIM_PID_FILE;
const descendant = spawn(process.execPath, [
  "-e",
  "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"
], { stdio: "ignore" });
writeFileSync(pidPath, JSON.stringify({ parent: process.pid, descendant: descendant.pid }));
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`);
  await chmod(shimPath, 0o755);

  let rootPid;
  let runPromise;
  try {
    runPromise = runAuditProcess({
      timeoutMs: 100,
      terminationGraceMs: 50,
      cleanupWaitMs: 100,
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH ?? ""}`,
        JARVIS_AUDIT_SHIM_PID_FILE: pidPath
      }
    });

    const result = await Promise.race([
      runPromise,
      delay(500).then(() => undefined)
    ]);
    assert.ok(result, "supervisor must settle after timeout cleanup");
    assert.equal(result.timedOut, true);
    assert.equal(result.cleanupComplete, true);
    assert.equal(result.processGroupGone, true);

    const pids = JSON.parse(await readFile(pidPath, "utf8"));
    assert.equal(await waitForProcessGone(pids.parent), true);
    assert.equal(await waitForProcessGone(pids.descendant), true);
  } finally {
    if (!Number.isInteger(rootPid)) {
      try {
        rootPid = JSON.parse(await readFile(pidPath, "utf8")).parent;
      } catch {
        // The shim may not have started before a spawn failure.
      }
    }
    if (Number.isInteger(rootPid)) {
      try {
        process.kill(-rootPid, "SIGKILL");
      } catch {
        // The supervisor may already have drained the group.
      }
    }
    if (runPromise) {
      await Promise.race([runPromise, delay(500)]);
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test("normal exit drains a lingering descendant before reporting success", {
  skip: process.platform === "win32"
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "jarvis-package-audit-exit-shim-"));
  const shimPath = join(directory, "pnpm");
  const pidPath = join(directory, "pids.json");
  await writeFile(shimPath, `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const descendant = spawn(process.execPath, [
  "-e",
  "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"
], { stdio: "ignore" });
writeFileSync(process.env.JARVIS_AUDIT_SHIM_PID_FILE, JSON.stringify({
  parent: process.pid,
  descendant: descendant.pid
}));
process.exit(0);
`);
  await chmod(shimPath, 0o755);

  try {
    const result = await runAuditProcess({
      timeoutMs: 1_000,
      terminationGraceMs: 50,
      cleanupWaitMs: 100,
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH ?? ""}`,
        JARVIS_AUDIT_SHIM_PID_FILE: pidPath
      }
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.timedOut, false);
    assert.equal(result.cleanupComplete, true);
    assert.equal(result.processGroupGone, true);
    assert.equal(classifyAuditResult(result).kind, "success");
    const pids = JSON.parse(await readFile(pidPath, "utf8"));
    assert.equal(await waitForProcessGone(pids.parent), true);
    assert.equal(await waitForProcessGone(pids.descendant), true);
  } finally {
    try {
      const pids = JSON.parse(await readFile(pidPath, "utf8"));
      if (Number.isInteger(pids.parent)) {
        process.kill(-pids.parent, "SIGKILL");
      }
    } catch {
      // The shim may have failed before it could write its PID handoff.
    }
    await rm(directory, { recursive: true, force: true });
  }
});
