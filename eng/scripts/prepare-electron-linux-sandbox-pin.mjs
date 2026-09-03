import { constants as fsConstants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveElectronSandboxTarget,
  resolveSandboxTargetFromInstall
} from "./prepare-electron-linux-sandbox.mjs";

const sandboxBasename = "chrome-sandbox";
const openNoFollow = requiredFlag("O_NOFOLLOW");
const openDirectory = requiredFlag("O_DIRECTORY");
const openCloseOnExec = fsConstants.O_CLOEXEC ?? 0;
const openNonBlocking = requiredFlag("O_NONBLOCK");

function fail() {
  throw new Error("Electron sandbox pinning failed.");
}

function requiredFlag(name) {
  const value = fsConstants[name];
  if (!Number.isInteger(value) || value <= 0) {
    fail();
  }
  return value;
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.nlink === right.nlink;
}

function requireDirectory(metadata) {
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    fail();
  }
}

function requireRegular(metadata) {
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    fail();
  }
}

function requireSingleLinkRegular(metadata) {
  requireRegular(metadata);
  if (metadata.nlink !== 1) {
    fail();
  }
}

function attributes(metadata) {
  return {
    gid: metadata.gid,
    mode: metadata.mode & 0o7777,
    uid: metadata.uid
  };
}

async function inspectNoFollow(path) {
  try {
    return await lstat(path);
  } catch {
    fail();
  }
}

function procSandboxPath(parentHandle) {
  if (process.platform !== "linux") {
    return undefined;
  }
  if (!Number.isInteger(parentHandle.fd) || parentHandle.fd < 0) {
    fail();
  }
  return `/proc/self/fd/${parentHandle.fd}/${sandboxBasename}`;
}

/**
 * Open and pin the resolver-selected sandbox inode. Linux uses a descriptor
 * for the canonical parent directory, then opens the child through /proc so
 * a workspace pathname replacement cannot redirect the descriptor.
 */
export async function openPinnedSandbox(options = {}) {
  let parentHandle;
  let sandboxHandle;
  try {
    const target = options.workspaceRoot && options.electronInstallRoot
      ? await resolveSandboxTargetFromInstall(options)
      : await resolveElectronSandboxTarget();
    if (basename(target.sandboxPath) !== sandboxBasename) {
      fail();
    }

    const parentPath = dirname(target.sandboxPath);
    parentHandle = await open(parentPath,
      fsConstants.O_RDONLY | openDirectory | openCloseOnExec | openNoFollow);
    // FileHandle.stat() is descriptor-backed fstat; it cannot follow a path replacement.
    const parentMetadata = await parentHandle.stat();
    requireDirectory(parentMetadata);
    const currentParent = await inspectNoFollow(parentPath);
    requireDirectory(currentParent);
    if (!sameIdentity(parentMetadata, currentParent)) {
      fail();
    }

    const pinnedPath = procSandboxPath(parentHandle) ?? target.sandboxPath;
    const pathMetadata = await inspectNoFollow(pinnedPath);
    // Only the sandbox is mutated; metadata and Electron binaries may be pnpm hardlinks.
    requireSingleLinkRegular(pathMetadata);
    sandboxHandle = await open(pinnedPath,
      fsConstants.O_RDONLY | openNonBlocking | openCloseOnExec | openNoFollow);
    const descriptorMetadata = await sandboxHandle.stat();
    requireSingleLinkRegular(descriptorMetadata);
    if (!sameIdentity(pathMetadata, descriptorMetadata)) {
      fail();
    }

    return {
      before: descriptorMetadata,
      parentHandle,
      parentMetadata,
      parentPath,
      pinnedPath,
      sandboxHandle,
      target
    };
  } catch (error) {
    await sandboxHandle?.close().catch(() => {});
    await parentHandle?.close().catch(() => {});
    if (error?.message === "Electron sandbox pinning failed.") {
      throw error;
    }
    fail();
  }
}

/**
 * Re-check the pinned descriptor and the current no-follow directory entry.
 * `requireAttributes` is used only after the privileged system utilities run.
 */
export async function verifyPinnedSandbox(pinned, { requireAttributes = false } = {}) {
  if (!pinned?.sandboxHandle || !pinned?.parentHandle) {
    fail();
  }
  const descriptorMetadata = await pinned.sandboxHandle.stat();
  requireSingleLinkRegular(descriptorMetadata);
  if (!sameIdentity(pinned.before, descriptorMetadata)) {
    fail();
  }

  const currentParent = await inspectNoFollow(pinned.parentPath);
  requireDirectory(currentParent);
  const parentMetadata = await pinned.parentHandle.stat();
  requireDirectory(parentMetadata);
  if (!sameIdentity(parentMetadata, currentParent)) {
    fail();
  }

  const currentPath = await inspectNoFollow(pinned.pinnedPath);
  requireSingleLinkRegular(currentPath);
  if (!sameIdentity(pinned.before, currentPath)) {
    fail();
  }
  if (requireAttributes) {
    for (const metadata of [descriptorMetadata, currentPath]) {
      const current = attributes(metadata);
      if (current.uid !== 0 || current.gid !== 0 || current.mode !== 0o4755) {
        fail();
      }
    }
  }
  return {
    currentPathSameIdentity: true,
    sameIdentity: true,
    sandboxPath: pinned.target.sandboxPath,
    ...attributes(descriptorMetadata)
  };
}

export async function closePinnedSandbox(pinned) {
  await pinned?.sandboxHandle?.close();
  await pinned?.parentHandle?.close();
}

async function writeLine(line) {
  if (process.stdout.write(`${line}\n`)) {
    return;
  }
  await new Promise((resolvePromise, reject) => {
    process.stdout.once("drain", resolvePromise);
    process.stdout.once("error", reject);
  });
}

async function waitForVerification(pinned) {
  const keepAlive = setInterval(() => {}, 60_000);
  try {
    return await new Promise((resolvePromise, reject) => {
      process.once("SIGUSR1", () => {
        verifyPinnedSandbox(pinned, { requireAttributes: true })
          .then(resolvePromise, reject);
      });
      process.once("SIGTERM", () => reject(new Error("Electron sandbox pinning interrupted.")));
    });
  } finally {
    clearInterval(keepAlive);
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
const modulePath = resolve(fileURLToPath(import.meta.url));
if (invokedPath === modulePath) {
  let pinned;
  try {
    if (process.platform !== "linux"
      || process.argv.length !== 3
      || !["--dry-run", "--pin"].includes(process.argv[2])) {
      throw new Error("Unexpected Electron sandbox pinning arguments.");
    }
    pinned = await openPinnedSandbox();
    if (process.argv[2] === "--dry-run") {
      await verifyPinnedSandbox(pinned);
      await writeLine("Electron sandbox dry-run validated.");
    } else {
      const { dev, ino, nlink } = pinned.before;
      await writeLine(
        `PID=${process.pid} FD=${pinned.sandboxHandle.fd} DEV=${dev} INO=${ino} NLINK=${nlink}`);
      await waitForVerification(pinned);
      await writeLine("Electron sandbox pinned and verified.");
    }
  } catch {
    console.error("Electron sandbox pinning failed.");
    process.exitCode = 1;
  } finally {
    await closePinnedSandbox(pinned).catch(() => {});
  }
}
