import { strict as assert } from "node:assert";
import { resolve } from "node:path";
import { test } from "node:test";
import { scanPaths } from "./check-secrets.mjs";

const root = resolve(new URL("../..", import.meta.url).pathname);
const fixtureDirectory = resolve(root, "eng/scripts/fixtures/secret-scan");

test("secret scan detects modern project keys while accepting redacted examples", async () => {
  const findings = await scanPaths([fixtureDirectory], root);

  assert.deepEqual(findings, [{
    file: "eng/scripts/fixtures/secret-scan/renderer-modern-key.js",
    matches: ["OpenAI project key"]
  }]);
});
