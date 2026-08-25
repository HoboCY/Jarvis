import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(new URL("../..", import.meta.url).pathname);
const generatedFiles = [
  "artifacts/openapi/openapi.json",
  "packages/contracts-ts/src/generated/openapi.ts"
].map((relativePath) => resolve(root, relativePath));

async function readRequiredFiles(stage) {
  const snapshots = new Map();
  for (const file of generatedFiles) {
    try {
      snapshots.set(file, await readFile(file));
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new Error(`Required OpenAPI generated file is missing ${stage}: ${file}`);
      }
      throw error;
    }
  }
  return snapshots;
}

const before = await readRequiredFiles("before generation");
const generator = spawn(process.execPath, [resolve(root, "eng/scripts/generate-openapi.mjs")], {
  cwd: root,
  stdio: "inherit"
});
const [exitCode] = await once(generator, "close");
if (exitCode !== 0) {
  process.exit(exitCode ?? 1);
}

const after = await readRequiredFiles("after generation");
for (const file of generatedFiles) {
  if (!before.get(file).equals(after.get(file))) {
    throw new Error(`Generated OpenAPI file changed during regeneration: ${file}`);
  }
}

console.log("OpenAPI generated files are unchanged byte-for-byte.");
