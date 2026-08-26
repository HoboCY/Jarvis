import { readFileSync } from "node:fs";

const [, , scenarioPath, trxPath] = process.argv;
if (!scenarioPath || !trxPath) {
  throw new Error("usage: node verify-scenarios.mjs <scenarios.json> <results.trx>");
}

const scenarios = JSON.parse(readFileSync(scenarioPath, "utf8"));
if (!Array.isArray(scenarios) || scenarios.length !== 8) {
  throw new Error(`Phase 6 requires exactly 8 named scenarios; found ${scenarios?.length ?? 0}.`);
}

const xml = readFileSync(trxPath, "utf8");
const executed = new Set(
  [...xml.matchAll(/testName="([^"]+)"/g)].map((match) => match[1]),
);
const missing = scenarios
  .map((scenario) => scenario.testName)
  .filter((testName) => ![...executed].some(
    (executedName) => executedName === testName || executedName.endsWith(`.${testName}`),
  ));
if (missing.length > 0) {
  throw new Error(`Named E2E scenarios were not executed: ${missing.join(", ")}`);
}

console.log(`Verified ${scenarios.length} named Phase 6 E2E scenarios executed in ${trxPath}.`);
