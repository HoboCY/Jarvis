import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  canonicalJsonText,
  isCanonicalJsonText
} from "./codex-schema-json.mjs";
import { checkCanonicalDirectory } from "./check-codex-schema-canonical.mjs";

test("canonical JSON sorts object keys but preserves array order", () => {
  const nonCanonical = '{\n  "b": 1,\n  "a": [3, 2, 1]\n}\n';
  const canonical = '{\n  "a": [\n    3,\n    2,\n    1\n  ],\n  "b": 1\n}\n';

  assert.equal(isCanonicalJsonText(nonCanonical), false);
  assert.equal(canonicalJsonText(JSON.parse(nonCanonical)), canonical);
  assert.equal(isCanonicalJsonText(canonical), true);
});

test("canonical directory check rejects a non-canonical schema file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jarvis-codex-canonical-"));
  const file = join(directory, "Example.json");

  try {
    await writeFile(file, '{"z":0,"a":1}\n', "utf8");
    await assert.rejects(
      checkCanonicalDirectory(directory),
      /is not canonical/
    );

    await writeFile(file, canonicalJsonText(JSON.parse(await readFile(file, "utf8"))), "utf8");
    await assert.doesNotReject(checkCanonicalDirectory(directory));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
