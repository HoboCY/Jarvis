import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const root = process.argv[2] ?? "src";
const sourceRoot = join(process.cwd(), root);
const forbidden = [
  /nodeIntegration\s*:\s*true/,
  /contextIsolation\s*:\s*false/,
  /(?:require|import)\s*\(?\s*["'](?:node:)?(?:fs|child_process)["']/,
  /sk-[A-Za-z0-9]{16,}/
];

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await sourceFiles(path));
    } else if (/\.(?:ts|tsx)$/.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

const files = await sourceFiles(sourceRoot);
const errors = [];
for (const file of files) {
  const content = await readFile(file, "utf8");
  for (const pattern of forbidden) {
    if (pattern.test(content)) {
      errors.push(`${relative(process.cwd(), file)} matches ${pattern}`);
    }
  }
}

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exit(1);
}

console.log(`lint-ts: checked ${files.length} TypeScript files`);
