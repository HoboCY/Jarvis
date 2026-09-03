import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { chmod, link, lstat, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  assertSandboxAttributes,
  inspectSandboxFile,
  resolveSandboxTargetFromInstall,
  sanitizeSandboxError,
  validateSandboxTarget
} from "./prepare-electron-linux-sandbox.mjs";
import {
  closePinnedSandbox,
  openPinnedSandbox,
  verifyPinnedSandbox
} from "./prepare-electron-linux-sandbox-pin.mjs";

const execFileAsync = promisify(execFile);

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "jarvis-electron-sandbox-contract-"));
  const electronRoot = join(root, "node_modules", "electron");
  const distRoot = join(electronRoot, "dist");
  const electronBinary = join(distRoot, "electron");
  const sandboxPath = join(distRoot, "chrome-sandbox");
  await mkdir(distRoot, { recursive: true });
  await mkdir(join(root, "src", "clients", "desktop"), { recursive: true });
  await writeFile(electronBinary, "electron fixture");
  await writeFile(sandboxPath, "sandbox fixture");
  await writeFile(join(electronRoot, "package.json"), JSON.stringify({ version: "44.0.0" }));
  await writeFile(join(electronRoot, "path.txt"), "electron\n");
  await writeFile(join(root, "src", "clients", "desktop", "package.json"), "{}\n");
  return { root, electronRoot, electronBinary, sandboxPath };
}

async function withFixture(run) {
  const fixture = await createFixture();
  try {
    await run(fixture);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

test("Linux sandbox target requires the exact chrome-sandbox basename", async () => {
  await withFixture(async ({ root, electronRoot, electronBinary, sandboxPath }) => {
    await assert.rejects(
      () => validateSandboxTarget({
        workspaceRoot: root,
        electronInstallRoot: electronRoot,
        electronBinaryPath: electronBinary,
        sandboxPath: join(root, "node_modules", "electron", "dist", "sandbox-helper")
      }),
      /basename/);

    const target = await validateSandboxTarget({
        workspaceRoot: root,
        electronInstallRoot: electronRoot,
        electronBinaryPath: electronBinary,
        sandboxPath
      });
    assert.deepEqual(target, {
      electronBinary: await realpath(electronBinary),
      sandboxPath: await realpath(join(root, "node_modules", "electron", "dist"))
        .then(path => join(path, "chrome-sandbox"))
    });
  });
});

test("Electron path metadata resolves the binary and sandbox from the same dist directory", async () => {
  await withFixture(async ({ root, electronRoot, electronBinary, sandboxPath }) => {
    const target = await resolveSandboxTargetFromInstall({
      workspaceRoot: root,
      electronInstallRoot: electronRoot
    });

    assert.equal(target.electronBinary, await realpath(electronBinary));
    assert.equal(target.sandboxPath, await realpath(sandboxPath));
    assert.equal(
      target.sandboxPath,
      join(dirname(await realpath(electronBinary)), "chrome-sandbox"));
  });
});

test("re-resolving after fixture mutation returns the identical expected target", async () => {
  await withFixture(async ({ root, electronRoot }) => {
    const before = await resolveSandboxTargetFromInstall({
      workspaceRoot: root,
      electronInstallRoot: electronRoot
    });
    await chmod(before.sandboxPath, 0o4755);
    const after = await resolveSandboxTargetFromInstall({
      workspaceRoot: root,
      electronInstallRoot: electronRoot
    });

    assert.deepEqual(after, before);
    const metadata = await inspectSandboxFile(after.sandboxPath);
    assert.equal(metadata.isRegularFile, true);
    assert.equal(metadata.isSymbolicLink, false);
    assert.equal(metadata.mode, 0o4755);

    const pinned = await openPinnedSandbox({
      workspaceRoot: root,
      electronInstallRoot: electronRoot
    });
    try {
      const dryRun = await verifyPinnedSandbox(pinned);
      assert.equal(dryRun.sameIdentity, true);
      assert.equal(dryRun.currentPathSameIdentity, true);
      assert.equal(dryRun.sandboxPath, before.sandboxPath);

      const originalPath = join(dirname(before.sandboxPath), "sandbox-original");
      const outsideTarget = join(root, "outside-target");
      await rename(before.sandboxPath, originalPath);
      await writeFile(outsideTarget, "outside target");
      const outsideBefore = await lstat(outsideTarget);
      await symlink(outsideTarget, before.sandboxPath);
      await assert.rejects(
        () => verifyPinnedSandbox(pinned),
        /Electron sandbox pinning failed/);
      const outsideAfter = await lstat(outsideTarget);
      assert.equal(outsideAfter.ino, outsideBefore.ino);
      assert.equal(outsideAfter.mode, outsideBefore.mode);
      await rm(before.sandboxPath);
      await rename(originalPath, before.sandboxPath);
      const restored = await verifyPinnedSandbox(pinned);
      assert.equal(restored.sameIdentity, true);
    } finally {
      await closePinnedSandbox(pinned);
    }

    const hardLink = join(dirname(before.sandboxPath), "sandbox-hard-link");
    await link(before.sandboxPath, hardLink);
    await assert.rejects(
      () => openPinnedSandbox({ workspaceRoot: root, electronInstallRoot: electronRoot }),
      /Electron sandbox pinning failed/);
    await rm(hardLink);
  });
});

test("Linux sandbox target must stay inside the workspace Electron installation", async () => {
  await withFixture(async ({ root, electronRoot, electronBinary, sandboxPath }) => {
    const outsidePath = join(root, "outside", "chrome-sandbox");
    await mkdir(join(root, "outside"), { recursive: true });
    await writeFile(outsidePath, "outside fixture");

    await assert.rejects(
      () => validateSandboxTarget({
        workspaceRoot: root,
        electronInstallRoot: electronRoot,
        electronBinaryPath: electronBinary,
        sandboxPath: outsidePath
      }),
      /Electron installation/);

    await assert.rejects(
      () => validateSandboxTarget({
        workspaceRoot: root,
        electronInstallRoot: join(root, "other-electron"),
        electronBinaryPath: electronBinary,
        sandboxPath
      }),
      /Electron installation/);
  });
});

test("Linux sandbox target rejects symlinks, directories, and FIFOs", async () => {
  await withFixture(async ({ root, electronRoot, electronBinary, sandboxPath }) => {
    await rm(sandboxPath);
    await symlink(electronBinary, sandboxPath);
    await assert.rejects(
      () => validateSandboxTarget({
        workspaceRoot: root,
        electronInstallRoot: electronRoot,
        electronBinaryPath: electronBinary,
        sandboxPath
      }),
      /symlink|regular file/);

    await rm(sandboxPath);
    await mkdir(sandboxPath);
    await assert.rejects(
      () => validateSandboxTarget({
        workspaceRoot: root,
        electronInstallRoot: electronRoot,
        electronBinaryPath: electronBinary,
        sandboxPath
      }),
      /regular file/);

    await rm(sandboxPath, { recursive: true, force: true });
    await execFileAsync("mkfifo", [sandboxPath]);
    const fifoMetadata = await lstat(sandboxPath);
    assert.equal(fifoMetadata.isFIFO(), true);
    await assert.rejects(
      () => validateSandboxTarget({
        workspaceRoot: root,
        electronInstallRoot: electronRoot,
        electronBinaryPath: electronBinary,
        sandboxPath
      }),
      /regular file/);
  });
});

test("Linux sandbox target fails clearly when chrome-sandbox is missing", async () => {
  await withFixture(async ({ root, electronRoot, electronBinary, sandboxPath }) => {
    await rm(sandboxPath);
    await assert.rejects(
      () => validateSandboxTarget({
        workspaceRoot: root,
        electronInstallRoot: electronRoot,
        electronBinaryPath: electronBinary,
        sandboxPath
      }),
      /missing/);
  });
});

test("Linux sandbox attributes require root ownership and 4755 mode", () => {
  assert.throws(
    () => assertSandboxAttributes({ uid: 501, gid: 20, mode: 0o4755 }),
    /root ownership/);
  assert.throws(
    () => assertSandboxAttributes({ uid: 0, gid: 0, mode: 0o755 }),
    /4755/);
});

test("sandbox inspection reports file metadata without mutating the fixture", async () => {
  await withFixture(async ({ sandboxPath }) => {
    const before = await lstat(sandboxPath);
    const inspected = await inspectSandboxFile(sandboxPath);
    const after = await lstat(sandboxPath);
    assert.equal(inspected.isRegularFile, true);
    assert.equal(inspected.mode, before.mode & 0o7777);
    assert.equal(after.mode, before.mode);
  });
});

test("sandbox errors never echo secret-shaped input or filesystem paths", () => {
  const secret = "Bearer sk-jarvis-live-0123456789abcdef";
  const error = sanitizeSandboxError(new Error(`${secret} /Users/hobo/private/token`));
  assert.equal(error, "Electron sandbox preparation failed.");
  assert.doesNotMatch(error, new RegExp(secret));
  assert.doesNotMatch(error, /Users|private|token/);
});
