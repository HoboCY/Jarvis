import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeReleaseManifest } from "./release-manifest.mjs";

function parse(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (!option?.startsWith("--") || argv[index + 1] === undefined) {
      throw new Error(`Invalid manifest argument: ${option ?? "<missing>"}`);
    }
    values[option.slice(2)] = argv[++index];
  }
  return values;
}

export async function run(argv = process.argv.slice(2)) {
  const values = parse(argv);
  const output = resolve(required(values, "output"));
  await mkdir(dirname(output), { recursive: true });
  const manifest = await writeReleaseManifest(output, {
    version: required(values, "version"),
    platform: values.platform ?? "darwin",
    arch: values.arch ?? "arm64",
    signatureStatus: values.signature ?? "unsigned-test",
    notarizationStatus: values.notarization ?? "not-run",
    artifacts: [{ kind: values.kind ?? "test-package", path: resolve(required(values, "artifact")) }]
  });
  console.log(JSON.stringify(manifest, null, 2));
}

function required(values, name) {
  if (typeof values[name] !== "string" || values[name].length === 0) {
    throw new Error(`--${name} is required.`);
  }
  return values[name];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run().catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
