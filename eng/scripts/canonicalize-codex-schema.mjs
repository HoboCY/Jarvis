import { resolve } from "node:path";
import { canonicalizeJsonDirectory } from "./codex-schema-json.mjs";

const root = resolve(new URL("../..", import.meta.url).pathname);
const defaultSchemaRoot = resolve(root, "artifacts/codex-schema/0.146.0");
const schemaRoot = resolve(process.argv[2] ?? defaultSchemaRoot);
const { files, changed } = await canonicalizeJsonDirectory(schemaRoot);

console.log(`Canonicalized ${files.length} Codex schema JSON file(s); ${changed} file(s) changed.`);
