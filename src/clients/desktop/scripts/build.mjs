import { mkdir, copyFile, rm } from "node:fs/promises";
import { builtinModules } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { assertBuildMetafiles } from "./assert-package.mjs";
import { resolveRendererDependencies } from "./renderer-dependencies.mjs";

const scriptsRoot = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptsRoot, "..");
const sourceRoot = join(desktopRoot, "src");
const distRoot = join(desktopRoot, "dist");
const repositoryRoot = resolve(desktopRoot, "../../..");

const nodeBuiltins = [
  ...new Set([
    ...builtinModules,
    ...builtinModules.map(name => `node:${name}`)
  ])
];

const rendererDependencies = resolveRendererDependencies(desktopRoot);

const rendererDependencyPlugin = {
  name: "jarvis-renderer-dependencies",
  setup(esbuild) {
    esbuild.onResolve({ filter: /^(?:react|react\/jsx-runtime|react-dom\/client)$/ }, args => {
      const target = rendererDependencies.get(args.path);
      return target ? { path: target } : undefined;
    });
  }
};

const workspaceSourcePlugin = {
  name: "jarvis-workspace-sources",
  setup(esbuild) {
    const sources = new Map([
      ["@jarvis/contracts-ts", join(repositoryRoot, "packages/contracts-ts/src/index.ts")],
      ["@jarvis/realtime-agent", join(repositoryRoot, "packages/realtime-agent/src/index.ts")]
    ]);
    esbuild.onResolve({ filter: /^@jarvis\/(contracts-ts|realtime-agent)$/ }, args => {
      const source = sources.get(args.path);
      return source ? { path: source } : undefined;
    });
  }
};

const commonOptions = {
  absWorkingDir: repositoryRoot,
  bundle: true,
  jsx: "automatic",
  logLevel: "info",
  metafile: true,
  minify: false,
  sourcemap: false,
  target: "es2022"
};

await rm(distRoot, { force: true, recursive: true });
await mkdir(distRoot, { recursive: true });

const buildResults = await Promise.all([
  build({
    ...commonOptions,
    // Electron 44's main process already provides fetch and WebSocket. Force
    // SignalR onto that self-contained path so its Node-only dynamic requires
    // (ws/eventsource/cookie jars) are not executed from this ESM bundle.
    define: {
      "process.release.name": '"electron"'
    },
    entryPoints: [join(sourceRoot, "main/main.ts")],
    external: ["electron", ...nodeBuiltins],
    format: "esm",
    outfile: join(distRoot, "main/main.js"),
    platform: "node",
    plugins: [workspaceSourcePlugin]
  }),
  build({
    ...commonOptions,
    entryPoints: [join(sourceRoot, "preload/index.ts")],
    external: ["electron", ...nodeBuiltins],
    format: "cjs",
    outfile: join(distRoot, "preload/index.cjs"),
    platform: "node",
    plugins: [workspaceSourcePlugin]
  }),
  build({
    ...commonOptions,
    entryPoints: [join(sourceRoot, "preload/overlay.ts")],
    external: ["electron", ...nodeBuiltins],
    format: "cjs",
    outfile: join(distRoot, "preload/overlay.cjs"),
    platform: "node",
    plugins: [workspaceSourcePlugin]
  }),
  build({
    ...commonOptions,
    conditions: ["browser", "import", "default"],
    entryPoints: [join(sourceRoot, "renderer/main.tsx")],
    format: "esm",
    outfile: join(distRoot, "renderer/main.js"),
    platform: "browser",
    plugins: [workspaceSourcePlugin, rendererDependencyPlugin]
  }),
  build({
    ...commonOptions,
    conditions: ["browser", "import", "default"],
    entryPoints: [join(sourceRoot, "renderer/overlay.ts")],
    format: "esm",
    outfile: join(distRoot, "renderer/overlay.js"),
    platform: "browser",
    plugins: [workspaceSourcePlugin]
  })
]);

assertBuildMetafiles([
  {
    name: "main",
    result: buildResults[0],
    allowedExternal: new Set(["electron", ...nodeBuiltins])
  },
  {
    name: "preload/index",
    result: buildResults[1],
    allowedExternal: new Set(["electron", ...nodeBuiltins])
  },
  {
    name: "preload/overlay",
    result: buildResults[2],
    allowedExternal: new Set(["electron", ...nodeBuiltins])
  },
  {
    name: "renderer/main",
    result: buildResults[3],
    allowedExternal: new Set()
  },
  {
    name: "renderer/overlay",
    result: buildResults[4],
    allowedExternal: new Set()
  }
]);

await mkdir(join(distRoot, "assets"), { recursive: true });
await mkdir(join(distRoot, "renderer"), { recursive: true });
await Promise.all([
  copyFile(join(sourceRoot, "assets/JarvisTemplate.png"), join(distRoot, "assets/JarvisTemplate.png")),
  copyFile(join(sourceRoot, "assets/JarvisTemplate@2x.png"), join(distRoot, "assets/JarvisTemplate@2x.png")),
  copyFile(join(sourceRoot, "assets/porcupine_params.pv"), join(distRoot, "assets/porcupine_params.pv")),
  copyFile(join(sourceRoot, "renderer/index.html"), join(distRoot, "renderer/index.html")),
  copyFile(join(sourceRoot, "renderer/overlay.html"), join(distRoot, "renderer/overlay.html"))
]);

console.log("Built bundled Desktop main, preload, renderer, HTML, and tray assets.");
