import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { execPath } from "node:process";
import { test } from "node:test";
import {
  ProcessSupervisor,
  assertSafeProcessLaunch
} from "./process-supervisor.mjs";

const blockedEnvironmentFixture = "controlled-noncredential-fixture";

test("owned process supervisor returns bounded output summaries and restart counts", async () => {
  const supervisor = new ProcessSupervisor({ maxRestarts: 1, timeoutMs: 1_000 });
  const result = await supervisor.run(execPath, ["-e", "process.stdout.write('ok'); process.exit(0)"]);

  assert.equal(result.status, "PASS");
  assert.equal(result.exitCode, 0);
  assert.equal(result.restarts, 0);
  assert.equal(result.attempts, 1);
  assert.deepEqual(result.stdout, { observed: true, suppressed: false });
  assert.deepEqual(result.stderr, { observed: false, suppressed: false });
  assert.equal("length" in result.stdout, false);
  assert.equal("sha256" in result.stdout, false);
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
  assert.deepEqual(result.stdout, { observed: true, suppressed: true });
  assert.deepEqual(result.stderr, { observed: false, suppressed: false });
  assert.equal(result.outputSuppressed, true);
});

test("owned process timeout terminates only the owned process group", async () => {
  const supervisor = new ProcessSupervisor({ maxRestarts: 0, timeoutMs: 20, killGraceMs: 20 });
  const result = await supervisor.run(execPath, ["-e", "setInterval(() => {}, 1_000)"]);

  assert.equal(result.status, "TIMEOUT");
  assert.equal(result.errorCategory, "TIMEOUT");
  assert.equal(result.restarts, 0);
});

test("live child receives only the explicit nonsecret control environment", async () => {
  const supervisor = new ProcessSupervisor({ timeoutMs: 1_000 });
  const environment = {
    JARVIS_PHASE9B_ADMISSION_DESCRIPTOR: "/private/run/admission.json",
    JARVIS_PHASE9B_REALTIME_CALL_URL: "https://fixture.openai.azure.com/openai/v1/realtime/calls",
    JARVIS_PHASE9B_FORGED_CONTROL: "must-not-pass",
    OPENAI_API_KEY: blockedEnvironmentFixture,
    DEEPSEEK_API_KEY: "provider-key-must-not-pass",
    UNRELATED_ENVIRONMENT: "must-not-pass"
  };
  const script = [
    "process.stdout.write(JSON.stringify({",
    "descriptor: process.env.JARVIS_PHASE9B_ADMISSION_DESCRIPTOR ?? null,",
    "realtimeCallUrl: process.env.JARVIS_PHASE9B_REALTIME_CALL_URL ?? null,",
    "forgedControl: process.env.JARVIS_PHASE9B_FORGED_CONTROL ?? null,",
    "openAiKey: process.env.OPENAI_API_KEY ?? null,",
    "deepSeekKey: process.env.DEEPSEEK_API_KEY ?? null,",
    "unrelated: process.env.UNRELATED_ENVIRONMENT ?? null",
    "}));"
  ].join(" ");
  const handle = await supervisor.start(execPath, ["-e", script], { env: environment });
  const result = await handle.waitForExit();

  assert.equal(result.status, "PASS");
  assert.deepEqual(result.stdout, { observed: true, suppressed: false });
  assert.deepEqual(result.stderr, { observed: false, suppressed: false });
  assert.equal("length" in result.stdout, false);
  assert.equal("sha256" in result.stdout, false);
  await supervisor.stopAll();
});

test("live rotation interval reaches the real child without admitting unrelated controls", async () => {
  const supervisor = new ProcessSupervisor({ timeoutMs: 1_000 });
  const handle = await supervisor.start(execPath, ["-e", [
    "const valid = process.env.JARVIS_PHASE9B_ROTATION_AFTER_MS === '60000'",
    "&& process.env.JARVIS_PHASE9B_FORGED_CONTROL === undefined",
    "&& process.env.OPENAI_API_KEY === undefined;",
    "process.exit(valid ? 0 : 9);"
  ].join(" ")], { env: {
    JARVIS_PHASE9B_ROTATION_AFTER_MS: "60000",
    JARVIS_PHASE9B_FORGED_CONTROL: "must-not-pass",
    OPENAI_API_KEY: blockedEnvironmentFixture
  } });
  try {
    const result = await handle.waitForExit();
    assert.equal(result.status, "PASS");
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.stdout, { observed: false, suppressed: false });
    assert.deepEqual(result.stderr, { observed: false, suppressed: false });
  } finally {
    await supervisor.stopAll();
  }
});

test("unknown free text from either stream is represented only by fixed booleans", async () => {
  const supervisor = new ProcessSupervisor({ timeoutMs: 1_000 });
  const result = await supervisor.run(execPath, [
    "-e",
    "process.stdout.write('unclassified fixture text'); process.stderr.write('runtime detail fixture text');"
  ]);

  assert.equal(result.status, "PASS");
  assert.deepEqual(result.stdout, { observed: true, suppressed: false });
  assert.deepEqual(result.stderr, { observed: true, suppressed: false });
  assert.equal("length" in result.stdout, false);
  assert.equal("sha256" in result.stdout, false);
  assert.equal("length" in result.stderr, false);
  assert.equal("sha256" in result.stderr, false);
});

test("runtime error preserves only stream observation metadata", async () => {
  const supervisor = new ProcessSupervisor({ timeoutMs: 1_000 });
  const result = await supervisor.run(execPath, [
    "-e",
    "process.stderr.write('runtime error fixture'); process.exit(7);"
  ]);

  assert.equal(result.status, "FAIL");
  assert.equal(result.exitCode, 7);
  assert.deepEqual(result.stdout, { observed: false, suppressed: false });
  assert.deepEqual(result.stderr, { observed: true, suppressed: false });
});

test("owned live stop settles with bounded boolean output metadata", async () => {
  const supervisor = new ProcessSupervisor({ timeoutMs: 1_000, killGraceMs: 50 });
  const handle = await supervisor.start(execPath, [
    "-e",
    "setTimeout(() => process.stdout.write('long lived fixture'), 10); setInterval(() => {}, 1_000);"
  ]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const result = await handle.stop();

  assert.equal(result.status, "FAIL");
  assert.equal(typeof result.stdout.observed, "boolean");
  assert.equal(result.stdout.suppressed, false);
  assert.deepEqual(result.stderr, { observed: false, suppressed: false });
});

test("owned live finish drains both streams without exposing emitted text", async () => {
  const supervisor = new ProcessSupervisor({ timeoutMs: 1_000 });
  const handle = await supervisor.start(execPath, [
    "-e",
    "process.stdout.write('finished fixture'); process.stderr.write('finished diagnostic'); process.exit(0);"
  ]);
  const result = await handle.waitForExit();

  assert.equal(result.status, "PASS");
  assert.deepEqual(result.stdout, { observed: true, suppressed: false });
  assert.deepEqual(result.stderr, { observed: true, suppressed: false });
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
