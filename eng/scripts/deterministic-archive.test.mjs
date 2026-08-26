import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createDeterministicArchive } from "./deterministic-archive.mjs";

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
