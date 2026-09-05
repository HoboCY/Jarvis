import { lstat, readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const desktopRoot = resolve(repositoryRoot, "src/clients/desktop");
const requiredSandboxBasename = "chrome-sandbox";
const requiredElectronVersion = "44.0.0";

function fail(message) {
  throw new Error(message);
}

function isWithin(root, candidate) {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

async function resolveDirectory(path, errorMessage) {
  try {
    return await realpath(path);
  } catch {
    fail(errorMessage);
  }
}

async function resolveFile(path, errorMessage) {
  try {
    return await realpath(path);
  } catch {
    fail(errorMessage);
  }
}

/**
 * Validate a candidate derived from an Electron binary. This seam only reads
 * metadata; it never changes ownership, mode, or any other file state.
 */
export async function validateSandboxTarget({
  workspaceRoot,
  electronInstallRoot,
  electronBinaryPath,
  sandboxPath
}) {
  if (![workspaceRoot, electronInstallRoot, electronBinaryPath, sandboxPath]
    .every(path => typeof path === "string" && path.length > 0)) {
    fail("Electron sandbox target input is invalid.");
  }

  const workspace = await resolveDirectory(workspaceRoot, "Electron workspace is unavailable.");
  const install = await resolveDirectory(
    electronInstallRoot,
    "Electron installation directory is unavailable.");
  const binary = await resolveFile(electronBinaryPath, "Electron binary is unavailable.");
  let binaryMetadata;
  try {
    binaryMetadata = await lstat(binary);
  } catch {
    fail("Electron binary is unavailable.");
  }
  if (!binaryMetadata.isFile() || binaryMetadata.isSymbolicLink()) {
    fail("Installed Electron binary must be a regular file.");
  }
  const candidateInput = resolve(sandboxPath);
  const candidateParent = await resolveDirectory(
    dirname(candidateInput),
    "Electron sandbox directory is unavailable.");
  const candidate = join(candidateParent, basename(candidateInput));

  if (!isWithin(workspace, install) || !isWithin(install, binary)) {
    fail("Electron sandbox target is outside the current workspace Electron installation.");
  }
  if (basename(candidate) !== requiredSandboxBasename) {
    fail("Electron sandbox target basename must be chrome-sandbox.");
  }

  const expected = join(dirname(binary), requiredSandboxBasename);
  if (candidate !== expected || !isWithin(install, candidate)) {
    fail("Electron sandbox target is outside the Electron installation directory.");
  }

  let metadata;
  try {
    metadata = await lstat(candidate);
  } catch {
    fail("Electron chrome-sandbox file is missing.");
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    fail("Electron chrome-sandbox must be a regular file, not a symlink or special file.");
  }

  return { electronBinary: binary, sandboxPath: candidate };
}

/**
 * Read the target metadata without following a substituted target path.
 */
export async function inspectSandboxFile(path) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch {
    fail("Electron chrome-sandbox file is missing.");
  }
  return {
    isRegularFile: metadata.isFile() && !metadata.isSymbolicLink(),
    isSymbolicLink: metadata.isSymbolicLink(),
    isDirectory: metadata.isDirectory(),
    isFIFO: metadata.isFIFO(),
    uid: metadata.uid,
    gid: metadata.gid,
    mode: metadata.mode & 0o7777
  };
}

export function assertSandboxAttributes({ uid, gid, mode }) {
  if (uid !== 0 || gid !== 0) {
    fail("Electron chrome-sandbox must have root ownership.");
  }
  if (mode !== 0o4755) {
    fail("Electron chrome-sandbox must have mode 4755.");
  }
  return true;
}

/**
 * Errors from this preparation path are deliberately generic and bounded.
 * The underlying message may contain an untrusted path or secret-shaped text.
 */
export function sanitizeSandboxError() {
  return "Electron sandbox preparation failed.";
}

/**
 * Resolve the Electron npm package's public executable contract:
 * `path.txt` is stored at the package root, while its relative value is
 * resolved below the package's `dist` directory (for example, `electron` on
 * Linux or `Electron.app/Contents/MacOS/Electron` on macOS).
 *
 * The returned sandbox path is always derived from the canonical binary
 * directory, never from caller-provided target text.
 */
export async function resolveSandboxTargetFromInstall({
  workspaceRoot,
  electronInstallRoot
}) {
  if (![workspaceRoot, electronInstallRoot]
    .every(path => typeof path === "string" && path.length > 0)) {
    fail("Electron sandbox target input is invalid.");
  }

  const workspace = await resolveDirectory(workspaceRoot, "Electron workspace is unavailable.");
  const install = await resolveDirectory(
    electronInstallRoot,
    "Electron installation directory is unavailable.");

  let packageJson;
  try {
    packageJson = JSON.parse(await readFile(join(install, "package.json"), "utf8"));
  } catch {
    fail("Electron package metadata is unavailable.");
  }
  if (packageJson?.version !== requiredElectronVersion) {
    fail("Installed Electron version is not the pinned project version.");
  }

  const dist = await resolveDirectory(
    join(install, "dist"),
    "Electron distribution directory is unavailable.");
  const pathMetadata = join(install, "path.txt");
  let pathMetadataFile;
  try {
    pathMetadataFile = await lstat(pathMetadata);
  } catch {
    fail("Installed Electron binary metadata is unavailable.");
  }
  if (!pathMetadataFile.isFile() || pathMetadataFile.isSymbolicLink()) {
    fail("Installed Electron binary metadata must be a regular file.");
  }

  let binaryRelativePath;
  try {
    binaryRelativePath = (await readFile(pathMetadata, "utf8")).trim();
  } catch {
    fail("Installed Electron binary metadata is unavailable.");
  }
  if (!binaryRelativePath || isAbsolute(binaryRelativePath)) {
    fail("Installed Electron binary metadata is invalid.");
  }

  const binaryInput = resolve(dist, binaryRelativePath);
  if (!isWithin(dist, binaryInput)) {
    fail("Installed Electron binary metadata is invalid.");
  }
  const binary = await resolveFile(binaryInput, "Electron binary is unavailable.");
  if (!isWithin(dist, binary)) {
    fail("Installed Electron binary is outside the Electron distribution directory.");
  }

  return validateSandboxTarget({
    workspaceRoot: workspace,
    electronInstallRoot: install,
    electronBinaryPath: binary,
    sandboxPath: join(dirname(binary), requiredSandboxBasename)
  });
}

export async function resolveElectronSandboxTarget() {
  const workspace = await resolveDirectory(repositoryRoot, "Electron workspace is unavailable.");
  const desktop = await resolveDirectory(desktopRoot, "Desktop package is unavailable.");
  const desktopRequire = createRequire(join(desktop, "package.json"));

  let packagePath;
  try {
    packagePath = desktopRequire.resolve("electron/package.json");
  } catch {
    fail("Installed Electron dependency is unavailable.");
  }
  const install = dirname(await resolveFile(packagePath, "Electron package is unavailable."));
  return resolveSandboxTargetFromInstall({
    workspaceRoot: workspace,
    electronInstallRoot: install
  });
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
const modulePath = resolve(fileURLToPath(import.meta.url));
if (invokedPath === modulePath) {
  try {
    if (process.argv.length !== 3 || process.argv[2] !== "--resolve") {
      throw new Error("Unexpected Electron sandbox arguments.");
    }
    if (process.platform !== "linux") {
      throw new Error("Linux Electron sandbox target resolution is unavailable on this platform.");
    }
    const target = await resolveElectronSandboxTarget();
    process.stdout.write(`${target.sandboxPath}\n`);
  } catch {
    console.error(sanitizeSandboxError());
    process.exitCode = 1;
  }
}
