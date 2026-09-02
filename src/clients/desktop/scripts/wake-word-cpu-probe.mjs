import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCpuProbe } from "./wake-word-acceptance.mjs";

function parseInteger(value, argument, minimum, maximum) {
  if (!value || !/^\d+$/.test(value)) {
    throw new Error(`${argument} must be an integer between ${minimum} and ${maximum}.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${argument} must be an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function parseArguments(arguments_) {
  const options = {};
  for (let index = 0; index < arguments_.length; index++) {
    const argument = arguments_[index];
    if (argument === "--") {
      continue;
    } else if (argument === "--fixture") {
      const value = arguments_[++index];
      if (!value || value.startsWith("-")) {
        throw new Error("--fixture requires a fixture name.");
      }
      options.fixtureName = value;
    } else if (argument === "--runtime-root"
      || argument === "--model-root" || argument === "--fixtures-root") {
      const value = arguments_[++index];
      if (!value || value.startsWith("-")) {
        throw new Error(`${argument} requires a directory path.`);
      }
      if (argument === "--runtime-root") {
        options.runtimeRoot = value;
      } else if (argument === "--model-root") {
        options.modelRoot = value;
      } else {
        options.fixturesRoot = value;
      }
    } else if (argument === "--iterations") {
      options.iterations = parseInteger(arguments_[++index], "iterations", 1, 10);
    } else if (argument === "--warmup-iterations") {
      options.warmupIterations = parseInteger(
        arguments_[++index], "warmup-iterations", 0, 3);
    } else {
      throw new Error(
        "Unknown CPU probe argument. Use --fixture, --runtime-root, --model-root, "
          + "--fixtures-root, --iterations, or --warmup-iterations.");
    }
  }
  return options;
}

function boundedError(reason) {
  const message = reason instanceof Error ? reason.message : String(reason);
  return message.replace(/(?:[A-Za-z]:)?\/(?:[^/\s'"`]+\/)+[^/\s'"`]*/g, "<redacted path>")
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, 240) || "Wake-word CPU probe failed.";
}

async function main() {
  const report = await runCpuProbe(parseArguments(process.argv.slice(2)));
  console.log(JSON.stringify(report));
  return report.status === "passed" ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(boundedError(error));
    process.exitCode = 2;
  }
}

export { parseArguments, runCpuProbe };
