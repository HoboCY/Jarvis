import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { Phase9bLiveProfile } from "./live-profile.js";

const phase9bAdmissionDescriptorEnvironmentVariable = "JARVIS_PHASE9B_ADMISSION_DESCRIPTOR";
const phase9bRealtimeEndpointEnvironmentVariable = "JARVIS_PHASE9B_REALTIME_CALL_URL";
const ownerDirectoryMode = 0o700;
const ownerFileMode = 0o600;
const maximumDescriptorBytes = 16 * 1024;
const maximumTokenBytes = 512;
const maximumResponseBytes = 16 * 1024;
const runIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const tokenPattern = /^[A-Za-z0-9_-]{32,256}$/;
const admissionKinds = new Set<Phase9bBudgetKind>([
  "providerRequests",
  "realtimeConnections",
  "delegationAttempts"
]);

type JsonRecord = Record<string, unknown>;

export type Phase9bBudgetKind =
  | "providerRequests"
  | "realtimeConnections"
  | "delegationAttempts";

export type Phase9bBudgetReservationClient = (
  kind: Phase9bBudgetKind,
  logicalId: string,
  requestKey: string
) => Promise<void>;

export type Phase9bWebRequestDetails = {
  method: string;
  url: string;
};

export type Phase9bHeadersReceivedDetails = {
  url: string;
  statusCode: number;
};

export type Phase9bWebRequestSession = {
  webRequest: {
    onBeforeRequest: (
      filter: { urls: string[] },
      listener: (
        details: Phase9bWebRequestDetails,
        callback: (response: { cancel?: boolean }) => void
      ) => void
      ) => void;
    onHeadersReceived: (
      filter: { urls: string[] },
      listener: (
        details: Phase9bHeadersReceivedDetails,
        callback: (response: { cancel?: boolean }) => void
      ) => void
    ) => void;
  };
};

export type Phase9bLiveBudget = {
  attach: (session: Phase9bWebRequestSession) => void;
  reserve: Phase9bBudgetReservationClient;
};

/**
 * Main-process-only request gate for the exact Azure Realtime WebRTC call.
 * The renderer receives neither the descriptor nor the admission bearer.
 */
export function createPhase9bRealtimeRequestGate(
  reserve: Phase9bBudgetReservationClient,
  trustedEndpoint: string
): Phase9bLiveBudget {
  const endpoint = parseTrustedEndpoint(trustedEndpoint);
  const originPattern = `${endpoint.origin}/*`;
  return Object.freeze({
    reserve,
    attach(session: Phase9bWebRequestSession): void {
      session.webRequest.onBeforeRequest(
        { urls: [originPattern] },
        (details, callback) => {
          if (!isTrustedOrigin(details.url, endpoint)) {
            callback({});
            return;
          }
          if (!isExactRealtimeCall(details, endpoint)) {
            callback({ cancel: true });
            return;
          }

          const logicalId = randomUUID();
          void reserve("providerRequests", logicalId, `desktop-provider:${logicalId}`)
            .then(() => reserve("realtimeConnections", logicalId, `desktop-realtime:${logicalId}`))
            .then(() => callback({}))
            .catch(() => callback({ cancel: true }));
        });
      session.webRequest.onHeadersReceived(
        { urls: [originPattern] },
        (details, callback) => {
          if (!isTrustedOrigin(details.url, endpoint)
              || !Number.isInteger(details.statusCode)
              || details.statusCode < 300
              || details.statusCode >= 400) {
            callback({});
            return;
          }
          callback({ cancel: true });
        });
    }
  });
}

/**
 * Enables the request gate only for the already-validated Phase 9B profile.
 * Ordinary Desktop launches return undefined and retain their existing path.
 */
export function configurePhase9bLiveBudget(
  profile: Phase9bLiveProfile | undefined,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  fetchImpl: typeof fetch = fetch
): Phase9bLiveBudget | undefined {
  if (profile === undefined) {
    return undefined;
  }

  const descriptorPath = environment[phase9bAdmissionDescriptorEnvironmentVariable];
  const realtimeEndpoint = environment[phase9bRealtimeEndpointEnvironmentVariable];
  if (typeof descriptorPath !== "string"
      || !isAbsolute(descriptorPath)
      || typeof realtimeEndpoint !== "string") {
    throw liveBudgetError();
  }

  const reserve = createDescriptorReservationClient(profile, resolve(descriptorPath), fetchImpl);
  return createPhase9bRealtimeRequestGate(reserve, realtimeEndpoint);
}

function createDescriptorReservationClient(
  profile: Phase9bLiveProfile,
  descriptorPath: string,
  fetchImpl: typeof fetch
): Phase9bBudgetReservationClient {
  if (typeof fetchImpl !== "function") {
    throw liveBudgetError();
  }

  return async (kind, logicalId, requestKey) => {
    if (!admissionKinds.has(kind) || !runIdPattern.test(profile.runId) || !runIdPattern.test(logicalId)) {
      throw liveBudgetError();
    }

    const descriptor = readDescriptor(descriptorPath, profile);
    const tokenPath = resolveRelativePath(descriptor.root, descriptor.tokenFile);
    const token = readPrivateToken(tokenPath);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2_000);
    try {
      const response = await fetchImpl(`${descriptor.endpoint}/reserve`, {
        method: "POST",
        redirect: "error",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          schemaVersion: 1,
          runId: profile.runId,
          kind,
          logicalId,
          requestKey,
          amount: 1
        }),
        signal: controller.signal
      });
      const body = await response.text();
      if (!response.ok || body.length > maximumResponseBytes) {
        throw liveBudgetError();
      }
      const reservation = parseReservation(body, profile.runId, kind, logicalId);
      if (reservation === undefined) {
        throw liveBudgetError();
      }
    } catch {
      throw liveBudgetError();
    } finally {
      clearTimeout(timeout);
    }
  };
}

function readDescriptor(descriptorPath: string, profile: Phase9bLiveProfile): {
  root: string;
  endpoint: string;
  tokenFile: string;
} {
  assertPrivateFile(descriptorPath, maximumDescriptorBytes);
  assertNoSymlinkPath(descriptorPath);
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(descriptorPath, "utf8"));
  } catch {
    throw liveBudgetError();
  }

  if (!isRecord(value)
      || sortedKeys(value).join(",") !== "endpoint,ledgerFile,ownerPid,ownerUid,root,runId,schemaVersion,tokenFile"
      || value.schemaVersion !== 1
      || value.runId !== profile.runId
      || typeof value.ownerPid !== "number"
      || !Number.isSafeInteger(value.ownerPid)
      || value.ownerPid <= 0
      || typeof value.ownerUid !== "number"
      || !Number.isSafeInteger(value.ownerUid)
      || value.ownerUid < 0
      || typeof value.root !== "string"
      || !isAbsolute(value.root)
      || typeof value.endpoint !== "string"
      || typeof value.tokenFile !== "string"
      || typeof value.ledgerFile !== "string"
      || !isSafeRelativePath(value.tokenFile)
      || !isSafeRelativePath(value.ledgerFile)) {
    throw liveBudgetError();
  }

  const root = resolve(value.root);
  const descriptorRoot = resolve(dirname(descriptorPath), "..", "..");
  const currentUid = process.getuid?.();
  if (typeof currentUid !== "number"
      || value.ownerUid !== currentUid
      || root !== descriptorRoot
      || !isWithin(root, profile.ownerMarkerPath)) {
    throw liveBudgetError();
  }
  assertPrivateDirectory(root, currentUid);
  assertNoSymlinkPath(root);
  assertPrivateFile(profile.ownerMarkerPath, 4 * 1024, currentUid);
  assertNoSymlinkPath(profile.ownerMarkerPath);
  const marker = assertOwnerMarker(profile.ownerMarkerPath, profile.runId);
  if (marker.pid !== value.ownerPid) {
    throw liveBudgetError();
  }

  let endpoint: URL;
  try {
    endpoint = new URL(value.endpoint);
  } catch {
    throw liveBudgetError();
  }
  if (endpoint.protocol !== "http:"
      || endpoint.hostname !== "127.0.0.1"
      || endpoint.port.length === 0
      || endpoint.pathname !== "/"
      || endpoint.search.length > 0
      || endpoint.hash.length > 0) {
    throw liveBudgetError();
  }

  const tokenPath = resolveRelativePath(root, value.tokenFile);
  const ledgerPath = resolveRelativePath(root, value.ledgerFile);
  assertPrivateFile(tokenPath, maximumTokenBytes, currentUid);
  assertPrivateFile(ledgerPath, 512 * 1024, currentUid);
  assertNoSymlinkPath(tokenPath);
  assertNoSymlinkPath(ledgerPath);
  return { root, endpoint: endpoint.toString().replace(/\/$/, ""), tokenFile: value.tokenFile };
}

function parseReservation(
  text: string,
  runId: string,
  kind: string,
  logicalId: string
): JsonRecord | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value)
      || sortedKeys(value).join(",") !== "amount,kind,logicalId,remaining,replayed,reservationId,runId,schemaVersion,status"
      || value.schemaVersion !== 1
      || value.status !== "RESERVED"
      || value.runId !== runId
      || value.kind !== kind
      || value.logicalId !== logicalId
      || value.amount !== 1
      || typeof value.remaining !== "number"
      || !Number.isSafeInteger(value.remaining)
      || value.remaining < 0
      || typeof value.reservationId !== "string"
      || !runIdPattern.test(value.reservationId)
      || typeof value.replayed !== "boolean") {
    return undefined;
  }
  return value;
}

function readPrivateToken(path: string): string {
  assertPrivateFile(path, maximumTokenBytes);
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw liveBudgetError();
  }
  if (typeof value !== "string" || !tokenPattern.test(value)) {
    throw liveBudgetError();
  }
  return value;
}

function assertOwnerMarker(path: string, runId: string): { pid: number } {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw liveBudgetError();
  }
  if (!isRecord(value)
      || sortedKeys(value).join(",") !== "createdAtUtc,pid,runId,schemaVersion"
      || value.schemaVersion !== 1
      || value.runId !== runId
      || typeof value.pid !== "number"
      || !Number.isSafeInteger(value.pid)
      || value.pid <= 0
      || typeof value.createdAtUtc !== "string"
      || !Number.isFinite(Date.parse(value.createdAtUtc))) {
    throw liveBudgetError();
  }
  return { pid: value.pid };
}

function assertPrivateDirectory(path: string, expectedUid = currentUserId()): void {
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch {
    throw liveBudgetError();
  }
  if (!metadata.isDirectory()
      || metadata.uid !== expectedUid
      || (metadata.mode & 0o777) !== ownerDirectoryMode) {
    throw liveBudgetError();
  }
}

function assertPrivateFile(path: string, maximumBytes: number, expectedUid = currentUserId()): void {
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch {
    throw liveBudgetError();
  }
  if (!metadata.isFile()
      || metadata.uid !== expectedUid
      || (metadata.mode & 0o777) !== ownerFileMode
      || metadata.size > maximumBytes) {
    throw liveBudgetError();
  }
}

function currentUserId(): number {
  const uid = process.getuid?.();
  if (typeof uid !== "number" || !Number.isSafeInteger(uid) || uid < 0) {
    throw liveBudgetError();
  }
  return uid;
}

function assertNoSymlinkPath(path: string): void {
  const absolute = resolve(path);
  let current = "/";
  for (const part of absolute.split("/").filter(Boolean)) {
    current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw liveBudgetError();
      }
    } catch (error) {
      if (isLiveBudgetError(error)) {
        throw error;
      }
      throw liveBudgetError();
    }
  }
}

function resolveRelativePath(root: string, child: string): string {
  if (!isSafeRelativePath(child)) {
    throw liveBudgetError();
  }
  const resolved = resolve(root, child);
  if (!isWithin(root, resolved)) {
    throw liveBudgetError();
  }
  return resolved;
}

function isSafeRelativePath(value: string): boolean {
  return value.length > 0
    && value.length <= 240
    && !isAbsolute(value)
    && !value.includes("\\")
    && value.split("/").every(part => part.length > 0 && part !== "." && part !== "..");
}

function parseTrustedEndpoint(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw liveBudgetError();
  }
  if (url.protocol !== "https:"
      || url.port.length !== 0
      || !url.hostname.endsWith(".openai.azure.com")
      || url.pathname !== "/openai/v1/realtime/calls"
      || url.search.length !== 0
      || url.hash.length !== 0) {
    throw liveBudgetError();
  }
  return url;
}

function isTrustedOrigin(value: string, endpoint: URL): boolean {
  try {
    return new URL(value).origin === endpoint.origin;
  } catch {
    return false;
  }
}

function isExactRealtimeCall(details: Phase9bWebRequestDetails, endpoint: URL): boolean {
  if (details.method.toUpperCase() !== "POST") {
    return false;
  }
  try {
    const url = new URL(details.url);
    return url.href === endpoint.href;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sortedKeys(value: JsonRecord): string[] {
  return Object.keys(value).sort();
}

function isWithin(parent: string, candidate: string): boolean {
  const remainder = relative(resolve(parent), resolve(candidate));
  return remainder !== ".." && !remainder.startsWith("../") && !isAbsolute(remainder);
}

function liveBudgetError(): Error {
  const error = new Error("Phase9B live budget admission failed.");
  error.name = "Phase9bLiveBudgetError";
  return error;
}

function isLiveBudgetError(error: unknown): error is Error {
  return error instanceof Error && error.name === "Phase9bLiveBudgetError";
}
