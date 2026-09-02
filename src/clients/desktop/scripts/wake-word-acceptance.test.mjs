import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  fixtureManifest,
  runAcceptance as runAcceptanceReport
} from "./wake-word-acceptance.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const acceptanceScript = join(scriptDirectory, "wake-word-acceptance.mjs");

function runAcceptance(...arguments_) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [acceptanceScript, ...arguments_], {
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

function readProductionWakeWordConfig() {
  return new Promise((resolve, reject) => {
    const tsx = join(scriptDirectory, "../../../../node_modules/.bin/tsx");
    const child = spawn(process.execPath, [tsx, "-e", [
      "import { wakeWordConfig } from './src/main/wake-word-acceptance-config.ts';",
      "console.log(JSON.stringify(wakeWordConfig));"
    ].join(" ")], {
      cwd: join(scriptDirectory, ".."),
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => stdout += chunk);
    child.stderr.on("data", chunk => stderr += chunk);
    child.on("error", reject);
    child.on("close", code => {
      if (code !== 0) {
        reject(new Error(stderr || `tsx exited with code ${code}`));
        return;
      }
      resolve(JSON.parse(stdout));
    });
  });
}

test("offline wake-word acceptance reports real-model results for literal fixtures", async () => {
  const result = await runAcceptance();

  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "passed");
  assert.deepEqual(report.app, { name: "Jarvis Desktop", version: "0.1.0" });
  assert.equal(report.runtime.name, "sherpa-onnx");
  assert.equal(report.runtime.version, "1.13.7");
  assert.equal(typeof report.runtime.onnxruntimeVersion, "string");
  assert.notEqual(report.runtime.onnxruntimeVersion, "");
  assert.equal(report.model.name, "sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01");
  assert.equal(report.model.archiveSha256,
    "b2f7c89690dc8ce4c6ed6afeab7cd800c36ad1421fb6b6302b4a4b194cf7f35f");
  assert.deepEqual(
    report.fixtures.map(fixture => [fixture.name, fixture.kind, fixture.expectedDetected]),
      [
      ["jarvis-licensed-positive", "licensed-speech", true],
      ["silence", "silence", false],
      ["negative-synthetic", "synthetic-non-speech", false],
      ["background-synthetic", "synthetic-background", false]
    ]);
  for (const fixture of report.fixtures) {
    assert.equal(fixture.status, "passed");
    assert.equal(fixture.detected, fixture.expectedDetected);
    assert.equal(typeof fixture.durationMs, "number");
    assert.ok(fixture.durationMs >= 0);
    assert.equal("path" in fixture, false);
  }
  assert.equal(report.overallStatus, "passed");
  assert.doesNotMatch(result.stdout, /\/(?:Users|private|tmp)\//);
});

test("invalid fixture input fails with a bounded actionable error", async () => {
  const result = await runAcceptance("--fixture", "not-a-fixture");

  assert.equal(result.code, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Unknown fixture\. Available fixtures:/);
  assert.match(result.stderr, /jarvis-licensed-positive/);
  assert.doesNotMatch(result.stderr, /\/(?:Users|private|tmp)\//);
});

test("invalid fixture paths are redacted from CLI errors", async () => {
  const result = await runAcceptance("--fixture", "/tmp/private-fixture");

  assert.equal(result.code, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Unknown fixture/);
  assert.doesNotMatch(result.stderr, /\/(?:Users|private|tmp)\//);
});

test("unknown fixture input never echoes a secret-shaped value", async () => {
  const secret = "Bearer sk-jarvis-live-7f0d9e8a";
  const result = await runAcceptance("--fixture", secret);

  assert.equal(result.code, 2);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    "Unknown fixture. Available fixtures: jarvis-licensed-positive, silence, "
      + "negative-synthetic, background-synthetic.\n");
  assert.doesNotMatch(result.stdout, new RegExp(secret));
  assert.doesNotMatch(result.stderr, new RegExp(secret));
});

test("unknown arguments never echo a secret-shaped value", async () => {
  const secret = "sk-jarvis-live-2c4a6e90";
  const result = await runAcceptance(`--unknown-${secret}`);

  assert.equal(result.code, 2);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    "Unknown acceptance argument. Use --fixture, --runtime-root, --model-root, or --fixtures-root.\n");
  assert.doesNotMatch(result.stdout, new RegExp(secret));
  assert.doesNotMatch(result.stderr, new RegExp(secret));
});

test("invalid model input fails without exposing filesystem details", async () => {
  const result = await runAcceptance("--model-root", "/tmp/no-such-jarvis-model");

  assert.equal(result.code, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Model file encoder\.int8\.onnx is missing or unreadable/);
  assert.doesNotMatch(result.stderr, /\/(?:Users|private|tmp)\//);
});

test("missing licensed positive fixture fails with a bounded error", async () => {
  const result = await runAcceptance(
    "--fixtures-root", "/tmp/no-such-jarvis-fixtures",
    "--fixture", "jarvis-licensed-positive");

  assert.equal(result.code, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Fixture jarvis-licensed-positive is missing or unreadable/);
  assert.doesNotMatch(result.stderr, /\/(?:Users|private|tmp)\//);
});

test("configured runtime root is used and runtime failures are redacted", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "jarvis-wake-runtime-"));
  const markerPath = join(fixtureRoot, "runtime-loaded.marker");
  try {
    await writeFile(join(fixtureRoot, "package.json"), JSON.stringify({
      name: "sherpa-onnx",
      version: "1.13.7",
      main: "index.js"
    }));
    await writeFile(
      join(fixtureRoot, "index.js"),
      [
        "require('node:fs').writeFileSync(",
        JSON.stringify(markerPath),
        ", 'loaded');",
        "throw new Error('runtime leaked /private/fixture/runtime path');\n"
      ].join("")
    );

    const result = await runAcceptance("--runtime-root", fixtureRoot, "--fixture", "silence");

    assert.equal(result.code, 2);
    assert.equal(result.stdout, "");
    assert.equal(await readFile(markerPath, "utf8"), "loaded");
    assert.match(result.stderr, /sherpa-onnx runtime is missing or unloadable/);
    assert.doesNotMatch(result.stderr, /\/(?:Users|private|tmp)\//);
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});

test("incompatible runtime metadata fails with a bounded error", async () => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "jarvis-wake-incompatible-runtime-"));
  try {
    await writeFile(join(runtimeRoot, "package.json"), "{\"name\":\"wrong-runtime\"}");

    const result = await runAcceptance(
      "--runtime-root", runtimeRoot,
      "--fixture", "silence");

    assert.equal(result.code, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /sherpa-onnx runtime is missing or unloadable/);
    assert.doesNotMatch(result.stderr, /\/(?:Users|private|tmp)\//);
  } finally {
    await rm(runtimeRoot, { force: true, recursive: true });
  }
});

test("a different runtime version cannot stand in for the pinned package", async () => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "jarvis-wake-runtime-version-"));
  try {
    await writeFile(join(runtimeRoot, "package.json"), JSON.stringify({
      name: "sherpa-onnx",
      version: "0.0.0",
      main: "index.js"
    }));
    await writeFile(join(runtimeRoot, "index.js"), "module.exports = {};\n");

    const result = await runAcceptance(
      "--runtime-root", runtimeRoot,
      "--fixture", "silence");

    assert.equal(result.code, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /sherpa-onnx runtime is missing or unloadable/);
    assert.doesNotMatch(result.stderr, /\/(?:Users|private|tmp)\//);
  } finally {
    await rm(runtimeRoot, { force: true, recursive: true });
  }
});

test("malformed audio fails before model execution with a bounded error", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "jarvis-wake-malformed-audio-"));
  const fixture = fixtureManifest["jarvis-licensed-positive"];
  const originalSha256 = fixture.sha256;
  try {
    const malformed = Buffer.from("not-a-wave");
    await writeFile(join(fixtureRoot, fixture.file), malformed);
    fixture.sha256 = createHash("sha256").update(malformed).digest("hex");

    await assert.rejects(
      runAcceptanceReport({
        fixturesRoot: fixtureRoot,
        fixtureNames: ["jarvis-licensed-positive"]
      }),
      error => {
        assert.match(error.message, /not a RIFF\/WAVE/);
        assert.doesNotMatch(error.message, /\/(?:Users|private|tmp)\//);
        return true;
      });
  } finally {
    fixture.sha256 = originalSha256;
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});

test("corrupt model bytes fail the pinned integrity check without paths", async () => {
  const modelRoot = await mkdtemp(join(tmpdir(), "jarvis-wake-corrupt-model-"));
  try {
    for (const file of ["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"]) {
      await writeFile(join(modelRoot, file), Buffer.from("corrupt-model"));
    }

    const result = await runAcceptance("--model-root", modelRoot, "--fixture", "silence");

    assert.equal(result.code, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Model file encoder\.int8\.onnx failed its pinned SHA-256 check/);
    assert.doesNotMatch(result.stderr, /\/(?:Users|private|tmp)\//);
  } finally {
    await rm(modelRoot, { force: true, recursive: true });
  }
});

test("repeating a generated fixture returns the same machine result", async () => {
  const [first, second] = await Promise.all([
    runAcceptance("--fixture", "silence"),
    runAcceptance("--fixture", "silence")
  ]);

  assert.equal(first.code, 0, first.stderr);
  assert.equal(second.code, 0, second.stderr);
  const normalize = output => {
    const report = JSON.parse(output);
    return {
      ...report,
      fixtures: report.fixtures.map(fixture => ({ ...fixture, durationMs: 0 }))
    };
  };
  assert.deepEqual(normalize(first.stdout), normalize(second.stdout));
});

test("the runner exports the production KWS contract for drift checks", async () => {
  const { wakeWordConfig } = await import("./wake-word-acceptance.mjs");
  const productionConfig = await readProductionWakeWordConfig();
  const serviceSource = await readFile(
    join(scriptDirectory, "../src/main/wake-word-service.ts"), "utf8");

  assert.deepEqual(wakeWordConfig, productionConfig);
  assert.match(serviceSource, /from "\.\/wake-word-acceptance-config\.js"/);
  for (const field of [
    "keyword",
    "tokens",
    "samplingRate",
    "featureDim",
    "numThreads",
    "provider",
    "debug",
    "modelingUnit",
    "maxActivePaths",
    "numTrailingBlanks",
    "keywordsScore",
    "keywordsThreshold"
  ]) {
    assert.match(serviceSource, new RegExp(`wakeWordConfig\\.${field}`));
  }
  assert.doesNotMatch(serviceSource, /keywordsThreshold: 0\.25/);
});
