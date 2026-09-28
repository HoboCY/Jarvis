import { strict as assert } from "node:assert";
import { lstat, mkdtemp, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { extractElectronZip } from "@electron/packager/dist/unzip.js";
import { createDeterministicArchive } from "./deterministic-archive.mjs";

test("Electron packager extracts regular files and contained framework symlinks", {
  skip: process.platform === "win32"
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-electron-extract-"));
  try {
    const source = join(root, "source");
    const target = join(root, "target");
    await mkdir(source);
    await writeFile(join(source, "binary"), "controlled binary fixture");
    await symlink("binary", join(source, "current"));
    const archive = createDeterministicArchive("zip", source, join(root, "fixture.zip"));
    await extractElectronZip(archive, target);
    assert.equal(await readFile(join(target, "binary"), "utf8"), "controlled binary fixture");
    assert.equal(await readlink(join(target, "current")), "binary");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Electron packager does not write outside through a duplicate symlink entry", {
  skip: process.platform === "win32"
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-electron-containment-"));
  try {
    const source = join(root, "source");
    const target = join(root, "target");
    const outside = join(root, "outside.txt");
    await mkdir(source);
    await writeFile(outside, "unchanged sentinel");
    await symlink("../outside.txt", join(source, "aaaaa"));
    await writeFile(join(source, "bbbbb"), "must remain inside target");
    const archive = createDeterministicArchive("zip", source, join(root, "fixture.zip"));
    const bytes = await readFile(archive);
    // Equal-length ZIP entry names need no offset or content CRC changes.
    let replacements = 0;
    for (let offset = bytes.indexOf("bbbbb"); offset !== -1; offset = bytes.indexOf("bbbbb", offset + 5)) {
      bytes.write("aaaaa", offset);
      replacements += 1;
    }
    assert.equal(replacements, 2);
    await writeFile(archive, bytes);
    const [result] = await Promise.allSettled([extractElectronZip(archive, target)]);
    assert.equal(await readFile(outside, "utf8"), "unchanged sentinel");
    if (result.status === "fulfilled") {
      assert.equal((await lstat(join(target, "aaaaa"))).isSymbolicLink(), false);
      assert.equal(await readFile(join(target, "aaaaa"), "utf8"), "must remain inside target");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
