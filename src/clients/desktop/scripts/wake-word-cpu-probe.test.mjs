import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runAcceptance } from "./wake-word-acceptance.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const probeScript = join(scriptDirectory, "wake-word-cpu-probe.mjs");

function runProbe(...arguments_) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [probeScript, ...arguments_], {
      cwd: join(scriptDirectory, ".."),
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => stdout += chunk);
    child.stderr.on("data", chunk => stderr += chunk);
    child.on("error", reject);
    child.on("close", code => resolve({ code, stdout, stderr }));
  });
}

test("CPU probe emits a machine-readable real-model measurement", async () => {
  const result = await runProbe(
    "--fixture", "silence",
    "--iterations", "1",
    "--warmup-iterations", "0");

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, "");
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "passed");
  assert.equal(report.probe, "wake-word-inference-cpu");
  assert.deepEqual(report.app, { name: "Jarvis Desktop", version: "0.1.0" });
  assert.equal(report.runtime.name, "sherpa-onnx");
  assert.equal(report.runtime.version, "1.13.7");
  assert.equal(report.model.name, "sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01");
  const canonicalArchiveSha256 =
    "b2f7c89690dc8ce4c6ed6afeab7cd800c36ad1421fb6b6302b4a4b194cf7f35f";
  assert.equal(report.model.archiveSha256, canonicalArchiveSha256);
  assert.equal(report.model.archiveSha256.length, 64);
  const acceptance = await runAcceptance({ fixtureNames: ["silence"] });
  assert.equal(acceptance.model.archiveSha256, canonicalArchiveSha256);
  assert.equal(report.model.archiveSha256, acceptance.model.archiveSha256);
  assert.equal(report.fixture.name, "silence");
  assert.equal(report.fixture.detected, false);
  assert.equal(report.iterations, 1);
  assert.equal(report.warmupIterations, 0);
  for (const field of ["wallTimeMs", "cpuUserMs", "cpuSystemMs", "cpuTimeMs", "cpuPerIterationMs", "inputDurationMs"]) {
    assert.equal(typeof report[field], "number", field);
    assert.ok(report[field] >= 0, field);
  }
  assert.equal(report.config.provider, "cpu");
  assert.equal(report.config.numThreads, 1);
  assert.equal("runtimeRoot" in report, false);
  assert.equal("modelRoot" in report, false);
  assert.equal("fixturesRoot" in report, false);
  assert.doesNotMatch(result.stdout, /\/(?:Users|private|tmp)\//);
});

test("CPU probe rejects work beyond its bounded iteration limit", async () => {
  const result = await runProbe("--iterations", "11");

  assert.equal(result.code, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /iterations must be an integer between 1 and 10/);
  assert.doesNotMatch(result.stderr, /\/(?:Users|private|tmp)\//);
});

test("CPU probe rejects unknown arguments without echoing values", async () => {
  const secret = "sk-jarvis-live-cpu-probe";
  const result = await runProbe(`--unknown-${secret}`);

  assert.equal(result.code, 2);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    "Unknown CPU probe argument. Use --fixture, --runtime-root, --model-root, "
      + "--fixtures-root, --iterations, or --warmup-iterations.\n");
  assert.doesNotMatch(result.stderr, new RegExp(secret));
});
