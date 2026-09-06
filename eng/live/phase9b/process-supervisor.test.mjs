import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { execPath } from "node:process";
import { test } from "node:test";
import {
  ProcessSupervisor,
  assertSafeProcessLaunch
} from "./process-supervisor.mjs";

test("owned process supervisor returns bounded output summaries and restart counts", async () => {
  const supervisor = new ProcessSupervisor({ maxRestarts: 1, timeoutMs: 1_000 });
  const result = await supervisor.run(execPath, ["-e", "process.stdout.write('ok'); process.exit(0)"]);

  assert.equal(result.status, "PASS");
  assert.equal(result.exitCode, 0);
  assert.equal(result.restarts, 0);
  assert.equal(result.attempts, 1);
  assert.deepEqual(result.stdout, { length: 2, sha256: "2689367b205c16ce32ed4200942b8b8b1e262dfc70d9bc9fbc77c49699a4f1df" });
});

test("known secrets split across stdout chunks fail closed without returning a digest", async () => {
  const supervisor = new ProcessSupervisor({ maxRestarts: 2, timeoutMs: 1_000 });
  const result = await supervisor.run(
    execPath,
    ["-e", "process.stdout.write('prefix-'); setImmediate(() => process.stdout.write('secret-value'));"],
    { secretValues: ["prefix-secret-value"] }
  );

  assert.equal(result.status, "FAIL");
  assert.equal(result.errorCategory, "SECRET_DETECTED");
  assert.equal(result.restarts, 0);
  assert.equal(result.attempts, 1);
  assert.equal(result.stdout, null);
  assert.equal(result.stderr, null);
  assert.equal(result.outputSuppressed, true);
});

test("owned process timeout terminates only the owned process group", async () => {
  const supervisor = new ProcessSupervisor({ maxRestarts: 0, timeoutMs: 20, killGraceMs: 20 });
  const result = await supervisor.run(execPath, ["-e", "setInterval(() => {}, 1_000)"]);

  assert.equal(result.status, "TIMEOUT");
  assert.equal(result.errorCategory, "TIMEOUT");
  assert.equal(result.restarts, 0);
});

test("launcher exit still drains descendants in the owned process group", async () => {
  let launcherPid;
  const supervisor = new ProcessSupervisor({
    timeoutMs: 1_000,
    killGraceMs: 100,
    spawnProcess: (...args) => {
      const child = spawn(...args);
      launcherPid = child.pid;
      return child;
    }
  });
  const result = await supervisor.run(execPath, [
    "-e",
    "const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); child.unref();"
  ]);

  assert.equal(result.status, "PASS");
  assert.equal(Number.isInteger(launcherPid), true);
  let groupAlive = false;
  try {
    process.kill(-launcherPid, 0);
    groupAlive = true;
  } catch {
    // The process group should be gone after a successful supervisor run.
  }
  assert.equal(groupAlive, false);
});

test("unsafe secret-bearing process arguments are rejected before spawn", () => {
  assert.throws(
    () => assertSafeProcessLaunch(execPath, ["--api-key", "secret"]),
    (error) => error.code === "UNSAFE_PROCESS_ARGUMENTS"
  );
  assert.throws(
    () => assertSafeProcessLaunch(execPath, ["OPENAI_API_KEY=secret"]),
    (error) => error.code === "UNSAFE_PROCESS_ARGUMENTS"
  );
});
