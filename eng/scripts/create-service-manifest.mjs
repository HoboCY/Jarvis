import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeReleaseManifest } from "./release-manifest.mjs";

const defaultRepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export function getServiceBundleArtifacts(artifactRoot) {
  return [
    {
      kind: "jarvis-api-darwin-arm64-bundle",
      path: resolve(artifactRoot, "Jarvis.Api-darwin-arm64.tar.gz")
    },
    {
      kind: "jarvis-device-node-darwin-arm64-bundle",
      path: resolve(artifactRoot, "Jarvis.DeviceNode-darwin-arm64.tar.gz")
    }
  ];
}

export async function createServiceManifest(repoRoot = defaultRepoRoot) {
  const artifactRoot = resolve(repoRoot, "artifacts/services");
  const packageJson = JSON.parse(await readFile(resolve(repoRoot, "package.json"), "utf8"));
  const desktopPackageJson = JSON.parse(await readFile(
    resolve(repoRoot, "src/clients/desktop/package.json"),
    "utf8"));
  const manifestPath = resolve(repoRoot, "artifacts/releases/services-version-manifest.json");
  await mkdir(dirname(manifestPath), { recursive: true });
  return writeReleaseManifest(manifestPath, {
    version: process.env.JARVIS_RELEASE_VERSION
      ?? packageJson.version
      ?? desktopPackageJson.version
      ?? "0.0.0",
    platform: "darwin",
    arch: "arm64",
    signatureStatus: "unsigned-test",
    notarizationStatus: "not-run",
    artifacts: getServiceBundleArtifacts(artifactRoot)
  });
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = await createServiceManifest();
  console.log(JSON.stringify(manifest, null, 2));
}
