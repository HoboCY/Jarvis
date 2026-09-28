import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createDeterministicArchive } from "./deterministic-archive.mjs";
import { runtimeCredentialRsyncExcludes } from "./artifact-file-policy.mjs";

const runtimeFiles = ["appsettings.secrets.json", "appsettings.Production.json", "secrets.json", "auth.json", "SECRETS.JSON"];

test("artifact policy CLI emits rsync patterns and rejects unsupported arguments without echoing them", () => {
  const cli = fileURLToPath(new URL("./artifact-file-policy.mjs", import.meta.url));
  const valid = spawnSync(process.execPath, [cli, "--rsync-excludes"], { encoding: "utf8" });
  assert.equal(valid.status, 0);
  assert.equal(valid.stderr, "");
  assert.deepEqual(valid.stdout.trim().split("\n"), runtimeCredentialRsyncExcludes());
  const invalid = spawnSync(process.execPath, [cli, "controlled-unsupported-input"], { encoding: "utf8" });
  assert.equal(invalid.status, 2);
  assert.equal(`${invalid.stdout}${invalid.stderr}`.includes("controlled-unsupported-input"), false);
});

test("archives reject runtime credential entries before reading their contents", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-archive-policy-"));
  try {
    for (const kind of ["tar.gz", "zip"]) {
      for (const name of runtimeFiles) {
        const source = join(root, `${kind}-${name}`);
        await mkdir(join(source, "nested"), { recursive: true });
        const forbidden = join(source, "nested", name);
        await writeFile(forbidden, "controlled runtime fixture", { mode: 0o000 });
        const output = join(root, "must-not-exist");
        try {
          assert.throws(() => createDeterministicArchive(kind, source, output), {
            message: "RUNTIME_CREDENTIAL_ARTIFACT_REJECTED"
          });
          assert.equal(existsSync(output), false);
        } finally {
          await chmod(forbidden, 0o600);
        }
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("service staging excludes runtime credentials while retaining distributable settings", {
  skip: process.platform === "win32"
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-source-policy-"));
  const source = join(root, "source");
  const target = join(root, "target");
  try {
    await mkdir(join(source, "nested"), { recursive: true });
    await mkdir(target);
    for (const name of runtimeFiles) {
      const path = join(source, "nested", name);
      if (!existsSync(path)) {
        await writeFile(path, "controlled runtime fixture", { mode: 0o000 });
      }
    }
    await writeFile(join(source, "nested", "appsettings.json"), "{}");
    await writeFile(join(source, "nested", "appsettings.secrets.example.json"), "{}");
    const result = spawnSync("rsync", ["-a",
      ...runtimeCredentialRsyncExcludes().flatMap(pattern => ["--exclude", pattern]),
      `${source}/`, `${target}/`
    ], { stdio: "ignore" });
    assert.equal(result.status, 0);
    assert.deepEqual((await readdir(join(target, "nested"))).sort(), [
      "appsettings.json", "appsettings.secrets.example.json"
    ]);
    for (const kind of ["tar.gz", "zip"]) {
      createDeterministicArchive(kind, target, join(root, `allowed.${kind}`));
    }
  } finally {
    for (const name of runtimeFiles) {
      await chmod(join(source, "nested", name), 0o600).catch(() => {});
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("tar.gz and ZIP archives are byte-for-byte deterministic for the same fixture", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-deterministic-archive-"));
  const source = join(root, "source");
  const tarFirst = join(root, "first.tar.gz");
  const tarSecond = join(root, "second.tar.gz");
  const zipFirst = join(root, "first.zip");
  const zipSecond = join(root, "second.zip");
  try {
    await mkdir(join(source, "nested", "z"), { recursive: true });
    await mkdir(join(source, "nested", "a"), { recursive: true });
    await writeFile(join(source, "root.txt"), "root fixture\n");
    await writeFile(join(source, "nested", "z", "later.txt"), "later\n");
    await writeFile(join(source, "nested", "a", "earlier.txt"), "earlier\n");

    createDeterministicArchive("tar.gz", source, tarFirst);
    createDeterministicArchive("tar.gz", source, tarSecond);
    createDeterministicArchive("zip", source, zipFirst);
    createDeterministicArchive("zip", source, zipSecond);

    assert.equal(await sha256(tarFirst), await sha256(tarSecond));
    assert.equal(await sha256(zipFirst), await sha256(zipSecond));
    assert.deepEqual(await readFile(tarFirst), await readFile(tarSecond));
    assert.deepEqual(await readFile(zipFirst), await readFile(zipSecond));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}
