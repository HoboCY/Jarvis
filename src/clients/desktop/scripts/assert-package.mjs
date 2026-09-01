import { strict as assert } from "node:assert";
import { builtinModules } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractFile, listPackage, statFile } from "@electron/asar";
import * as ts from "typescript";

export const expectedPackageFiles = new Set([
  "package.json",
  "dist/assets/JarvisTemplate.png",
  "dist/assets/JarvisTemplate@2x.png",
  "dist/assets/sherpa-kws-wenetspeech-3.3M/MODEL_INFO.md",
  "dist/assets/sherpa-kws-wenetspeech-3.3M/decoder.int8.onnx",
  "dist/assets/sherpa-kws-wenetspeech-3.3M/encoder.int8.onnx",
  "dist/assets/sherpa-kws-wenetspeech-3.3M/joiner.int8.onnx",
  "dist/assets/sherpa-kws-wenetspeech-3.3M/tokens.txt",
  "dist/main/main.js",
  "dist/node_modules/node-cpal/bin/darwin-arm64/index.node",
  "dist/node_modules/node-cpal/cpal-values.js",
  "dist/node_modules/node-cpal/facade.js",
  "dist/node_modules/node-cpal/index.js",
  "dist/node_modules/node-cpal/package.json",
  "dist/node_modules/sherpa-onnx/README.md",
  "dist/node_modules/sherpa-onnx/index.js",
  "dist/node_modules/sherpa-onnx/package.json",
  "dist/node_modules/sherpa-onnx/sherpa-onnx-asr.js",
  "dist/node_modules/sherpa-onnx/sherpa-onnx-kws.js",
  "dist/node_modules/sherpa-onnx/sherpa-onnx-punctuation.js",
  "dist/node_modules/sherpa-onnx/sherpa-onnx-speaker-diarization.js",
  "dist/node_modules/sherpa-onnx/sherpa-onnx-speech-enhancement.js",
  "dist/node_modules/sherpa-onnx/sherpa-onnx-tts.js",
  "dist/node_modules/sherpa-onnx/sherpa-onnx-vad.js",
  "dist/node_modules/sherpa-onnx/sherpa-onnx-wasm-nodejs.js",
  "dist/node_modules/sherpa-onnx/sherpa-onnx-wasm-nodejs.wasm",
  "dist/node_modules/sherpa-onnx/sherpa-onnx-wave.js",
  "dist/preload/index.cjs",
  "dist/preload/overlay.cjs",
  "dist/renderer/index.html",
  "dist/renderer/main.js",
  "dist/renderer/overlay.html",
  "dist/renderer/overlay.js"
]);

const expectedPackageDirectories = new Set([
  "dist",
  "dist/assets",
  "dist/assets/sherpa-kws-wenetspeech-3.3M",
  "dist/main",
  "dist/node_modules",
  "dist/node_modules/node-cpal",
  "dist/node_modules/node-cpal/bin",
  "dist/node_modules/node-cpal/bin/darwin-arm64",
  "dist/node_modules/sherpa-onnx",
  "dist/preload",
  "dist/renderer"
]);

const nodeBuiltins = new Set([
  ...builtinModules,
  ...builtinModules.map(name => `node:${name}`)
]);

function packageEntryPath(entry) {
  assert.match(entry, /^\//, `Unexpected ASAR entry path: ${entry}`);
  return entry.slice(1);
}

function moduleSpecifiers(source, fileName) {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS
  );
  const specifiers = [];
  const addSpecifier = node => {
    if (node && ts.isStringLiteralLike(node)) {
      specifiers.push(node.text);
    } else {
      specifiers.push("<dynamic-or-nonliteral>");
    }
  };
  const visit = node => {
    if (ts.isImportDeclaration(node)) {
      if (node.moduleSpecifier) {
        addSpecifier(node.moduleSpecifier);
      }
    } else if (ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) {
        addSpecifier(node.moduleSpecifier);
      }
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        addSpecifier(node.arguments[0]);
      } else if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
        addSpecifier(node.arguments[0]);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return [...new Set(specifiers)];
}

export function assertBundleImports(source, fileName, allowedExternal) {
  const specifiers = moduleSpecifiers(source, fileName);
  const unexpected = specifiers.filter(specifier => !allowedExternal.has(specifier));
  assert.deepEqual(
    unexpected,
    [],
    `${fileName} contains imports outside its allowed external set: ${unexpected.join(", ")}`
  );
}

export function assertBuildMetafiles(bundles) {
  for (const { name, result, allowedExternal } of bundles) {
    assert.ok(result.metafile, `${name} build did not produce an esbuild metafile.`);
    const imports = Object.values(result.metafile.outputs)
      .flatMap(output => output.imports ?? [])
      .filter(entry => entry.external)
      .map(entry => entry.path);
    const unexpected = [...new Set(imports)].filter(specifier => !allowedExternal.has(specifier));
    assert.deepEqual(
      unexpected,
      [],
      `${name} has external imports outside Electron/Node: ${unexpected.join(", ")}`
    );
  }
}

export function assertPackagedAsar(asarPath) {
  const expectedEntries = new Set([
    ...expectedPackageFiles,
    ...expectedPackageDirectories
  ]);
  const entries = listPackage(asarPath).map(packageEntryPath).sort();
  assert.deepEqual(
    entries,
    [...expectedEntries].sort(),
    "Packaged ASAR entries differ from the self-contained Desktop package contract."
  );

  for (const entry of entries) {
    const fileInfo = statFile(asarPath, entry, false);
    assert.equal(
      "link" in fileInfo,
      false,
      `Packaged ASAR entry is a symlink: ${entry}`
    );
    if (expectedPackageFiles.has(entry)) {
      assert.equal(
        "files" in fileInfo,
        false,
        `Expected an ASAR file but found a directory: ${entry}`
      );
    } else {
      assert.equal(
        "files" in fileInfo,
        true,
        `Expected an ASAR directory but found a file: ${entry}`
      );
    }
  }

  const bundles = [
    {
      path: "dist/main/main.js",
      allowedExternal: new Set(["electron", ...nodeBuiltins])
    },
    {
      path: "dist/preload/index.cjs",
      allowedExternal: new Set(["electron", ...nodeBuiltins])
    },
    {
      path: "dist/preload/overlay.cjs",
      allowedExternal: new Set(["electron", ...nodeBuiltins])
    },
    {
      path: "dist/renderer/main.js",
      allowedExternal: new Set()
    },
    {
      path: "dist/renderer/overlay.js",
      allowedExternal: new Set()
    }
  ];
  for (const bundle of bundles) {
    const source = extractFile(asarPath, bundle.path).toString("utf8");
    assertBundleImports(source, bundle.path, bundle.allowedExternal);
  }

  const main = extractFile(asarPath, "dist/main/main.js").toString("utf8");
  assert.match(main, /preload\/index\.cjs/);
  assert.match(main, /preload\/overlay\.cjs/);
  return entries;
}

async function main() {
  const asarPath = process.argv[2];
  if (!asarPath) {
    throw new Error("Usage: node scripts/assert-package.mjs <path-to-app.asar>");
  }
  assertPackagedAsar(resolve(asarPath));
  console.log(`Validated self-contained Desktop ASAR: ${asarPath}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
