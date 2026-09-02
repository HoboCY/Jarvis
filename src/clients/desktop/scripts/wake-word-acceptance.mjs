import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));
const defaultRuntimeRoot = resolve(desktopRoot, "../../../node_modules/sherpa-onnx");
const defaultModelRoot = resolve(desktopRoot, "src/assets/sherpa-kws-wenetspeech-3.3M");
const defaultFixturesRoot = resolve(desktopRoot, "src/assets/wake-word-fixtures");
const packageJsonPath = resolve(desktopRoot, "package.json");

const sampleRate = 16_000;
const chunkSize = 1_600;
const maxFixtureSeconds = 15;
const maxFixtureBytes = sampleRate * maxFixtureSeconds * 2 + 64 * 1024;
const maxModelFileBytes = 8 * 1024 * 1024;
const expectedRuntimeVersion = "1.13.7";
const wakeWordConfig = Object.freeze({
  keyword: "贾维斯",
  tokens: "j iǎ w éi s ī @贾维斯",
  samplingRate: sampleRate,
  featureDim: 80,
  numThreads: 1,
  provider: "cpu",
  debug: 0,
  modelingUnit: "ppinyin",
  maxActivePaths: 4,
  numTrailingBlanks: 1,
  keywordsScore: 1.0,
  keywordsThreshold: 0.25
});

const modelFiles = {
  "encoder.int8.onnx": "dd784973fc9d2fabb3b800d6dcd20fc3b0ca84f8e2415afe54b032878e447f4d",
  "decoder.int8.onnx": "ed83454004d5bd16d831eaf00adcd181ed7734886aab6ef440f3ffa5aa3cfe3b",
  "joiner.int8.onnx": "f79760052b87239e325f0567c752ad3130b30d92effb847d4307743c20c59a24",
  "tokens.txt": "72316508d9119696145abc6f1f8cdc46287535c34e5ce7e595f845cb1499cf2e"
};

function isSafeIdentity(value) {
  return typeof value === "string" && /^[A-Za-z0-9._+-]{1,64}$/.test(value);
}

const fixtureManifest = {
  "jarvis-licensed-positive": {
    kind: "licensed-speech",
    expectedDetected: true,
    file: "jarvis-licensed-positive.wav",
    sha256: "bae8363b47875ca45ae620a1622c1df179ad03dd44582cd7070df30c025765bf"
  },
  silence: {
    kind: "silence",
    expectedDetected: false,
    generate: () => new Float32Array(sampleRate * 2)
  },
  "negative-synthetic": {
    kind: "synthetic-non-speech",
    expectedDetected: false,
    generate: () => generateDeterministicPcm(2, 0x12345678, 0.3)
  },
  "background-synthetic": {
    kind: "synthetic-background",
    expectedDetected: false,
    generate: () => generateDeterministicPcm(6, 0x9e3779b9, 0.05)
  }
};

function generateDeterministicPcm(seconds, seed, amplitude) {
  const samples = new Float32Array(sampleRate * seconds);
  let state = seed >>> 0;
  for (let index = 0; index < samples.length; index++) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const noise = ((state >>> 8) / 0xFFFFFF) * 2 - 1;
    const hum = Math.sin(2 * Math.PI * 220 * index / sampleRate);
    samples[index] = amplitude * (0.55 * noise + 0.45 * hum);
  }
  return samples;
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function boundedError(message) {
  const redacted = message
    .replace(/(?:[A-Za-z]:)?\/(?:[^/\s'"`]+\/)+[^/\s'"`]*/g, "<redacted path>")
    .replace(/[\r\n]+/g, " ")
    .trim();
  return new Error(redacted.slice(0, 240) || "Wake-word acceptance failed.");
}

async function loadApplicationIdentity() {
  const packageBuffer = await readRequiredFile(
    packageJsonPath, "Desktop package metadata", 128 * 1024);
  try {
    const packageJson = JSON.parse(packageBuffer.toString("utf8"));
    if (packageJson.name !== "@jarvis/desktop" || !isSafeIdentity(packageJson.version)) {
      throw new Error("invalid Desktop package metadata");
    }
    return { name: "Jarvis Desktop", version: packageJson.version };
  } catch {
    throw new Error("Desktop package metadata is invalid or unreadable.");
  }
}

async function loadSherpaRuntime(runtimeRoot) {
  const resolvedRoot = resolve(runtimeRoot);
  try {
    const packageBuffer = await readRequiredFile(
      join(resolvedRoot, "package.json"), "sherpa-onnx runtime metadata", 128 * 1024);
    const packageJson = JSON.parse(packageBuffer.toString("utf8"));
    if (packageJson.name !== "sherpa-onnx" || packageJson.version !== expectedRuntimeVersion
      || typeof packageJson.main !== "string" || !/^[A-Za-z0-9._-]+\.js$/.test(packageJson.main)) {
      throw new Error("invalid sherpa-onnx runtime metadata");
    }
    const runtimeRequire = createRequire(join(resolvedRoot, "package.json"));
    const runtime = runtimeRequire(join(resolvedRoot, packageJson.main));
    if (!runtime || typeof runtime.createKws !== "function"
      || runtime.version !== expectedRuntimeVersion
      || !isSafeIdentity(runtime.onnxruntimeVersion)
      || !isSafeIdentity(runtime.gitSha1)) {
      throw new Error("incompatible sherpa-onnx runtime");
    }
    return runtime;
  } catch {
    throw new Error("sherpa-onnx runtime is missing or unloadable.");
  }
}

function readPcmWave(buffer, fixtureName) {
  if (buffer.length < 12 || buffer.toString("ascii", 0, 4) !== "RIFF"
    || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error(`Fixture ${fixtureName} is not a RIFF/WAVE file.`);
  }

  let format;
  let data;
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const chunkName = buffer.toString("ascii", offset, offset + 4);
    const chunkLength = buffer.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkLength;
    if (chunkEnd > buffer.length) {
      throw new Error(`Fixture ${fixtureName} has a truncated WAVE chunk.`);
    }
    if (chunkName === "fmt ") {
      if (chunkLength < 16) {
        throw new Error(`Fixture ${fixtureName} has an invalid PCM format chunk.`);
      }
      format = {
        audioFormat: buffer.readUInt16LE(chunkStart),
        channels: buffer.readUInt16LE(chunkStart + 2),
        sampleRate: buffer.readUInt32LE(chunkStart + 4),
        blockAlign: buffer.readUInt16LE(chunkStart + 12),
        bitsPerSample: buffer.readUInt16LE(chunkStart + 14)
      };
    } else if (chunkName === "data") {
      data = buffer.subarray(chunkStart, chunkEnd);
    }
    offset = chunkEnd + (chunkLength % 2);
  }

  if (!format || !data || format.audioFormat !== 1 || format.channels !== 1
    || format.sampleRate !== sampleRate || format.bitsPerSample !== 16
    || format.blockAlign !== 2 || data.length % format.blockAlign !== 0) {
    throw new Error(
      `Fixture ${fixtureName} must be mono 16-bit PCM at ${sampleRate} Hz.`);
  }

  const samples = new Float32Array(data.length / 2);
  for (let index = 0; index < samples.length; index++) {
    samples[index] = data.readInt16LE(index * 2) / 32768;
  }
  if (samples.length === 0 || samples.length > sampleRate * maxFixtureSeconds) {
    throw new Error(`Fixture ${fixtureName} must be between 0 and ${maxFixtureSeconds} seconds.`);
  }
  return { sampleRate: format.sampleRate, samples };
}

function validateAudio(audio, fixtureName) {
  if (audio.sampleRate !== sampleRate || !(audio.samples instanceof Float32Array)
    || audio.samples.length === 0
    || audio.samples.length > sampleRate * maxFixtureSeconds
    || [...audio.samples].some(sample => !Number.isFinite(sample) || sample < -1 || sample > 1)) {
    throw new Error(
      `Fixture ${fixtureName} must be finite mono PCM at ${sampleRate} Hz within the time limit.`);
  }
  return audio;
}

async function loadFixture(fixturesRoot, fixtureName, definition) {
  if (!definition) {
    throw new Error(
      `Unknown fixture. Available fixtures: ${Object.keys(fixtureManifest).join(", ")}.`);
  }
  if (definition.generate) {
    return validateAudio({ sampleRate, samples: definition.generate() }, fixtureName);
  }
  if (!/^[a-f0-9]{64}$/.test(definition.sha256 ?? "")) {
    throw new Error(
      `Fixture ${fixtureName} has no pinned SHA-256 for a redistribution-authorized asset.`);
  }
  const fixtureBuffer = await readRequiredFile(
    join(fixturesRoot, definition.file), `Fixture ${fixtureName}`, maxFixtureBytes);
  const audio = readPcmWave(fixtureBuffer, fixtureName);
  const digest = sha256(fixtureBuffer);
  if (digest !== definition.sha256) {
    throw new Error(`Fixture ${fixtureName} failed its pinned SHA-256 check.`);
  }
  return validateAudio(audio, fixtureName);
}

async function assertModel(modelRoot) {
  for (const [file, expectedDigest] of Object.entries(modelFiles)) {
    const digest = sha256(await readRequiredFile(
      join(modelRoot, file), `Model file ${file}`, maxModelFileBytes));
    if (digest !== expectedDigest) {
      throw new Error(`Model file ${file} failed its pinned SHA-256 check.`);
    }
  }
}

async function readRequiredFile(path, label, maxBytes) {
  try {
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size > maxBytes) {
      throw new Error("file is outside the accepted bounds");
    }
    return await readFile(path);
  } catch {
    throw new Error(`${label} is missing or unreadable, or outside the accepted bounds.`);
  }
}

function createKeywordSpotter(runtime, modelRoot) {
  try {
    return runtime.createKws({
    featConfig: {
      samplingRate: wakeWordConfig.samplingRate,
      featureDim: wakeWordConfig.featureDim
    },
    modelConfig: {
      transducer: {
        encoder: join(modelRoot, "encoder.int8.onnx"),
        decoder: join(modelRoot, "decoder.int8.onnx"),
        joiner: join(modelRoot, "joiner.int8.onnx")
      },
      tokens: join(modelRoot, "tokens.txt"),
      numThreads: wakeWordConfig.numThreads,
      provider: wakeWordConfig.provider,
      debug: wakeWordConfig.debug,
      modelingUnit: wakeWordConfig.modelingUnit
    },
    maxActivePaths: wakeWordConfig.maxActivePaths,
    numTrailingBlanks: wakeWordConfig.numTrailingBlanks,
    keywordsScore: wakeWordConfig.keywordsScore,
    keywordsThreshold: wakeWordConfig.keywordsThreshold,
    keywords: wakeWordConfig.tokens
    });
  } catch {
    throw new Error("Pinned sherpa-onnx wake-word model could not be loaded.");
  }
}

function detectWakeWord(runtime, modelRoot, audio) {
  let kws;
  let stream;
  try {
    kws = createKeywordSpotter(runtime, modelRoot);
    stream = kws.createStream();
    for (let offset = 0; offset < audio.samples.length; offset += chunkSize) {
      const chunk = audio.samples.subarray(offset, offset + chunkSize);
      stream.acceptWaveform(audio.sampleRate, chunk);
      while (kws.isReady(stream)) {
        kws.decode(stream);
        if (kws.getResult(stream).keyword === wakeWordConfig.keyword) {
          return true;
        }
      }
    }
    return false;
  } catch (error) {
    if (error instanceof Error
      && error.message === "Pinned sherpa-onnx wake-word model could not be loaded.") {
      throw error;
    }
    throw new Error("Pinned sherpa-onnx runtime could not process the fixture audio.");
  } finally {
    try {
      stream?.free();
    } catch {
      // The bounded processing error is more useful than a native cleanup detail.
    }
    try {
      kws?.free();
    } catch {
      // The bounded processing error is more useful than a native cleanup detail.
    }
  }
}

async function runAcceptance({
  runtimeRoot = defaultRuntimeRoot,
  modelRoot = defaultModelRoot,
  fixturesRoot = defaultFixturesRoot,
  fixtureNames = Object.keys(fixtureManifest)
} = {}) {
  try {
    const resolvedRuntimeRoot = resolve(runtimeRoot);
    const resolvedModelRoot = resolve(modelRoot);
    const resolvedFixturesRoot = resolve(fixturesRoot);
    const [runtime, app] = await Promise.all([
      loadSherpaRuntime(resolvedRuntimeRoot),
      loadApplicationIdentity()
    ]);
    await assertModel(resolvedModelRoot);

    const fixtures = [];
    for (const name of fixtureNames) {
      const definition = fixtureManifest[name];
      const startedAt = performance.now();
      const audio = await loadFixture(resolvedFixturesRoot, name, definition);
      const detected = detectWakeWord(runtime, resolvedModelRoot, audio);
      fixtures.push({
        name,
        kind: definition.kind,
        expectedDetected: definition.expectedDetected,
        detected,
        durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
        status: detected === definition.expectedDetected ? "passed" : "failed"
      });
    }

    const passed = fixtures.every(fixture => fixture.status === "passed");
    return {
      status: passed ? "passed" : "failed",
      app,
      runtime: {
        name: "sherpa-onnx",
        version: runtime.version,
        onnxruntimeVersion: runtime.onnxruntimeVersion,
        gitSha1: runtime.gitSha1
      },
      model: {
        name: "sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01",
        variant: "epoch 12 average 2, chunk 16, left context 64, INT8",
        archiveSha256: "b2f7c89690dc8ce4c6ed6afeab7cd800c36ad1421fb6b6302b4a4b194cf7f35f",
        license: "Apache-2.0",
        keyword: wakeWordConfig.keyword
      },
      fixtures,
      overallStatus: passed ? "passed" : "failed"
    };
  } catch (error) {
    throw boundedError(error instanceof Error ? error.message : String(error));
  }
}

function parseArguments(arguments_) {
  const options = {
    runtimeRoot: defaultRuntimeRoot,
    modelRoot: defaultModelRoot,
    fixturesRoot: defaultFixturesRoot,
    fixtureNames: Object.keys(fixtureManifest)
  };
  for (let index = 0; index < arguments_.length; index++) {
    const argument = arguments_[index];
    if (argument === "--fixture") {
      const fixtureName = arguments_[++index];
      if (!fixtureName || !Object.hasOwn(fixtureManifest, fixtureName)) {
        throw new Error(
          `Unknown fixture. Available fixtures: ${Object.keys(fixtureManifest).join(", ")}.`);
      }
      options.fixtureNames = [fixtureName];
    } else if (argument === "--runtime-root"
      || argument === "--model-root" || argument === "--fixtures-root") {
      const value = arguments_[++index];
      if (!value || value.startsWith("-")) {
        throw new Error(`${argument} requires a directory path.`);
      }
      if (argument === "--runtime-root") {
        options.runtimeRoot = value;
      } else if (argument === "--model-root") {
        options.modelRoot = value;
      } else {
        options.fixturesRoot = value;
      }
    } else {
      throw new Error(
        "Unknown acceptance argument. Use --fixture, --runtime-root, --model-root, or --fixtures-root.");
    }
  }
  return options;
}

async function main() {
  const report = await runAcceptance(parseArguments(process.argv.slice(2)));
  console.log(JSON.stringify(report));
  return report.overallStatus === "passed" ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(boundedError(error instanceof Error ? error.message : String(error)).message);
    process.exitCode = 2;
  }
}

export { fixtureManifest, runAcceptance, wakeWordConfig };
