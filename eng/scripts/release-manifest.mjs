import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function sha256File(path) {
  const hash = createHash("sha256");
  hash.update(await readFile(path));
  return hash.digest("hex");
}

export async function buildReleaseManifest({
  version,
  platform,
  arch,
  artifacts,
  signatureStatus = "unsigned-test",
  notarizationStatus = "not-run"
}) {
  if (!version || !platform || !arch || !Array.isArray(artifacts) || artifacts.length === 0) {
    throw new Error("Release manifest requires version, platform, arch, and artifacts.");
  }
  if (!["unsigned-test", "signed", "unknown"].includes(signatureStatus)
    || !["not-run", "notarized", "failed", "unknown"].includes(notarizationStatus)) {
    throw new Error("Release manifest signature/notarization status is invalid.");
  }
  return {
    schemaVersion: 1,
    version,
    platform,
    arch,
    signatureStatus,
    notarizationStatus,
    generatedAt: new Date().toISOString(),
    artifacts: await Promise.all(artifacts.map(async artifact => ({
      kind: artifact.kind,
      path: artifact.path,
      sizeBytes: (await stat(artifact.path)).size,
      sha256: await sha256File(artifact.path)
    })))
  };
}

export async function writeReleaseManifest(path, input) {
  const manifest = await buildReleaseManifest(input);
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return manifest;
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] !== undefined && resolve(process.argv[1]) === currentFile) {
  console.error("release-manifest.mjs is imported by publish scripts and is not a standalone command.");
  process.exitCode = 2;
}
