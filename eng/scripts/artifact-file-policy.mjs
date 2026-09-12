import { fileURLToPath } from "node:url";

const runtimeCredentialNames = new Set([
  "appsettings.secrets.json",
  "appsettings.production.json",
  "secrets.json",
  "auth.json"
]);

export function assertArtifactEntryAllowed(name) {
  if (name.replaceAll("\\", "/").split("/")
    .some(segment => runtimeCredentialNames.has(segment.toLowerCase()))) {
    throw new Error("RUNTIME_CREDENTIAL_ARTIFACT_REJECTED");
  }
}

export function runtimeCredentialRsyncExcludes() {
  return [...runtimeCredentialNames].map(name => name.replace(/[a-z]/g,
    letter => `[${letter}${letter.toUpperCase()}]`));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3 || process.argv[2] !== "--rsync-excludes") {
    process.stderr.write("INVALID_ARTIFACT_POLICY_COMMAND\n");
    process.exitCode = 2;
  } else {
    process.stdout.write(`${runtimeCredentialRsyncExcludes().join("\n")}\n`);
  }
}
