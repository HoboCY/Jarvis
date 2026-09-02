import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { build } from "esbuild";
import { assertBundleImports, assertWakeWordBundleContract } from "./assert-package.mjs";
import { resolveRendererDependencies } from "./renderer-dependencies.mjs";

const desktopRoot = new URL("../", import.meta.url);
const distRoot = new URL("../dist/", import.meta.url);

const expectedFiles = new Set([
  "assets/JarvisTemplate.png",
  "assets/JarvisTemplate@2x.png",
  "assets/sherpa-kws-wenetspeech-3.3M/MODEL_INFO.md",
  "assets/sherpa-kws-wenetspeech-3.3M/decoder.int8.onnx",
  "assets/sherpa-kws-wenetspeech-3.3M/encoder.int8.onnx",
  "assets/sherpa-kws-wenetspeech-3.3M/joiner.int8.onnx",
  "assets/sherpa-kws-wenetspeech-3.3M/tokens.txt",
  "main/main.js",
  "node_modules/node-cpal/bin/darwin-arm64/index.node",
  "node_modules/node-cpal/cpal-values.js",
  "node_modules/node-cpal/facade.js",
  "node_modules/node-cpal/index.js",
  "node_modules/node-cpal/package.json",
  "node_modules/sherpa-onnx/README.md",
  "node_modules/sherpa-onnx/index.js",
  "node_modules/sherpa-onnx/package.json",
  "node_modules/sherpa-onnx/sherpa-onnx-asr.js",
  "node_modules/sherpa-onnx/sherpa-onnx-kws.js",
  "node_modules/sherpa-onnx/sherpa-onnx-punctuation.js",
  "node_modules/sherpa-onnx/sherpa-onnx-speaker-diarization.js",
  "node_modules/sherpa-onnx/sherpa-onnx-speech-enhancement.js",
  "node_modules/sherpa-onnx/sherpa-onnx-tts.js",
  "node_modules/sherpa-onnx/sherpa-onnx-vad.js",
  "node_modules/sherpa-onnx/sherpa-onnx-wasm-nodejs.js",
  "node_modules/sherpa-onnx/sherpa-onnx-wasm-nodejs.wasm",
  "node_modules/sherpa-onnx/sherpa-onnx-wave.js",
  "preload/index.cjs",
  "preload/overlay.cjs",
  "renderer/index.html",
  "renderer/main.css",
  "renderer/main.js",
  "renderer/overlay.html",
  "renderer/overlay.js"
]);

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryUrl = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directory);
    if (entry.isDirectory()) {
      files.push(...await filesUnder(entryUrl));
    } else {
      files.push(entryUrl);
    }
  }
  return files;
}

async function readBuiltFile(path) {
  await stat(new URL(path, distRoot));
  return readFile(new URL(path, distRoot), "utf8");
}

test("desktop build emits only the packaged entry bundles and assets", async () => {
  const files = (await filesUnder(distRoot))
    .map(file => relative(fileURLToPath(distRoot), fileURLToPath(file)))
    .sort();

  assert.deepEqual(new Set(files), expectedFiles);
  assert.equal(files.some(file => file.endsWith(".test.js")), false);
  assert.equal(files.some(file => file.endsWith(".map") || file.endsWith(".d.ts")), false);
});

test("renderer bundles have no bare external imports", async () => {
  for (const path of ["renderer/main.js", "renderer/overlay.js"]) {
    assertBundleImports(await readBuiltFile(path), path, new Set());
  }
  assert.throws(
    () => assertBundleImports('import("unbundled-renderer")', "renderer-fixture.js", new Set()),
    /unbundled-renderer/
  );
  assert.throws(
    () => assertBundleImports("import(dynamicSpecifier)", "renderer-fixture.js", new Set()),
    /dynamic-or-nonliteral/
  );
});

test("renderer html loads the bundled control-panel stylesheet", async () => {
  const html = await readBuiltFile("renderer/index.html");
  const css = await readBuiltFile("renderer/main.css");
  assert.match(html, /href="\.\/main\.css"/);
  assert.match(css, /\.jarvis-shell/);
  assert.match(css, /prefers-reduced-motion/);
});

test("main and preload bundles externalize only Electron and Node modules", async () => {
  const allowedExternal = new Set([
    "electron",
    ...builtinModules,
    ...builtinModules.map(name => `node:${name}`)
  ]);
  for (const path of ["main/main.js", "preload/index.cjs", "preload/overlay.cjs"]) {
    assertBundleImports(await readBuiltFile(path), path, allowedExternal);
  }
});

test("main bundle points to CommonJS preload entry files", async () => {
  const main = await readBuiltFile("main/main.js");
  assert.match(main, /preload\/index\.cjs/);
  assert.match(main, /preload\/overlay\.cjs/);
});

test("renderer scenario runner pins the canonical dist despite caller overrides", async () => {
  const runner = await readFile(new URL("renderer-scenario-runner.mjs", import.meta.url), "utf8");
  assert.match(runner, /JARVIS_DESKTOP_SCENARIO_DIST:\s*canonicalDistRoot/);
  assert.match(runner, /const canonicalDistRoot = resolve\(desktopRoot, "dist"\)/);
});

test("renderer scenario configures isolated Chromium storage before its first await", async () => {
  const runner = await readFile(new URL("renderer-scenario-runner.mjs", import.meta.url), "utf8");
  const scenario = await readFile(new URL("renderer-scenario.mjs", import.meta.url), "utf8");
  const firstAwait = scenario.indexOf("await ");
  const userDataConfiguration = scenario.indexOf('app.setPath("userData", scenarioUserDataPath)');

  assert.match(runner, /`--user-data-dir=\$\{userDataPath\}`/);
  assert.match(runner, /`--disk-cache-dir=\$\{scenarioCachePath\}`/);
  assert.match(scenario, /app\.setPath\("sessionData", scenarioUserDataPath\)/);
  assert.ok(firstAwait > userDataConfiguration);
});

test("realtime recovery harness bundles production seams in memory", async () => {
  const harnessPath = new URL("realtime-recovery-scenario.tsx", import.meta.url);
  const harness = await readFile(harnessPath, "utf8");
  const desktopRootPath = fileURLToPath(desktopRoot);
  const repositoryRoot = resolve(desktopRootPath, "../../..");
  const rendererDependencies = resolveRendererDependencies(desktopRootPath);
  const rendererDependencyPlugin = {
    name: "desktop-test-renderer-dependencies",
    setup(esbuild) {
      esbuild.onResolve({ filter: /^(?:react|react\/jsx-runtime|react-dom\/client)$/ }, args => {
        const target = rendererDependencies.get(args.path);
        return target ? { path: target } : undefined;
      });
    }
  };
  const workspaceSourcePlugin = {
    name: "desktop-test-workspace-sources",
    setup(esbuild) {
      const sources = new Map([
        ["@jarvis/contracts-ts", join(repositoryRoot, "packages/contracts-ts/src/index.ts")],
        ["@jarvis/realtime-agent", join(repositoryRoot, "packages/realtime-agent/src/index.ts")]
      ]);
      esbuild.onResolve({ filter: /^@jarvis\/(?:contracts-ts|realtime-agent)$/ }, args => {
        const source = sources.get(args.path);
        return source ? { path: source } : undefined;
      });
    }
  };

  assert.match(harness, /from "\.\.\/src\/renderer\/realtime\.js"/);
  assert.match(harness, /from "\.\.\/src\/renderer\/realtime-retry-controls\.js"/);
  const result = await build({
    absWorkingDir: repositoryRoot,
    bundle: true,
    conditions: ["browser", "import", "default"],
    entryPoints: [fileURLToPath(harnessPath)],
    format: "iife",
    jsx: "automatic",
    logLevel: "silent",
    platform: "browser",
    plugins: [workspaceSourcePlugin, rendererDependencyPlugin],
    target: "es2022",
    write: false
  });

  assert.equal(result.outputFiles.length, 1);
  assert.match(result.outputFiles[0].text, /realtime-retry-persistence/);
});

test("renderer scenario verifies persistence recovery through injected DOM behavior", async () => {
  const scenario = await readFile(new URL("renderer-scenario.mjs", import.meta.url), "utf8");

  assert.match(scenario, /buildRealtimeRecoveryHarness/);
  assert.match(scenario, /__jarvisRealtimePersistenceRecovery/);
  assert.match(scenario, /data-realtime-recovery/);
  assert.doesNotMatch(scenario, /inspectRealtimeRetryBundleContract/);
  assert.doesNotMatch(scenario, /realtimeRetryBundle\.persistenceFailureProjectionIncluded/);
});

test("renderer notification scenario keeps structured delivery outcomes observable", async () => {
  const scenario = await readFile(new URL("renderer-scenario.mjs", import.meta.url), "utf8");

  assert.match(scenario, /function scenarioIpcFailure\(kind, code\)/);
  assert.match(scenario, /function isScenarioIpcFailureEnvelope\(value\)/);
  assert.match(scenario, /if \(isScenarioIpcFailureEnvelope\(value\)\) \{\s+return value;/);
  assert.match(scenario, /retryableDeliveryFailure = scenarioIpcFailure\("retryable", "backend_unavailable"\)/);
  assert.match(scenario, /terminalDeliveryFailure = scenarioIpcFailure\("terminal", "not_pending"\)/);
  assert.match(scenario, /notificationDeliveryOutcomes = new Map\(\[/);
  assert.match(scenario, /\[notificationId, "succeeded"\]/);
  assert.match(scenario, /\[notificationIdTwo, "retryable"\]/);
  assert.match(scenario, /\[notificationIdThree, "terminal"\]/);
  assert.match(scenario, /notificationDeliveryAttempts\.push\(\{[\s\S]*notificationId: deliveredNotificationId,[\s\S]*idempotencyKey,[\s\S]*attempt,[\s\S]*outcome/);
  assert.match(scenario, /if \(outcome === "retryable"\) \{\s+return retryableDeliveryFailure;/);
  assert.match(scenario, /if \(outcome === "terminal"\) \{\s+return terminalDeliveryFailure;/);
});

test("packaged wake loop keeps native detection behind the Main/Preload IPC boundary", async () => {
  const main = await readBuiltFile("main/main.js");
  const preload = await readBuiltFile("preload/index.cjs");
  const renderer = await readBuiltFile("renderer/main.js");

  assertWakeWordBundleContract({ main, preload, renderer });
});

test("desktop build metadata removes unused API client and pins esbuild", async () => {
  const packageJson = JSON.parse(await readFile(new URL("package.json", desktopRoot), "utf8"));
  assert.equal(packageJson.dependencies?.["@jarvis/api-client-ts"], undefined);
  assert.equal(packageJson.dependencies?.["node-cpal"], "1.0.0");
  assert.equal(packageJson.dependencies?.["sherpa-onnx"], "1.13.7");
  assert.equal(packageJson.devDependencies?.["@picovoice/porcupine-web"], undefined);
  assert.equal(packageJson.devDependencies?.esbuild, "0.25.0");
});

test("macOS packaging gates on the copied sherpa runtime acceptance", async () => {
  const packageJson = JSON.parse(await readFile(new URL("package.json", desktopRoot), "utf8"));
  const packageGate = packageJson.scripts?.["check:package"];

  assert.match(packageGate, /pnpm build/);
  assert.match(
    packageGate,
    /wake-word-acceptance\.mjs --runtime-root dist\/node_modules\/sherpa-onnx --model-root dist\/assets\/sherpa-kws-wenetspeech-3\.3M/);
  assert.match(packageJson.scripts?.["package:mac"], /check:package/);
  assert.match(packageJson.scripts?.["make:mac"], /check:package/);
});

test("renderer dependency resolution supports a hoisted react-dom package", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "jarvis-renderer-dependencies-"));
  const fixtureDesktopRoot = join(fixtureRoot, "src/clients/desktop");
  const desktopReactRoot = join(fixtureDesktopRoot, "node_modules/react");
  const hoistedReactDomRoot = join(fixtureRoot, "node_modules/react-dom");

  try {
    await Promise.all([
      mkdir(desktopReactRoot, { recursive: true }),
      mkdir(hoistedReactDomRoot, { recursive: true })
    ]);
    await Promise.all([
      writeFile(join(fixtureDesktopRoot, "package.json"), "{}\n"),
      writeFile(join(desktopReactRoot, "index.js"), "module.exports = {};\n"),
      writeFile(join(desktopReactRoot, "jsx-runtime.js"), "module.exports = {};\n"),
      writeFile(join(hoistedReactDomRoot, "client.js"), "module.exports = {};\n")
    ]);

    const dependencies = resolveRendererDependencies(fixtureDesktopRoot);

    assert.equal(dependencies.get("react"), await realpath(join(desktopReactRoot, "index.js")));
    assert.equal(
      dependencies.get("react/jsx-runtime"),
      await realpath(join(desktopReactRoot, "jsx-runtime.js"))
    );
    assert.equal(
      dependencies.get("react-dom/client"),
      await realpath(join(hoistedReactDomRoot, "client.js"))
    );
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});
