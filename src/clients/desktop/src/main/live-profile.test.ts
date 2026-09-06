import { strict as assert } from "node:assert";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  configurePhase9bLiveProfile,
  phase9bLiveEnvironmentVariable,
  phase9bLiveFlag,
  phase9bOwnerMarkerEnvironmentVariable,
  phase9bRunIdEnvironmentVariable,
  resolvePhase9bLiveProfile
} from "./live-profile.js";

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "jarvis-phase9b-live-profile-")));
  const desktopProfile = join(root, "desktop-profile");
  const markerPath = join(root, ".phase9b-owner.json");
  await mkdir(desktopProfile, { mode: 0o700 });
  await chmod(root, 0o700);
  await chmod(desktopProfile, 0o700);
  await writeFile(markerPath, `${JSON.stringify({
    schemaVersion: 1,
    runId: "11111111-1111-4111-8111-111111111111",
    pid: process.pid,
    createdAtUtc: new Date().toISOString()
  })}\n`, { mode: 0o600 });
  await chmod(markerPath, 0o600);
  return { root, desktopProfile, markerPath };
}

function args(desktopProfile: string): string[] {
  return ["electron", phase9bLiveFlag, `--user-data-dir=${desktopProfile}`];
}

function environment(markerPath: string): Record<string, string> {
  return {
    [phase9bLiveEnvironmentVariable]: "1",
    [phase9bRunIdEnvironmentVariable]: "11111111-1111-4111-8111-111111111111",
    [phase9bOwnerMarkerEnvironmentVariable]: markerPath
  };
}

test("live profile requires the explicit flag, private profile, and owner marker", async () => {
  const current = await fixture();
  try {
    const profile = resolvePhase9bLiveProfile(args(current.desktopProfile), environment(current.markerPath));
    assert.deepEqual(profile, {
      runId: "11111111-1111-4111-8111-111111111111",
      userDataDirectory: current.desktopProfile,
      ownerMarkerPath: current.markerPath
    });
    const app = { names: [] as string[], setName(name: string) { this.names.push(name); } };
    configurePhase9bLiveProfile(app, args(current.desktopProfile), environment(current.markerPath));
    assert.deepEqual(app.names, ["Jarvis Phase9B 11111111-1111-4111-8111-111111111111"]);
  } finally {
    await rm(current.root, { recursive: true, force: true });
  }
});

test("ordinary launches do not change the application name", () => {
  const app = { called: false, setName() { this.called = true; } };
  assert.equal(configurePhase9bLiveProfile(app, ["electron"], {}), undefined);
  assert.equal(app.called, false);
});

test("live profile rejects missing marker, profile escapes, and malformed extra fields", async () => {
  const current = await fixture();
  try {
    assert.throws(
      () => resolvePhase9bLiveProfile(args(current.desktopProfile), {
        ...environment(current.markerPath),
        [phase9bOwnerMarkerEnvironmentVariable]: join(current.root, "missing-marker.json")
      }),
      /live profile is invalid/);
    assert.throws(
      () => resolvePhase9bLiveProfile(args(join(current.root, "missing")), environment(current.markerPath)),
      /live profile is invalid/);
    await writeFile(current.markerPath, `${JSON.stringify({
      schemaVersion: 1,
      runId: "11111111-1111-4111-8111-111111111111",
      pid: process.pid,
      createdAtUtc: new Date().toISOString(),
      extra: true
    })}\n`);
    await chmod(current.markerPath, 0o600);
    assert.throws(
      () => resolvePhase9bLiveProfile(args(current.desktopProfile), environment(current.markerPath)),
      /live profile is invalid/);
  } finally {
    await rm(current.root, { recursive: true, force: true });
  }
});
