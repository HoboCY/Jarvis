import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { assertBundleImports } from "./assert-package.mjs";
import { resolveRendererDependencies } from "./renderer-dependencies.mjs";

const desktopRoot = new URL("../", import.meta.url);
const distRoot = new URL("../dist/", import.meta.url);

const expectedFiles = new Set([
  "assets/JarvisTemplate.png",
  "assets/JarvisTemplate@2x.png",
  "main/main.js",
  "preload/index.cjs",
  "preload/overlay.cjs",
  "renderer/index.html",
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

test("desktop build metadata removes unused API client and pins esbuild", async () => {
  const packageJson = JSON.parse(await readFile(new URL("package.json", desktopRoot), "utf8"));
  assert.equal(packageJson.dependencies?.["@jarvis/api-client-ts"], undefined);
  assert.equal(packageJson.devDependencies?.esbuild, "0.25.0");
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
