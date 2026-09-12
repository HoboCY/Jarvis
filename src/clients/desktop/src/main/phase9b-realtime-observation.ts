import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isUuid } from "./input-validation.js";
import { resolvePhase9bLiveProfile, type Phase9bLiveProfile } from "./live-profile.js";

const observationFlag = "--phase9b-observe-realtime";
const states = new Set(["new", "connecting", "connected", "disconnected", "failed", "closed"]);
const fields = ["liveRemoteAudioTrackCount", "peerConnectionState", "realtimeSessionId", "remoteAudioTrackCount"];
type Observation = {
  realtimeSessionId: string;
  peerConnectionState: string;
  remoteAudioTrackCount: number;
  liveRemoteAudioTrackCount: number;
};
type RecordedObservation = Observation & { observedAtUtc: string };

export function phase9bObservationArguments(profile: Phase9bLiveProfile | undefined): string[] {
  return profile === undefined ? [] : [observationFlag];
}

/** Records a maximum of four connections, without media, transport IDs, or renderer text. */
export function createPhase9bRealtimeObserver(
  profile: Phase9bLiveProfile | undefined
): ((input: unknown) => void) | undefined {
  if (profile === undefined) {
    return undefined;
  }
  const root = dirname(profile.ownerMarkerPath);
  const path = join(root, "realtime-track-check.json");
  return input => {
    // Revalidate the original ownership contract before each filesystem write.
    resolvePhase9bLiveProfile(["electron", "--phase9b-live", `--user-data-dir=${profile.userDataDirectory}`], {
      JARVIS_PHASE9B_LIVE: "1",
      JARVIS_PHASE9B_RUN_ID: profile.runId,
      JARVIS_PHASE9B_OWNER_MARKER: profile.ownerMarkerPath
    });
    for (const ownedPath of [root, profile.userDataDirectory, profile.ownerMarkerPath]) {
      if (lstatSync(ownedPath).uid !== process.getuid?.()) {
        throw invalidObservation();
      }
    }
    const current = validateObservation(input);
    const connections: RecordedObservation[] = [];
    const existing = lstatSync(path, { throwIfNoEntry: false });
    if (existing !== undefined) {
      if (!existing.isFile() || existing.isSymbolicLink() || existing.uid !== process.getuid?.()
          || (existing.mode & 0o777) !== 0o600 || existing.size > 16 * 1024) {
        throw invalidObservation();
      }
      const report = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      if (Object.keys(report).sort().join(",") !== "connections,runId,schemaVersion"
          || report.schemaVersion !== 1 || report.runId !== profile.runId
          || !Array.isArray(report.connections) || report.connections.length > 4) {
        throw invalidObservation();
      }
      for (const entry of report.connections) {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
          throw invalidObservation();
        }
        const { observedAtUtc, ...value } = entry as Record<string, unknown>;
        if (typeof observedAtUtc !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(observedAtUtc)
            || !Number.isFinite(Date.parse(observedAtUtc))) {
          throw invalidObservation();
        }
        connections.push({ ...validateObservation(value), observedAtUtc });
      }
    }
    const previous = connections.find(entry => entry.realtimeSessionId === current.realtimeSessionId);
    if (previous !== undefined) {
      if (fields.some(field => previous[field as keyof Observation] !== current[field as keyof Observation])) {
        throw invalidObservation();
      }
      return;
    }
    if (connections.length >= 4) {
      throw invalidObservation();
    }
    connections.push({ ...current, observedAtUtc: new Date().toISOString() });
    const temporary = join(root, `.realtime-track-${randomUUID()}.tmp`);
    let descriptor: number | undefined;
    try {
      descriptor = openSync(temporary, "wx", 0o600);
      writeFileSync(descriptor, `${JSON.stringify({ schemaVersion: 1, runId: profile.runId, connections })}\n`);
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporary, path);
      descriptor = openSync(root, "r");
      fsyncSync(descriptor);
    } finally {
      if (descriptor !== undefined) {
        closeSync(descriptor);
      }
      if (existsSync(temporary)) {
        rmSync(temporary);
      }
    }
  };
}

function validateObservation(input: unknown): Observation {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw invalidObservation();
  }
  const value = input as Record<string, unknown>;
  if (Object.keys(value).sort().join(",") !== fields.join(",")
      || typeof value.realtimeSessionId !== "string" || !isUuid(value.realtimeSessionId)
      || typeof value.peerConnectionState !== "string" || !states.has(value.peerConnectionState)
      || !Number.isSafeInteger(value.remoteAudioTrackCount) || (value.remoteAudioTrackCount as number) < 0
      || (value.remoteAudioTrackCount as number) > 8
      || !Number.isSafeInteger(value.liveRemoteAudioTrackCount) || (value.liveRemoteAudioTrackCount as number) < 0
      || (value.liveRemoteAudioTrackCount as number) > (value.remoteAudioTrackCount as number)) {
    throw invalidObservation();
  }
  return value as Observation;
}

function invalidObservation(): Error {
  return new Error("Phase9B realtime observation is invalid.");
}
