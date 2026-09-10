import type { Phase9bLiveProfile } from "./live-profile.js";

export const phase9bRotationAfterMsEnvironmentVariable = "JARVIS_PHASE9B_ROTATION_AFTER_MS";
export const productionRealtimeRotationAfterMs = 50 * 60 * 1000;
const minimumLiveRotationAfterMs = 20 * 1000;
const maximumLiveRotationAfterMs = 120 * 1000;
const decimalMillisecondsPattern = /^(?:0|[1-9][0-9]*)$/;

export type Phase9bLiveRotationPolicy = {
  rotationAfterMs: number;
};

/**
 * The Main process calls this only after the existing live profile has been
 * validated. Ordinary launches deliberately receive no policy and therefore
 * cannot expose a renderer override bridge.
 */
export function resolvePhase9bLiveRotationPolicy(
  profile: Phase9bLiveProfile | undefined,
  environment: Readonly<Record<string, string | undefined>>
): Phase9bLiveRotationPolicy | undefined {
  if (profile === undefined) {
    return undefined;
  }

  const configured = environment[phase9bRotationAfterMsEnvironmentVariable];
  if (configured === undefined) {
    return { rotationAfterMs: productionRealtimeRotationAfterMs };
  }
  if (!decimalMillisecondsPattern.test(configured)) {
    throw invalidRotationPolicy();
  }

  const rotationAfterMs = Number(configured);
  if (!Number.isSafeInteger(rotationAfterMs)
    || rotationAfterMs < minimumLiveRotationAfterMs
    || rotationAfterMs > maximumLiveRotationAfterMs) {
    throw invalidRotationPolicy();
  }
  return { rotationAfterMs };
}

function invalidRotationPolicy(): Error {
  return new Error("Phase9B live rotation interval is invalid.");
}
