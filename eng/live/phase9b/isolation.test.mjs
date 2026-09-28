import { strict as assert } from "node:assert";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  assertSafeTempRoot,
  adoptExternalCodexHome,
  createRunIsolation,
  writePrivateJson
} from "./isolation.mjs";

test("run isolation creates private owned roots, fresh local secrets, and a loopback port", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-phase9b-isolation-"));
  const repositoryRoot = join(root, "repo");
  const homeDirectory = join(root, "home");
  const baseDirectory = join(root, "safe");
  await mkdir(repositoryRoot);
  await mkdir(homeDirectory);
  await mkdir(baseDirectory);
  await chmod(baseDirectory, 0o700);
  try {
    const isolation = await createRunIsolation({ repositoryRoot, homeDirectory, baseDirectory });
    try {
      assert.match(isolation.runId, /^[0-9a-f-]{36}$/);
      assert.equal(isolation.localBearer.length, 64);
      assert.equal(isolation.safetyIdentifierSalt.length, 64);
      assert.notEqual(isolation.localBearer, isolation.safetyIdentifierSalt);
      assert.equal(isolation.port > 0, true);
      assert.equal(isolation.portHost, "127.0.0.1");
      assert.equal((await lstat(isolation.root)).mode & 0o777, 0o700);
      assert.equal((await lstat(isolation.directories.codexHome)).mode & 0o777, 0o700);
      assert.equal((await lstat(join(isolation.root, ".phase9b-owner.json"))).mode & 0o777, 0o600);
      const marker = JSON.parse(await readFile(join(isolation.root, ".phase9b-owner.json"), "utf8"));
      assert.deepEqual(Object.keys(marker).sort(), ["createdAtUtc", "pid", "runId", "schemaVersion"]);
      assert.equal(marker.runId, isolation.runId);
      assert.equal(JSON.stringify(marker).includes(isolation.localBearer), false);
      assert.equal(JSON.stringify(isolation).includes(isolation.localBearer), false);
      assert.equal(JSON.stringify(isolation).includes(isolation.safetyIdentifierSalt), false);
    } finally {
      assert.equal(await isolation.cleanup(), true);
      assert.equal(await isolation.cleanup(), false);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("temporary roots inside protected locations and symlink aliases are denied", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-phase9b-isolation-deny-"));
  const repositoryRoot = join(root, "repo");
  const homeDirectory = join(root, "home");
  const codexHome = join(homeDirectory, ".codex");
  const safe = join(root, "safe");
  const alias = join(root, "alias");
  await mkdir(repositoryRoot);
  await mkdir(codexHome, { recursive: true });
  await mkdir(safe);
  await symlink(safe, alias);
  try {
    for (const candidate of [repositoryRoot, homeDirectory, codexHome]) {
      await assert.rejects(
        () => assertSafeTempRoot(candidate, { repositoryRoot, homeDirectory, codexHome }),
        (error) => error.code === "UNSAFE_TEMP_ROOT"
      );
    }
    await assert.rejects(
      () => assertSafeTempRoot(alias, { repositoryRoot, homeDirectory, codexHome }),
      (error) => error.code === "UNSAFE_TEMP_ROOT_SYMLINK"
    );
    await assert.rejects(
      () => assertSafeTempRoot(join(alias, "future"), { repositoryRoot, homeDirectory, codexHome }),
      (error) => error.code === "UNSAFE_TEMP_ROOT_SYMLINK"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cleanup refuses a root whose ownership marker was replaced", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-phase9b-isolation-owner-"));
  const repositoryRoot = join(root, "repo");
  const homeDirectory = join(root, "home");
  const baseDirectory = join(root, "safe");
  await mkdir(repositoryRoot);
  await mkdir(homeDirectory);
  await mkdir(baseDirectory);
  await chmod(baseDirectory, 0o700);
  try {
    const isolation = await createRunIsolation({ repositoryRoot, homeDirectory, baseDirectory });
    await rm(join(isolation.root, ".phase9b-owner.json"));
    await assert.rejects(() => isolation.cleanup(), (error) => error.code === "OWNERSHIP_MARKER_INVALID");
    assert.equal((await lstat(isolation.root)).isDirectory(), true);
    await rm(isolation.root, { recursive: true, force: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("private production JSON is owner-only and cannot escape the run root", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-phase9b-isolation-json-"));
  const repositoryRoot = join(root, "repo");
  const homeDirectory = join(root, "home");
  const baseDirectory = join(root, "safe");
  await mkdir(repositoryRoot);
  await mkdir(homeDirectory);
  await mkdir(baseDirectory);
  await chmod(baseDirectory, 0o700);
  try {
    const isolation = await createRunIsolation({ repositoryRoot, homeDirectory, baseDirectory });
    const path = await writePrivateJson(isolation.root, "codex-home/config.json", { api: "ephemeral" });
    assert.equal((await lstat(path)).mode & 0o777, 0o600);
    assert.equal((await readFile(path, "utf8")).includes("ephemeral"), true);
    await assert.rejects(
      () => writePrivateJson(isolation.root, "../outside.json", {}),
      (error) => error.code === "UNSAFE_PRIVATE_PATH"
    );
    await isolation.cleanup();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cleanup unlinks profile symlinks without touching their external target", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-phase9b-isolation-profile-link-"));
  const repositoryRoot = join(root, "repo");
  const homeDirectory = join(root, "home");
  const baseDirectory = join(root, "safe");
  const external = join(root, "external");
  await mkdir(repositoryRoot);
  await mkdir(homeDirectory);
  await mkdir(baseDirectory);
  await mkdir(external);
  await writeFile(join(external, "keep.txt"), "keep\n", { mode: 0o600 });
  await chmod(baseDirectory, 0o700);
  try {
    const isolation = await createRunIsolation({ repositoryRoot, homeDirectory, baseDirectory });
    await symlink(external, join(isolation.directories.desktopProfile, "SingletonLock"));
    assert.equal(await isolation.cleanup(), true);
    assert.equal(await lstat(external).then((metadata) => metadata.isDirectory()), true);
    assert.equal(await readFile(join(external, "keep.txt"), "utf8"), "keep\n");
    assert.equal(await isolation.cleanup(), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex home adoption permits only pinned helper links and rejects credential links", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-phase9b-isolation-codex-"));
  const repositoryRoot = join(root, "repo");
  const homeDirectory = join(root, "home");
  const baseDirectory = join(root, "safe");
  const source = join(root, "source-home");
  const pinnedBinary = join(root, "codex");
  await mkdir(repositoryRoot);
  await mkdir(homeDirectory);
  await mkdir(baseDirectory);
  await mkdir(source, { mode: 0o700 });
  await chmod(baseDirectory, 0o700);
  await chmod(source, 0o700);
  await writeFile(
    join(source, ".phase9b-owned"),
    JSON.stringify({ purpose: "isolated-normal-codex-login", dailyHomeCopied: false }),
    { mode: 0o600 }
  );
  await writeFile(pinnedBinary, "fixture-codex\n", { mode: 0o700 });
  const helperRoot = join(source, "tmp");
  const helperArg0 = join(helperRoot, "arg0");
  const helperDirectory = join(helperArg0, "codex-arg0fixture");
  await mkdir(helperDirectory, { recursive: true, mode: 0o755 });
  await chmod(helperRoot, 0o755);
  await chmod(helperArg0, 0o755);
  await chmod(helperDirectory, 0o755);
  await writeFile(join(helperDirectory, ".lock"), "fixture-lock\n", { mode: 0o644 });
  await symlink(pinnedBinary, join(helperDirectory, "apply_patch"));
  await symlink(pinnedBinary, join(helperDirectory, "applypatch"));
  await symlink(pinnedBinary, join(helperDirectory, "codex-execve-wrapper"));
  try {
    const isolation = await createRunIsolation({ repositoryRoot, homeDirectory, baseDirectory });
    try {
      const adopted = await adoptExternalCodexHome(source, isolation, { allowedBinaryPath: pinnedBinary });
      assert.equal(adopted, isolation.directories.codexHome);
      assert.equal(await readlink(join(adopted, "tmp", "arg0", "codex-arg0fixture", "apply_patch")), pinnedBinary);
      assert.equal((await lstat(join(adopted, "tmp")).then((metadata) => metadata.mode & 0o777)), 0o700);
      assert.equal((await lstat(join(adopted, "tmp", "arg0", "codex-arg0fixture", ".lock"))).mode & 0o777, 0o600);
    } finally {
      await isolation.cleanup();
    }

    const sensitiveSource = join(root, "sensitive-home");
    await mkdir(sensitiveSource, { mode: 0o700 });
    await chmod(sensitiveSource, 0o700);
    await writeFile(
      join(sensitiveSource, ".phase9b-owned"),
      JSON.stringify({ purpose: "isolated-normal-codex-login", dailyHomeCopied: false }),
      { mode: 0o600 }
    );
    await symlink(pinnedBinary, join(sensitiveSource, "auth.json"));
    const secondIsolation = await createRunIsolation({ repositoryRoot, homeDirectory, baseDirectory });
    try {
      await assert.rejects(
        () => adoptExternalCodexHome(sensitiveSource, secondIsolation, { allowedBinaryPath: pinnedBinary }),
        (error) => error.code === "UNSAFE_CODEX_HOME"
      );
      assert.equal(await lstat(sensitiveSource).then(() => true), true);
    } finally {
      await secondIsolation.cleanup();
    }

    const unmarkedSource = join(root, "unmarked-home");
    await mkdir(unmarkedSource, { mode: 0o700 });
    await chmod(unmarkedSource, 0o700);
    const thirdIsolation = await createRunIsolation({ repositoryRoot, homeDirectory, baseDirectory });
    try {
      await assert.rejects(
        () => adoptExternalCodexHome(unmarkedSource, thirdIsolation, { allowedBinaryPath: pinnedBinary }),
        (error) => error.code === "UNSAFE_CODEX_HOME"
      );
      assert.equal(await lstat(unmarkedSource).then(() => true), true);
    } finally {
      await thirdIsolation.cleanup();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
