import { fileURLToPath } from "node:url";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const root = resolve(new URL("../..", import.meta.url).pathname);
const ignoredDirectories = new Set([".git", "node_modules", "bin", "obj", "coverage"]);
const sourceFilePattern = /\.(?:cjs|cs|csproj|js|json|mjs|ts|tsx|yml|yaml)$/;

export const secretPatterns = [
  { name: "OpenAI project key", pattern: /\bsk-proj-[A-Za-z0-9_-]{20,}\b/g },
  { name: "OpenAI service key", pattern: /\bsk-(?:admin|service|svcacct)-[A-Za-z0-9_-]{20,}\b/g },
  { name: "OpenAI legacy key", pattern: /\bsk-[A-Za-z0-9]{20,}\b/g },
  { name: "OpenAI API key assignment", pattern: /OPENAI_API_KEY\s*[:=]\s*["'][^"']+["']/g }
];

export async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) {
      continue;
    }

    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await filesUnder(path));
    } else if (sourceFilePattern.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

async function filesAtPath(path) {
  const metadata = await stat(path);
  return metadata.isDirectory() ? filesUnder(path) : [path];
}

export function findSecretMatches(content) {
  const matches = [];
  for (const { name, pattern } of secretPatterns) {
    if (pattern.test(content)) {
      matches.push(name);
    }
    pattern.lastIndex = 0;
  }
  return matches;
}

export async function scanPaths(paths, projectRoot = root) {
  const files = [];
  for (const path of paths) {
    files.push(...await filesAtPath(path));
  }

  const findings = [];
  for (const file of files) {
    const matches = findSecretMatches(await readFile(file, "utf8"));
    if (matches.length > 0) {
      findings.push({ file: relative(projectRoot, file), matches });
    }
  }
  return findings;
}

export async function runSecretScan() {
  const findings = await scanPaths([
    resolve(root, "src"),
    resolve(root, "packages")
  ]);

  if (findings.length > 0) {
    const details = findings.map(({ file, matches }) => `${file} (${matches.join(", ")})`);
    throw new Error(`Potential secret found in: ${details.join(", ")}`);
  }

  console.log("Secret scan passed for source, package, and renderer build files.");
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] !== undefined && resolve(process.argv[1]) === currentFile) {
  await runSecretScan();
}
