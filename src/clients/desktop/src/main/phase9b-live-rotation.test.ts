import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  phase9bRotationAfterMsEnvironmentVariable,
  resolvePhase9bLiveRotationPolicy
} from "./phase9b-live-rotation.js";

const profile = {
  runId: "11111111-1111-4111-8111-111111111111",
  userDataDirectory: "/private/tmp/phase9b/desktop-profile",
  ownerMarkerPath: "/private/tmp/phase9b/.phase9b-owner.json"
};

test("ordinary launches have no live rotation bridge, even when an override is present", () => {
  assert.equal(resolvePhase9bLiveRotationPolicy(undefined, {
    [phase9bRotationAfterMsEnvironmentVariable]: "20000"
  }), undefined);
});

test("validated live profiles accept only the bounded 20 to 120 second rotation interval", () => {
  assert.deepEqual(resolvePhase9bLiveRotationPolicy(profile, {
    [phase9bRotationAfterMsEnvironmentVariable]: "20000"
  }), { rotationAfterMs: 20000 });
  assert.deepEqual(resolvePhase9bLiveRotationPolicy(profile, {
    [phase9bRotationAfterMsEnvironmentVariable]: "120000"
  }), { rotationAfterMs: 120000 });
  assert.throws(
    () => resolvePhase9bLiveRotationPolicy(profile, {
      [phase9bRotationAfterMsEnvironmentVariable]: "19999"
    }),
    /rotation interval is invalid/);
  assert.throws(
    () => resolvePhase9bLiveRotationPolicy(profile, {
      [phase9bRotationAfterMsEnvironmentVariable]: "120001"
    }),
    /rotation interval is invalid/);
  assert.throws(
    () => resolvePhase9bLiveRotationPolicy(profile, {
      [phase9bRotationAfterMsEnvironmentVariable]: "20000;document.body"
    }),
    /rotation interval is invalid/);
});

test("a validated live profile without an override keeps the production interval", () => {
  assert.deepEqual(resolvePhase9bLiveRotationPolicy(profile, {}), { rotationAfterMs: 50 * 60 * 1000 });
});
