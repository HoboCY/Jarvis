import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  unlink
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const OWNER_MODE = 0o700;
const OWNER_FILE_MODE = 0o600;
const OWNER_MARKER = ".phase9b-owner.json";
const EXTERNAL_CODEX_OWNER_MARKER = ".phase9b-owned";
const EXTERNAL_CODEX_OWNER_PURPOSE = "isolated-normal-codex-login";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CODEX_HELPER_LINK_PATTERN = /^tmp\/arg0\/codex-arg0[A-Za-z0-9_-]{1,64}\/(?:apply_patch|applypatch|codex-execve-wrapper)$/;

export async function assertSafeTempRoot(
  candidate,
  { repositoryRoot, homeDirectory = homedir(), codexHome = join(homeDirectory, ".codex") } = {}
) {
  const path = requireAbsolutePath(candidate, "UNSAFE_TEMP_ROOT");
  await assertNoSymlinkPath(path);

  const protectedPaths = [repositoryRoot, homeDirectory, codexHome]
    .filter((value) => typeof value === "string")
    .map((value) => resolve(value));
  for (const protectedPath of protectedPaths) {
    if (isWithin(path, protectedPath)) {
      throw safeError("UNSAFE_TEMP_ROOT", "Temporary root is protected.");
    }
  }

  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw safeError("UNSAFE_TEMP_ROOT", "Temporary root is unavailable.");
    }
  }
  if (metadata !== undefined) {
    if (!metadata.isDirectory() || (metadata.mode & 0o077) !== 0) {
      throw safeError("UNSAFE_TEMP_ROOT", "Temporary root must be a private directory.");
    }
  }

  const existingAncestor = await findExistingAncestor(path);
  const existingRealPath = await realpath(existingAncestor);
  for (const protectedPath of protectedPaths) {
    let protectedRealPath;
    try {
      protectedRealPath = await realpath(protectedPath);
    } catch {
      protectedRealPath = protectedPath;
    }
    if (isWithin(existingRealPath, protectedRealPath)) {
      throw safeError("UNSAFE_TEMP_ROOT", "Temporary root is protected.");
    }
  }
  return path;
}

export async function createOwnedTempRoot({
  baseDirectory,
  repositoryRoot,
  homeDirectory = homedir(),
  codexHome = join(homeDirectory, ".codex")
} = {}) {
  // macOS exposes tmpdir() through /var, which is a trusted system alias for
  // /private/var. Canonicalize that default before the strict symlink walk;
  // caller supplied bases still go through the rejection path unchanged.
  const requestedBase = resolve(baseDirectory ?? tmpdir());
  const canonicalRequestedBase = baseDirectory === undefined
    ? await realpath(requestedBase)
    : requestedBase;
  const base = await assertSafeTempRoot(canonicalRequestedBase, { repositoryRoot, homeDirectory, codexHome });
  const canonicalBase = await realpath(base);
  const root = await mkdtemp(join(canonicalBase, "jarvis-phase9b-"));
  try {
    await chmod(root, OWNER_MODE);
    await assertSafeTempRoot(root, { repositoryRoot, homeDirectory, codexHome });
    return root;
  } catch (error) {
    await rm(root, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function createRunIsolation({
  baseDirectory,
  repositoryRoot = process.cwd(),
  homeDirectory = homedir(),
  runId = randomUUID()
} = {}) {
  if (!UUID_PATTERN.test(runId)) {
    throw safeError("INVALID_RUN_ID", "Run id is invalid.");
  }

  const codexHome = join(resolve(homeDirectory), ".codex");
  const effectiveBaseDirectory = baseDirectory === undefined
    ? await realpath(resolve(tmpdir()))
    : baseDirectory;
  const root = await createOwnedTempRoot({
    baseDirectory: effectiveBaseDirectory,
    repositoryRoot,
    homeDirectory,
    codexHome
  });
  try {
    const directories = {
      database: join(root, "database"),
      desktopProfile: join(root, "desktop-profile"),
      codexHome: join(root, "codex-home"),
      allowedRoot: join(root, "allowed-root")
    };
    await Promise.all(Object.values(directories).map(async (directory) => {
      await mkdir(directory, { mode: OWNER_MODE });
      await chmod(directory, OWNER_MODE);
    }));

    const marker = {
      schemaVersion: 1,
      runId,
      pid: process.pid,
      createdAtUtc: new Date().toISOString()
    };
    const markerPath = join(root, OWNER_MARKER);
    const handle = await open(markerPath, "wx", OWNER_FILE_MODE);
    try {
      await handle.writeFile(`${JSON.stringify(marker)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(markerPath, OWNER_FILE_MODE);
    const { host: portHost, port } = await allocateLoopbackPort();
    const localBearer = randomBytes(32).toString("hex");
    const safetyIdentifierSalt = randomBytes(32).toString("hex");
    let cleaned = false;
    const cleanup = async () => {
      if (cleaned) {
        return false;
      }
      await assertOwnedRoot(root, runId, effectiveBaseDirectory, repositoryRoot, homeDirectory, codexHome);
      await removeOwnedTree(root);
      cleaned = true;
      return true;
    };
    const result = {
      root,
      runId,
      port,
      portHost,
      directories,
      cleanup
    };
    Object.defineProperties(result, {
      localBearer: { value: localBearer, enumerable: false },
      safetyIdentifierSalt: { value: safetyIdentifierSalt, enumerable: false },
      repositoryRoot: { value: resolve(repositoryRoot ?? process.cwd()), enumerable: false },
      homeDirectory: { value: resolve(homeDirectory), enumerable: false },
      baseDirectory: { value: effectiveBaseDirectory, enumerable: false },
      runtimeEnvironment: {
        value: {
          ASPNETCORE_URLS: `http://${portHost}:${port}`,
          Authentication__BearerToken: localBearer,
          OpenAI__SafetyIdentifierSalt: safetyIdentifierSalt,
          ConnectionStrings__Jarvis: `Data Source=${join(directories.database, "jarvis.db")}`,
          CODEX_HOME: directories.codexHome,
          JARVIS_DESKTOP_PROFILE: directories.desktopProfile,
          JARVIS_ALLOWED_ROOT: directories.allowedRoot
        },
        enumerable: false
      }
    });
    return result;
  } catch (error) {
    await rm(root, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function allocateLoopbackPort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(safeError("PORT_ALLOCATION_FAILED", "Loopback port allocation failed.", error));
    };
    const onListening = () => {
      server.off("error", onError);
      resolvePromise();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host: "127.0.0.1", port: 0 });
  });
  const address = server.address();
  await new Promise((resolvePromise) => server.close(resolvePromise));
  if (address === null || typeof address === "string") {
    throw safeError("PORT_ALLOCATION_FAILED", "Loopback port allocation failed.");
  }
  return { host: "127.0.0.1", port: address.port };
}

/**
 * Persist short-lived production configuration under an already-owned run
 * root. The caller keeps the object in trusted memory; this helper only
 * writes a private 0600 JSON file and never returns its contents.
 */
export async function writePrivateJson(root, relativePath, value) {
  await assertPrivateRunRoot(root);
  const safePath = validatePrivateRelativePath(relativePath);
  const target = join(root, safePath);
  const parent = dirname(target);
  await ensurePrivateDirectory(parent, root);
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw safeError("PRIVATE_FILE_INTEGRITY", "Private value is not serializable.");
  }
  if (serialized === undefined) {
    throw safeError("PRIVATE_FILE_INTEGRITY", "Private value is not serializable.");
  }
  const text = `${serialized}\n`;
  const existing = await lstat(target).catch(() => null);
  if (existing?.isSymbolicLink() || existing !== null && !existing.isFile()) {
    throw safeError("UNSAFE_PRIVATE_PATH", "Private path contains a symbolic link.");
  }
  const temporaryPath = join(parent, `.${safePath.split("/").at(-1)}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporaryPath, "wx", OWNER_FILE_MODE);
    await handle.writeFile(text, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporaryPath, OWNER_FILE_MODE);
    await rename(temporaryPath, target);
    await chmod(target, OWNER_FILE_MODE);
    await fsyncDirectory(parent);
    const readback = await readFile(target, "utf8");
    if (readback !== text) {
      throw safeError("PRIVATE_FILE_INTEGRITY", "Private file readback failed.");
    }
  } catch (error) {
    if (handle !== undefined) {
      await handle.close().catch(() => {});
    }
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
  return target;
}

/**
 * Move a separately prepared, owner-only Codex home into this run's empty
 * home. The move is intentionally atomic and refuses populated destinations;
 * credentials are never opened or returned by this helper.
 */
export async function adoptExternalCodexHome(source, isolation, { allowedBinaryPath } = {}) {
  if (typeof source !== "string" || !isAbsolute(source) || isolation === null || typeof isolation !== "object") {
    throw safeError("UNSAFE_CODEX_HOME", "Codex home is invalid.");
  }
  const sourcePath = resolve(source);
  const destination = isolation.directories?.codexHome;
  if (typeof destination !== "string" || !isAbsolute(destination)) {
    throw safeError("UNSAFE_CODEX_HOME", "Codex home destination is invalid.");
  }
  const repositoryRoot = typeof isolation.repositoryRoot === "string"
    ? isolation.repositoryRoot
    : process.cwd();
  const homeDirectory = typeof isolation.homeDirectory === "string"
    ? isolation.homeDirectory
    : homedir();
  const codexHome = join(resolve(homeDirectory), ".codex");
  await assertSafeTempRoot(sourcePath, { repositoryRoot, homeDirectory, codexHome });
  const sourceMetadata = await lstat(sourcePath).catch(() => null);
  if (sourceMetadata === null || sourceMetadata.isSymbolicLink() || !sourceMetadata.isDirectory()
      || (sourceMetadata.mode & 0o077) !== 0) {
    throw safeError("UNSAFE_CODEX_HOME", "Codex home must be a private directory.");
  }
  await assertExternalCodexHomeOwner(sourcePath, sourceMetadata);
  await assertSafeCodexHomeTree(sourcePath, allowedBinaryPath);
  const destinationMetadata = await lstat(destination).catch(() => null);
  if (destinationMetadata === null || destinationMetadata.isSymbolicLink() || !destinationMetadata.isDirectory()
      || (destinationMetadata.mode & 0o777) !== OWNER_MODE) {
    throw safeError("UNSAFE_CODEX_HOME", "Codex home destination is invalid.");
  }
  if ((await readdir(destination)).length !== 0) {
    throw safeError("UNSAFE_CODEX_HOME", "Codex home destination is not empty.");
  }
  try {
    await rename(sourcePath, destination);
    await chmod(destination, OWNER_MODE);
    await assertSafeCodexHomeTree(destination, allowedBinaryPath);
  } catch (error) {
    throw safeError("CODEX_HOME_ADOPTION_FAILED", "Codex home adoption failed.", error);
  }
  return destination;
}

async function assertExternalCodexHomeOwner(path, sourceMetadata) {
  const uid = process.getuid?.();
  if (!Number.isInteger(uid) || sourceMetadata.uid !== uid) {
    throw safeError("UNSAFE_CODEX_HOME", "Codex home ownership is invalid.");
  }
  const markerPath = join(path, EXTERNAL_CODEX_OWNER_MARKER);
  const markerMetadata = await lstat(markerPath).catch(() => null);
  if (markerMetadata === null || markerMetadata.isSymbolicLink() || !markerMetadata.isFile()
      || (markerMetadata.mode & 0o777) !== OWNER_FILE_MODE || markerMetadata.uid !== uid
      || markerMetadata.size > 4 * 1024) {
    throw safeError("UNSAFE_CODEX_HOME", "Codex home ownership marker is invalid.");
  }
  let marker;
  try {
    marker = JSON.parse((await readFile(markerPath, "utf8")).replace(/^\uFEFF/, ""));
  } catch {
    throw safeError("UNSAFE_CODEX_HOME", "Codex home ownership marker is invalid.");
  }
  if (marker === null || typeof marker !== "object" || Array.isArray(marker)
      || Object.keys(marker).sort().join(",") !== "dailyHomeCopied,purpose"
      || marker.purpose !== EXTERNAL_CODEX_OWNER_PURPOSE || marker.dailyHomeCopied !== false) {
    throw safeError("UNSAFE_CODEX_HOME", "Codex home ownership marker is invalid.");
  }
}

async function fsyncDirectory(path) {
  try {
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // File fsync and readback still protect filesystems without directory fsync.
  }
}

async function assertOwnedRoot(root, runId, baseDirectory, repositoryRoot, homeDirectory, codexHome) {
  await assertSafeTempRoot(root, { repositoryRoot, homeDirectory, codexHome });
  const metadata = await lstat(root).catch(() => null);
  if (metadata === null || !metadata.isDirectory()) {
    throw safeError("OWNERSHIP_MARKER_INVALID", "Owned root is unavailable.");
  }
  const markerPath = join(root, OWNER_MARKER);
  const markerMetadata = await lstat(markerPath).catch(() => null);
  if (markerMetadata === null || !markerMetadata.isFile() || markerMetadata.isSymbolicLink()) {
    throw safeError("OWNERSHIP_MARKER_INVALID", "Ownership marker is invalid.");
  }
  let marker;
  try {
    marker = JSON.parse(await readFile(markerPath, "utf8"));
  } catch {
    throw safeError("OWNERSHIP_MARKER_INVALID", "Ownership marker is invalid.");
  }
  if (marker?.schemaVersion !== 1 || marker?.runId !== runId || marker?.pid !== process.pid) {
    throw safeError("OWNERSHIP_MARKER_INVALID", "Ownership marker is invalid.");
  }
  const base = await realpath(resolve(baseDirectory)).catch(() => resolve(baseDirectory));
  const owned = await realpath(resolve(root)).catch(() => resolve(root));
  if (!isWithin(owned, base)) {
    throw safeError("UNSAFE_TEMP_ROOT", "Owned root escaped its base.");
  }
}

async function assertPrivateRunRoot(root) {
  const metadata = await lstat(root).catch(() => null);
  if (metadata === null || !metadata.isDirectory() || metadata.isSymbolicLink()
      || (metadata.mode & 0o777) !== OWNER_MODE) {
    throw safeError("OWNERSHIP_MARKER_INVALID", "Owned root is unavailable.");
  }
  const markerPath = join(root, OWNER_MARKER);
  const markerMetadata = await lstat(markerPath).catch(() => null);
  if (markerMetadata === null || !markerMetadata.isFile() || markerMetadata.isSymbolicLink()) {
    throw safeError("OWNERSHIP_MARKER_INVALID", "Ownership marker is invalid.");
  }
  let marker;
  try {
    marker = JSON.parse(await readFile(markerPath, "utf8"));
  } catch {
    throw safeError("OWNERSHIP_MARKER_INVALID", "Ownership marker is invalid.");
  }
  if (marker?.schemaVersion !== 1 || marker?.pid !== process.pid || !UUID_PATTERN.test(marker?.runId)) {
    throw safeError("OWNERSHIP_MARKER_INVALID", "Ownership marker is invalid.");
  }
}

async function ensurePrivateDirectory(path, root) {
  if (!isWithin(path, root)) {
    throw safeError("UNSAFE_PRIVATE_PATH", "Private path escaped the run root.");
  }
  const relativePath = relative(resolve(root), resolve(path));
  const segments = relativePath === "" ? [] : relativePath.split("/");
  let current = resolve(root);
  for (const segment of segments) {
    current = join(current, segment);
    const metadata = await lstat(current).catch(() => null);
    if (metadata?.isSymbolicLink() || metadata !== null && !metadata.isDirectory()) {
      throw safeError("UNSAFE_PRIVATE_PATH", "Private path contains a symbolic link.");
    }
    if (metadata === null) {
      await mkdir(current, { mode: OWNER_MODE });
      await chmod(current, OWNER_MODE);
    }
  }
}

function validatePrivateRelativePath(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 240
      || isAbsolute(value) || value.includes("\\") || value.split("/").some((part) =>
        part.length === 0 || part === "." || part === "..")) {
    throw safeError("UNSAFE_PRIVATE_PATH", "Private path is invalid.");
  }
  return value;
}

async function assertNoSymlinkPath(path) {
  const absolute = resolve(path);
  const parts = absolute.split("/");
  let current = absolute.startsWith("/") ? "/" : "";
  for (const part of parts) {
    if (part.length === 0) {
      continue;
    }
    current = current === "/" ? `/${part}` : join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink() && !isTrustedSystemAlias(current)) {
        throw safeError("UNSAFE_TEMP_ROOT_SYMLINK", "Temporary root contains a symbolic link.");
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
      break;
    }
  }
}

function isTrustedSystemAlias(path) {
  return path === "/var" || path === "/tmp";
}

async function assertSafeCodexHomeTree(path, allowedBinaryPath) {
  const binaryPath = await resolveAllowedCodexBinary(allowedBinaryPath);
  const root = resolve(path);
  await visit(root);

  async function visit(current) {
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) {
      const linkPath = relative(root, current);
      if (!CODEX_HELPER_LINK_PATTERN.test(linkPath) || binaryPath === null) {
        throw safeError("UNSAFE_CODEX_HOME", "Codex home contains an unsafe symbolic link.");
      }
      const target = await realpath(current).catch(() => null);
      if (target !== binaryPath) {
        throw safeError("UNSAFE_CODEX_HOME", "Codex helper link target is invalid.");
      }
      return;
    }
    if ((metadata.mode & 0o077) !== 0) {
      if (!isCodexHelperArea(relative(root, current))) {
        throw safeError("UNSAFE_CODEX_HOME", "Codex home permissions are too broad.");
      }
      await chmod(current, metadata.isDirectory() ? 0o700 : 0o600);
    }
    if (!metadata.isDirectory()) {
      return;
    }
    for (const entry of await readdir(current)) {
      await visit(join(current, entry));
    }
  }
}

function isCodexHelperArea(path) {
  return path === "tmp"
    || path === "tmp/arg0"
    || /^tmp\/arg0\/codex-arg0[A-Za-z0-9_-]{1,64}(?:\/|$)/.test(path);
}

async function resolveAllowedCodexBinary(path) {
  if (typeof path !== "string" || !isAbsolute(path)) {
    return null;
  }
  const metadata = await lstat(path).catch(() => null);
  if (metadata === null || metadata.isSymbolicLink() || !metadata.isFile() || (metadata.mode & 0o111) === 0) {
    return null;
  }
  return await realpath(path).catch(() => null);
}

/**
 * Remove an owned tree without ever following a child symlink. Electron and
 * Codex may create lock/socket links in their private profiles; unlinking the
 * link keeps the external target untouched while allowing idempotent cleanup.
 */
async function removeOwnedTree(path) {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) {
    await unlink(path);
    return;
  }
  if (!metadata.isDirectory()) {
    await unlink(path);
    return;
  }
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const entryPath = join(path, entry.name);
    if (entry.isSymbolicLink()) {
      await unlink(entryPath);
    } else if (entry.isDirectory()) {
      await removeOwnedTree(entryPath);
    } else {
      await unlink(entryPath);
    }
  }
  await rmdir(path);
}

async function findExistingAncestor(path) {
  let current = path;
  while (true) {
    try {
      await lstat(current);
      return current;
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw safeError("UNSAFE_TEMP_ROOT", "Temporary root is unavailable.");
      }
      const parent = dirname(current);
      if (parent === current) {
        throw safeError("UNSAFE_TEMP_ROOT", "Temporary root has no safe ancestor.");
      }
      current = parent;
    }
  }
}

function requireAbsolutePath(value, code) {
  if (typeof value !== "string" || !isAbsolute(value)) {
    throw safeError(code, "Path must be absolute.");
  }
  return resolve(value);
}

function isWithin(candidate, parent) {
  const child = resolve(candidate);
  const root = resolve(parent);
  const remainder = relative(root, child);
  return remainder === "" || (remainder !== ".." && !remainder.startsWith("../"));
}

function safeError(code, message, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.code = code;
  return error;
}
