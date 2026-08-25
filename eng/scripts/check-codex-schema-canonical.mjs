import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { checkCanonicalJsonDirectory } from "./codex-schema-json.mjs";

const root = resolve(new URL("../..", import.meta.url).pathname);
const defaultSchemaRoot = resolve(root, "artifacts/codex-schema/0.146.0");

export async function checkCanonicalDirectory(directory) {
  return checkCanonicalJsonDirectory(directory);
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] !== undefined && resolve(process.argv[1]) === currentFile) {
  const schemaRoot = resolve(process.argv[2] ?? defaultSchemaRoot);
  const files = await checkCanonicalDirectory(schemaRoot);
  if (files.length !== 275) {
    throw new Error(`Expected 275 Codex schema JSON files, found ${files.length}.`);
  }

  console.log(`Codex schema canonical check passed for ${files.length} JSON file(s).`);
}
