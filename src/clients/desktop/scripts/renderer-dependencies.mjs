import { createRequire } from "node:module";
import { join } from "node:path";

const rendererDependencySpecifiers = [
  "react",
  "react/jsx-runtime",
  "react-dom/client"
];

export function resolveRendererDependencies(desktopRoot) {
  const requireFromDesktop = createRequire(join(desktopRoot, "package.json"));
  return new Map(rendererDependencySpecifiers.map(specifier => [
    specifier,
    requireFromDesktop.resolve(specifier)
  ]));
}
