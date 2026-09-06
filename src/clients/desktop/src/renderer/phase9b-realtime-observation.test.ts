import { strict as assert } from "node:assert";
import { test } from "node:test";
import { projectPhase9bRealtimeConnection } from "./phase9b-realtime-observation.js";

test("connection observation counts live remote audio receivers without reading track or session contents", () => {
  const connection = {
    connectionState: "connected" as const,
    getReceivers: () => [
      { track: { kind: "audio", readyState: "live", get id() { throw new Error("Track identities are outside evidence."); } } },
      { track: { kind: "audio", readyState: "ended" } },
      { track: { kind: "video", readyState: "live" } }
    ]
  };
  assert.deepEqual(projectPhase9bRealtimeConnection("22222222-2222-7222-8222-222222222222", connection), {
    realtimeSessionId: "22222222-2222-7222-8222-222222222222",
    peerConnectionState: "connected",
    remoteAudioTrackCount: 2,
    liveRemoteAudioTrackCount: 1
  });
  assert.equal(projectPhase9bRealtimeConnection("22222222-2222-7222-8222-222222222222", undefined), undefined);
});
