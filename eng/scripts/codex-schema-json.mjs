import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

function compareObjectKeys(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function canonicalizeJson(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalizeJson);
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort(compareObjectKeys)
        .map(key => [key, canonicalizeJson(value[key])])
    );
  }

  return value;
}

export function canonicalJsonText(value) {
  return `${JSON.stringify(canonicalizeJson(value), null, 2)}\n`;
}

export function canonicalizeJsonText(text) {
  return canonicalJsonText(JSON.parse(text));
}

export function isCanonicalJsonText(text) {
  try {
    return text === canonicalizeJsonText(text);
  } catch {
    return false;
  }
}

export async function jsonFiles(directory) {
  const entries = (await readdir(directory, { withFileTypes: true }))
    .sort((left, right) => compareObjectKeys(left.name, right.name));
  const files = [];

  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await jsonFiles(path));
    } else if (entry.name.endsWith(".json")) {
      files.push(path);
    }
  }

  return files;
}

export async function canonicalizeJsonDirectory(directory) {
  const files = await jsonFiles(directory);
  let changed = 0;

  for (const file of files) {
    const original = await readFile(file, "utf8");
    const canonical = canonicalizeJsonText(original);
    if (original !== canonical) {
      await writeFile(file, canonical, "utf8");
      changed += 1;
    }
  }

  return { files, changed };
}

export async function checkCanonicalJsonDirectory(directory) {
  const files = await jsonFiles(directory);

  for (const file of files) {
    const original = await readFile(file, "utf8");
    const canonical = canonicalizeJsonText(original);
    if (original !== canonical) {
      throw new Error(`${file} is not canonical JSON.`);
    }
  }

  return files;
}
