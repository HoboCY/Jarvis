import { strict as assert } from "node:assert";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPhase9bRealtimeObserver, phase9bObservationArguments } from "./phase9b-realtime-observation.js";

const runId = "11111111-1111-4111-8111-111111111111";
const observation = {
  realtimeSessionId: "22222222-2222-7222-8222-222222222222",
  peerConnectionState: "connected",
  remoteAudioTrackCount: 1,
  liveRemoteAudioTrackCount: 1
};

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "jarvis-phase9b-observation-")));
  await chmod(root, 0o700);
  const userDataDirectory = join(root, "desktop-profile");
  const ownerMarkerPath = join(root, ".phase9b-owner.json");
  await mkdir(userDataDirectory, { mode: 0o700 });
  await writeFile(ownerMarkerPath, JSON.stringify({ schemaVersion: 1, runId, pid: process.pid, createdAtUtc: new Date().toISOString() }), { mode: 0o600 });
  return { root, profile: { runId, userDataDirectory, ownerMarkerPath }, path: join(root, "realtime-track-check.json") };
}

test("ordinary profiles expose no observation arguments or writer", () => {
  assert.deepEqual(phase9bObservationArguments(undefined), []);
  assert.equal(createPhase9bRealtimeObserver(undefined), undefined);
});

test("a validated live profile persists only bounded track metadata across Desktop restarts", async () => {
  const current = await fixture();
  try {
    const record = createPhase9bRealtimeObserver(current.profile)!;
    record(observation);
    assert.equal((await lstat(current.path)).mode & 0o777, 0o600);
    const first = await readFile(current.path, "utf8");
    record(observation);
    assert.equal(await readFile(current.path, "utf8"), first);
    createPhase9bRealtimeObserver(current.profile)!({ ...observation, realtimeSessionId: "33333333-3333-7333-8333-333333333333" });
    const report = JSON.parse(await readFile(current.path, "utf8"));
    assert.equal(report.runId, runId);
    assert.equal(report.connections.length, 2);
    assert.deepEqual(Object.keys(report.connections[0]).sort(), [...Object.keys(observation), "observedAtUtc"].sort());
    assert.throws(() => record({ ...observation, transcript: "must not persist" }), /observation is invalid/);
    assert.throws(() => record({ ...observation, remoteAudioTrackCount: 100 }), /observation is invalid/);
    assert.throws(() => record({ ...observation, liveRemoteAudioTrackCount: 2 }), /observation is invalid/);
    assert.equal(JSON.stringify(report).includes(current.root), false);
    for (const prefix of ["44444444", "55555555"]) {
      record({ ...observation, realtimeSessionId: `${prefix}-2222-7222-8222-222222222222` });
    }
    assert.throws(() => record({ ...observation, realtimeSessionId: "66666666-2222-7222-8222-222222222222" }), /observation is invalid/);
  } finally {
    await rm(current.root, { recursive: true, force: true });
  }
});

test("the writer rejects changed ownership markers and linked destinations", async () => {
  const current = await fixture();
  try {
    const record = createPhase9bRealtimeObserver(current.profile)!;
    const outside = join(current.root, "unchanged.txt");
    await writeFile(outside, "unchanged", { mode: 0o600 });
    await symlink(outside, current.path);
    assert.throws(() => record(observation), /observation is invalid/);
    assert.equal(await readFile(outside, "utf8"), "unchanged");
    await rm(current.path);
    await chmod(current.profile.ownerMarkerPath, 0o644);
    assert.throws(() => record(observation));
  } finally {
    await rm(current.root, { recursive: true, force: true });
  }
});
