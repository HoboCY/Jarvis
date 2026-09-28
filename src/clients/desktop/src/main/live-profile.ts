import { lstatSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

export const phase9bLiveFlag = "--phase9b-live";
export const phase9bLiveEnvironmentVariable = "JARVIS_PHASE9B_LIVE";
export const phase9bRunIdEnvironmentVariable = "JARVIS_PHASE9B_RUN_ID";
export const phase9bOwnerMarkerEnvironmentVariable = "JARVIS_PHASE9B_OWNER_MARKER";

const runIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ownerDirectoryMode = 0o700;
const ownerFileMode = 0o600;

export type Phase9bLiveProfile = {
  runId: string;
  userDataDirectory: string;
  ownerMarkerPath: string;
};

export type Phase9bApplication = {
  setName: (name: string) => void;
};

/**
 * Validate the narrow, explicit live launch contract before Electron is ready.
 * The user-data directory and owner marker are created by the harness.
 * Returning undefined keeps ordinary launches on the existing app name and
 * profile, without the optional live observation entry point.
 */
export function resolvePhase9bLiveProfile(
  argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>>
): Phase9bLiveProfile | undefined {
  const liveRequested = argv.includes(phase9bLiveFlag)
    || environment[phase9bLiveEnvironmentVariable] !== undefined
    || environment[phase9bRunIdEnvironmentVariable] !== undefined
    || environment[phase9bOwnerMarkerEnvironmentVariable] !== undefined;
  if (!liveRequested) {
    return undefined;
  }

  if (!argv.includes(phase9bLiveFlag)
      || environment[phase9bLiveEnvironmentVariable] !== "1") {
    throw profileError();
  }

  const userDataArguments = argv.filter(argument => argument.startsWith("--user-data-dir="));
  if (userDataArguments.length !== 1) {
    throw profileError();
  }
  const userDataArgument = userDataArguments.at(0);
  if (userDataArgument === undefined) {
    throw profileError();
  }
  const userDataDirectory = resolve(userDataArgument.slice("--user-data-dir=".length));
  const ownerMarkerPath = requiredAbsolutePath(
    environment[phase9bOwnerMarkerEnvironmentVariable]);
  const runId = environment[phase9bRunIdEnvironmentVariable];
  if (typeof runId !== "string" || !runIdPattern.test(runId)) {
    throw profileError();
  }

  assertPrivatePath(userDataDirectory, ownerDirectoryMode);
  const markerRoot = resolve(dirname(ownerMarkerPath));
  assertPrivatePath(markerRoot, ownerDirectoryMode);
  assertPrivatePath(ownerMarkerPath, ownerFileMode, false);
  const profileRelativePath = relative(markerRoot, userDataDirectory);
  if (profileRelativePath !== "desktop-profile" || !isWithin(markerRoot, userDataDirectory)) {
    throw profileError();
  }

  let marker: unknown;
  try {
    marker = JSON.parse(readFileSync(ownerMarkerPath, "utf8"));
  } catch {
    throw profileError();
  }
  if (!isOwnerMarker(marker, runId)) {
    throw profileError();
  }

  return { runId, userDataDirectory, ownerMarkerPath };
}

/**
 * Set a run-specific Electron name only after the live profile contract has
 * passed. Electron's safeStorage service derives its Keychain service name
 * from app.name, so this call must happen before requestSingleInstanceLock or
 * app.whenReady.
 */
export function configurePhase9bLiveProfile(
  application: Phase9bApplication,
  argv: readonly string[] = process.argv,
  environment: Readonly<Record<string, string | undefined>> = process.env
): Phase9bLiveProfile | undefined {
  const profile = resolvePhase9bLiveProfile(argv, environment);
  if (profile === undefined) {
    return undefined;
  }

  application.setName(`Jarvis Phase9B ${profile.runId}`);
  return profile;
}

function requiredAbsolutePath(value: string | undefined): string {
  if (typeof value !== "string" || !isAbsolute(value)) {
    throw profileError();
  }
  return resolve(value);
}

function assertPrivatePath(path: string, expectedMode: number, directory = true): void {
  assertNoSymlinkPath(path);
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch {
    throw profileError();
  }
  if (directory
      ? !metadata.isDirectory() || (metadata.mode & 0o777) !== expectedMode
      : !metadata.isFile() || (metadata.mode & 0o777) !== expectedMode) {
    throw profileError();
  }
}

function assertNoSymlinkPath(path: string): void {
  const absolute = resolve(path);
  let current = absolute.startsWith("/") ? "/" : "";
  for (const part of absolute.split("/")) {
    if (!part) {
      continue;
    }
    current = current === "/" ? `/${part}` : `${current}/${part}`;
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw profileError();
      }
    } catch (error) {
      if (isProfileError(error)) {
        throw error;
      }
      // A missing path is reported by assertPrivatePath at the final segment;
      // this branch keeps parent validation bounded without following links.
      break;
    }
  }
}

function isOwnerMarker(value: unknown, runId: string): value is {
  schemaVersion: 1;
  runId: string;
  pid: number;
  createdAtUtc: string;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value).sort();
  if (keys.join(",") !== "createdAtUtc,pid,runId,schemaVersion") {
    return false;
  }
  const marker = value as Record<string, unknown>;
  return marker.schemaVersion === 1
    && marker.runId === runId
    && typeof marker.pid === "number"
    && Number.isSafeInteger(marker.pid)
    && marker.pid > 0
    && typeof marker.createdAtUtc === "string"
    && Number.isFinite(Date.parse(marker.createdAtUtc));
}

function isWithin(parent: string, candidate: string): boolean {
  const remainder = relative(resolve(parent), resolve(candidate));
  return remainder !== ".." && !remainder.startsWith("../") && !isAbsolute(remainder);
}

function profileError(): Error {
  const error = new Error("Phase9B live profile is invalid.");
  error.name = "Phase9bLiveProfileError";
  return error;
}

function isProfileError(error: unknown): error is Error {
  return error instanceof Error && error.name === "Phase9bLiveProfileError";
}
