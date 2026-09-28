import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { validateEvidenceBundle } from "./evidence.mjs";

export async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1 || argv[0].startsWith("-")) {
    throw safeError("INVALID_EVIDENCE_ARGUMENTS", "Exactly one evidence bundle path is required.");
  }
  const result = await validateEvidenceBundle(resolve(argv[0]));
  const output = { schemaVersion: 1, status: result.status, runId: result.runId };
  process.stdout.write(`${JSON.stringify(output)}\n`);
  return 0;
}

function safeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] !== undefined && resolve(process.argv[1]) === currentFile) {
  try {
    process.exitCode = await main();
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      schemaVersion: 1,
      status: "FAIL",
      errorCategory: error.code ?? "INVALID_EVIDENCE"
    })}\n`);
    process.exitCode = 1;
  }
}
