import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { lstat, readFile, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { DEFAULT_BUDGETS } from "./budgets.mjs";
import { writePrivateJson } from "./isolation.mjs";

const SCHEMA_VERSION = 1;
const OWNER_DIRECTORY_MODE = 0o700;
const OWNER_FILE_MODE = 0o600;
const MAX_DESCRIPTOR_BYTES = 16 * 1024;
const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_TOKEN_BYTES = 512;
const MAX_LEDGER_BYTES = 512 * 1024;
const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUEST_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ADMISSION_KINDS = Object.freeze(Object.keys(DEFAULT_BUDGETS));

export { SCHEMA_VERSION as ADMISSION_SCHEMA_VERSION };
export { ADMISSION_KINDS };

/**
 * Create the per-run loopback admission boundary. The server is deliberately
 * a small file-backed authority: all successful reservations are serialized,
 * written, and read back before a response is sent to the caller.
 */
export async function createAdmissionServer({
  root,
  runId,
  limits = {},
  initialUsed = {},
  token,
  port = 0,
  onFatal
} = {}) {
  if (onFatal !== undefined && typeof onFatal !== "function") {
    throw admissionError("ADMISSION_INVALID");
  }
  const safeRoot = await assertOwnedAdmissionRoot(root, runId);
  const normalizedLimits = normalizeLimits(limits);
  const normalizedInitialUsed = normalizeInitialUsed(initialUsed, normalizedLimits);
  const paths = {
    directory: join(safeRoot, "runtime", "admission"),
    descriptor: join(safeRoot, "runtime", "admission", "descriptor.json"),
    token: join(safeRoot, "runtime", "admission", "token.json"),
    ledger: join(safeRoot, "runtime", "admission", "ledger.json")
  };
  for (const path of [paths.descriptor, paths.token, paths.ledger]) {
    const metadata = await lstat(path).catch(() => null);
    if (metadata !== null) {
      throw admissionError("ADMISSION_RESTART_UNSAFE");
    }
  }

  const bearer = token ?? randomBytes(32).toString("hex");
  assertToken(bearer);
  await writePrivateJson(safeRoot, "runtime/admission/token.json", bearer);
  await writePrivateJson(
    safeRoot,
    "runtime/admission/ledger.json",
    createLedger(runId, normalizedLimits, normalizedInitialUsed));

  const server = createServer((request, response) => {
    void handleRequest(request, response);
  });
  let endpoint;
  try {
    await listenLoopback(server, port);
    const address = server.address();
    if (address === null || typeof address === "string" || address.address !== "127.0.0.1") {
      throw admissionError("ADMISSION_UNAVAILABLE");
    }
    endpoint = `http://127.0.0.1:${address.port}`;
    const descriptor = {
      schemaVersion: SCHEMA_VERSION,
      runId,
      ownerPid: process.pid,
      ownerUid: process.getuid?.() ?? -1,
      root: safeRoot,
      endpoint,
      tokenFile: "runtime/admission/token.json",
      ledgerFile: "runtime/admission/ledger.json"
    };
    await writePrivateJson(safeRoot, "runtime/admission/descriptor.json", descriptor);
  } catch (error) {
    await closeServer(server).catch(() => {});
    await unlink(paths.descriptor).catch(() => {});
    await unlink(paths.token).catch(() => {});
    await unlink(paths.ledger).catch(() => {});
    throw error;
  }

  let queue = Promise.resolve();
  let stopped = false;
  let stopPromise;
  let fatalCategory;
  let fatalNotification;
  const notifyFatal = (category) => {
    if (category !== "BUDGET_EXHAUSTED" || fatalNotification !== undefined) {
      return;
    }
    fatalCategory = category;
    if (onFatal === undefined) {
      fatalNotification = Promise.resolve();
      return;
    }
    // Run outside the serialized ledger queue. The callback stops owned
    // processes and must not wait on the request that raised the rejection.
    fatalNotification = new Promise(resolvePromise => {
      queueMicrotask(() => {
        Promise.resolve()
          .then(() => onFatal(category))
          .catch(() => {})
          .finally(resolvePromise);
      });
    });
  };
  const serverResult = {
    descriptorPath: paths.descriptor,
    tokenPath: paths.token,
    ledgerPath: paths.ledger,
    endpoint,
    async stop() {
      if (stopPromise !== undefined) {
        return await stopPromise;
      }
      stopped = true;
      stopPromise = closeServer(server);
      return await stopPromise;
    },
    async waitForFatal() {
      if (fatalNotification !== undefined) {
        await fatalNotification;
      }
    },
    async snapshot() {
      if (stopped) {
        throw admissionError("ADMISSION_UNAVAILABLE");
      }
      await assertOwnedAdmissionRoot(safeRoot, runId);
      return snapshotLedger(await readLedger(paths.ledger, runId));
    },
    getFatalCategory() {
      return fatalCategory;
    }
  };

  async function handleRequest(request, response) {
    setJsonHeaders(response);
    try {
      if (stopped) {
        sendRejection(response, 503, "ADMISSION_UNAVAILABLE");
        return;
      }
      if (request.method === "GET" && request.url === "/health") {
        await assertOwnedAdmissionRoot(safeRoot, runId);
        response.statusCode = 200;
        response.end(JSON.stringify({ schemaVersion: SCHEMA_VERSION, status: "READY" }));
        return;
      }
      if (request.method !== "POST" || request.url !== "/reserve") {
        sendRejection(response, 404, "ADMISSION_INVALID");
        return;
      }
      const authorization = request.headers.authorization;
      if (authorization !== `Bearer ${bearer}`) {
        await drainRequest(request);
        sendRejection(response, 401, "ADMISSION_UNAUTHORIZED");
        return;
      }
      const body = await readBoundedBody(request);
      const input = parseReservationRequest(body, runId);
      const operation = queue.then(async () => {
        await assertOwnedAdmissionRoot(safeRoot, runId);
        if (fatalCategory !== undefined) {
          throw admissionError(fatalCategory);
        }
        const ledger = await readLedger(paths.ledger, runId);
        const existing = ledger.requests.find(item => item.requestKey === input.requestKey);
        if (existing !== undefined) {
          if (existing.kind !== input.kind || existing.logicalId !== input.logicalId || existing.amount !== input.amount) {
            throw admissionError("ADMISSION_INVALID");
          }
          return reservationResponse(ledger, existing, true);
        }
        // `replayed` is durable logical-attempt state, rather than only an
        // idempotency-key replay. A provider handler can be recreated after a
        // process restart; the next wire reservation for the same logical id
        // must still consume the shared retry budget.
        const logicalReplay = ledger.requests.some(item =>
          item.kind === input.kind && item.logicalId === input.logicalId);
        if (ledger.used[input.kind] + input.amount > ledger.limits[input.kind]) {
          fatalCategory = "BUDGET_EXHAUSTED";
          throw admissionError("BUDGET_EXHAUSTED");
        }
        const entry = {
          requestKey: input.requestKey,
          kind: input.kind,
          logicalId: input.logicalId,
          amount: input.amount,
          reservationId: randomUUID()
        };
        const next = {
          schemaVersion: SCHEMA_VERSION,
          runId,
          limits: { ...ledger.limits },
          used: {
            ...ledger.used,
            [input.kind]: ledger.used[input.kind] + input.amount
          },
          requests: [...ledger.requests, entry]
        };
        await writePrivateJson(safeRoot, "runtime/admission/ledger.json", next);
        const readback = await readLedger(paths.ledger, runId);
        const persisted = readback.requests.find(item => item.reservationId === entry.reservationId);
        if (persisted === undefined) {
          throw admissionError("ADMISSION_INTEGRITY");
        }
        return reservationResponse(readback, persisted, logicalReplay);
      });
      queue = operation.catch(() => {});
      const result = await operation;
      response.statusCode = 200;
      response.end(JSON.stringify(result));
    } catch (error) {
      const category = error?.code === "ADMISSION_UNAUTHORIZED"
        ? "ADMISSION_UNAUTHORIZED"
        : error?.code === "BUDGET_EXHAUSTED"
          ? "BUDGET_EXHAUSTED"
          : error?.code === "ADMISSION_UNAVAILABLE"
            ? "ADMISSION_UNAVAILABLE"
            : error?.code === "ADMISSION_INTEGRITY"
              ? "ADMISSION_INTEGRITY"
              : "ADMISSION_INVALID";
      sendRejection(response, category === "BUDGET_EXHAUSTED" ? 409 : category === "ADMISSION_UNAUTHORIZED" ? 401 : 400, category);
      notifyFatal(category);
    }
  }

  Object.defineProperties(serverResult, {
    token: { value: bearer, enumerable: false },
    limits: { value: Object.freeze({ ...normalizedLimits }), enumerable: true }
  });
  return Object.freeze(serverResult);
}

/** Read and validate a descriptor before a trusted process uses it. */
export async function readAdmissionDescriptor(descriptorPath) {
  const path = requireAbsoluteFilePath(descriptorPath);
  const metadata = await lstat(path).catch(() => null);
  if (metadata === null || metadata.isSymbolicLink() || !metadata.isFile()
      || (metadata.mode & 0o777) !== OWNER_FILE_MODE || metadata.size > MAX_DESCRIPTOR_BYTES) {
    throw admissionError("ADMISSION_INVALID");
  }
  let descriptor;
  try {
    descriptor = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw admissionError("ADMISSION_INVALID");
  }
  assertDescriptorShape(descriptor);
  const rootMetadata = await lstat(descriptor.root).catch(() => null);
  if (rootMetadata === null || rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()
      || (rootMetadata.mode & 0o777) !== OWNER_DIRECTORY_MODE
      || rootMetadata.uid !== (process.getuid?.() ?? rootMetadata.uid)) {
    throw admissionError("ADMISSION_OWNERSHIP_INVALID");
  }
  await assertNoSymlinkPath(descriptor.root);
  const marker = await readOwnerMarker(descriptor.root, descriptor.runId);
  if (marker.pid !== descriptor.ownerPid || descriptor.ownerUid !== (process.getuid?.() ?? descriptor.ownerUid)) {
    throw admissionError("ADMISSION_OWNERSHIP_INVALID");
  }
  const tokenPath = resolveRelativePath(descriptor.root, descriptor.tokenFile);
  const ledgerPath = resolveRelativePath(descriptor.root, descriptor.ledgerFile);
  await assertPrivateFile(tokenPath, MAX_TOKEN_BYTES);
  await assertPrivateFile(ledgerPath, MAX_LEDGER_BYTES);
  return Object.freeze({ ...descriptor });
}

export async function readAdmissionToken(descriptorOrPath) {
  const descriptor = typeof descriptorOrPath === "string"
    ? await readAdmissionDescriptor(descriptorOrPath)
    : descriptorOrPath;
  if (descriptor === null || typeof descriptor !== "object") {
    throw admissionError("ADMISSION_INVALID");
  }
  const tokenPath = resolveRelativePath(descriptor.root, descriptor.tokenFile);
  const metadata = await lstat(tokenPath).catch(() => null);
  if (metadata === null || metadata.isSymbolicLink() || !metadata.isFile()
      || (metadata.mode & 0o777) !== OWNER_FILE_MODE || metadata.size > MAX_TOKEN_BYTES) {
    throw admissionError("ADMISSION_INVALID");
  }
  let token;
  try {
    token = JSON.parse(await readFile(tokenPath, "utf8"));
  } catch {
    throw admissionError("ADMISSION_INVALID");
  }
  assertToken(token);
  return token;
}

export function createAdmissionClient({ descriptorPath, token, fetchImpl = globalThis.fetch } = {}) {
  if (typeof descriptorPath !== "string" || !isAbsolute(descriptorPath) || typeof fetchImpl !== "function") {
    throw admissionError("ADMISSION_INVALID");
  }
  return Object.freeze({
    async reserve(input) {
      const descriptor = await readAdmissionDescriptor(descriptorPath);
      const bearer = token ?? await readAdmissionToken(descriptor);
      assertToken(bearer);
      const request = normalizeReservationInput(input, descriptor.runId);
      let response;
      try {
        response = await fetchImpl(`${descriptor.endpoint}/reserve`, {
          method: "POST",
          redirect: "error",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${bearer}`
          },
          body: JSON.stringify({ schemaVersion: SCHEMA_VERSION, runId: descriptor.runId, ...request })
        });
      } catch {
        throw admissionError("ADMISSION_UNAVAILABLE");
      }
      const text = await response.text();
      if (Buffer.byteLength(text, "utf8") > MAX_REQUEST_BYTES) {
        throw admissionError("ADMISSION_INVALID");
      }
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        throw admissionError("ADMISSION_INVALID");
      }
      if (!response.ok) {
        const error = admissionError(payload?.errorCategory);
        throw error;
      }
      assertReservationResponse(payload, descriptor.runId, request);
      return payload;
    }
  });
}

function createLedger(runId, limits, initialUsed) {
  return {
    schemaVersion: SCHEMA_VERSION,
    runId,
    limits: { ...limits },
    used: { ...initialUsed },
    requests: []
  };
}

function normalizeInitialUsed(values, limits) {
  if (values === null || typeof values !== "object" || Array.isArray(values)) {
    throw admissionError("ADMISSION_INVALID");
  }
  const result = Object.fromEntries(ADMISSION_KINDS.map(kind => [kind, 0]));
  for (const [kind, value] of Object.entries(values)) {
    if (!ADMISSION_KINDS.includes(kind) || !Number.isSafeInteger(value) || value < 0
        || value > limits[kind]) {
      throw admissionError("ADMISSION_INVALID");
    }
    result[kind] = value;
  }
  return result;
}

async function readLedger(path, runId) {
  const metadata = await lstat(path).catch(() => null);
  if (metadata === null || metadata.isSymbolicLink() || !metadata.isFile()
      || (metadata.mode & 0o777) !== OWNER_FILE_MODE || metadata.size > MAX_LEDGER_BYTES) {
    throw admissionError("ADMISSION_INTEGRITY");
  }
  let value;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw admissionError("ADMISSION_INTEGRITY");
  }
  assertLedgerShape(value, runId);
  return value;
}

function reservationResponse(ledger, entry, replayed) {
  return {
    schemaVersion: SCHEMA_VERSION,
    status: "RESERVED",
    runId: ledger.runId,
    reservationId: entry.reservationId,
    kind: entry.kind,
    logicalId: entry.logicalId,
    amount: entry.amount,
    remaining: ledger.limits[entry.kind] - ledger.used[entry.kind],
    replayed
  };
}

function snapshotLedger(ledger) {
  const limits = { ...ledger.limits };
  const used = { ...ledger.used };
  const remaining = Object.fromEntries(
    ADMISSION_KINDS.map(kind => [kind, limits[kind] - used[kind]]));
  return { limits, used, remaining };
}

function parseReservationRequest(body, runId) {
  let value;
  try {
    value = JSON.parse(body);
  } catch {
    throw admissionError("ADMISSION_INVALID");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join(",") !== "amount,kind,logicalId,requestKey,runId,schemaVersion"
      || value.schemaVersion !== SCHEMA_VERSION || value.runId !== runId) {
    throw admissionError("ADMISSION_INVALID");
  }
  return normalizeReservationInput({
    amount: value.amount,
    kind: value.kind,
    logicalId: value.logicalId,
    requestKey: value.requestKey
  }, runId, true);
}

function normalizeReservationInput(value, runId, wire = false) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) {
    throw admissionError("ADMISSION_INVALID");
  }
  const keys = Object.keys(value).sort();
  const expectedKeys = wire ? "amount,kind,logicalId,requestKey" : "kind,logicalId,requestKey";
  if (keys.join(",") !== expectedKeys) {
    throw admissionError("ADMISSION_INVALID");
  }
  const amount = wire ? value.amount : 1;
  if (!ADMISSION_KINDS.includes(value.kind)
      || !RUN_ID_PATTERN.test(value.logicalId ?? "")
      || !REQUEST_KEY_PATTERN.test(value.requestKey ?? "")
      || amount !== 1) {
    throw admissionError("ADMISSION_INVALID");
  }
  if (typeof runId !== "string" || !RUN_ID_PATTERN.test(runId)) {
    throw admissionError("ADMISSION_INVALID");
  }
  return {
    kind: value.kind,
    logicalId: value.logicalId,
    requestKey: value.requestKey,
    amount
  };
}

function assertReservationResponse(value, runId, request) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join(",") !== "amount,kind,logicalId,remaining,replayed,reservationId,runId,schemaVersion,status"
      || value.schemaVersion !== SCHEMA_VERSION || value.status !== "RESERVED" || value.runId !== runId
      || value.kind !== request.kind || value.logicalId !== request.logicalId || value.amount !== 1
      || typeof value.reservationId !== "string" || !RUN_ID_PATTERN.test(value.reservationId)
      || typeof value.remaining !== "number" || !Number.isSafeInteger(value.remaining) || value.remaining < 0
      || typeof value.replayed !== "boolean") {
    throw admissionError("ADMISSION_INVALID");
  }
}

function assertDescriptorShape(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join(",") !== "endpoint,ledgerFile,ownerPid,ownerUid,root,runId,schemaVersion,tokenFile"
      || value.schemaVersion !== SCHEMA_VERSION || !RUN_ID_PATTERN.test(value.runId ?? "")
      || !Number.isSafeInteger(value.ownerPid) || value.ownerPid <= 0
      || !Number.isSafeInteger(value.ownerUid) || value.ownerUid < 0
      || typeof value.root !== "string" || !isAbsolute(value.root)
      || typeof value.endpoint !== "string"
      || !/^http:\/\/127\.0\.0\.1:(?:[1-9][0-9]{0,4})$/.test(value.endpoint)
      || !isSafeRelative(value.tokenFile) || !isSafeRelative(value.ledgerFile)) {
    throw admissionError("ADMISSION_INVALID");
  }
  const port = Number(new URL(value.endpoint).port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw admissionError("ADMISSION_INVALID");
  }
}

function assertLedgerShape(value, runId) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join(",") !== "limits,requests,runId,schemaVersion,used"
      || value.schemaVersion !== SCHEMA_VERSION || value.runId !== runId) {
    throw admissionError("ADMISSION_INTEGRITY");
  }
  assertCounterRecord(value.limits, false);
  assertCounterRecord(value.used, true);
  if (!Array.isArray(value.requests) || value.requests.length > 1000) {
    throw admissionError("ADMISSION_INTEGRITY");
  }
  const keys = new Set();
  for (const entry of value.requests) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)
        || Object.keys(entry).sort().join(",") !== "amount,kind,logicalId,requestKey,reservationId"
        || !ADMISSION_KINDS.includes(entry.kind) || entry.amount !== 1
        || !RUN_ID_PATTERN.test(entry.logicalId ?? "") || !RUN_ID_PATTERN.test(entry.reservationId ?? "")
        || !REQUEST_KEY_PATTERN.test(entry.requestKey ?? "") || keys.has(entry.requestKey)) {
      throw admissionError("ADMISSION_INTEGRITY");
    }
    keys.add(entry.requestKey);
  }
}

function assertCounterRecord(value, limits) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join(",") !== ADMISSION_KINDS.slice().sort().join(",")
      || ADMISSION_KINDS.some(kind => !Number.isSafeInteger(value[kind]) || value[kind] < 0
        || limits && value[kind] > DEFAULT_BUDGETS[kind])) {
    throw admissionError("ADMISSION_INTEGRITY");
  }
}

function normalizeLimits(overrides) {
  if (overrides === null || typeof overrides !== "object" || Array.isArray(overrides)) {
    throw admissionError("ADMISSION_INVALID");
  }
  const result = { ...DEFAULT_BUDGETS };
  for (const [kind, value] of Object.entries(overrides)) {
    if (!ADMISSION_KINDS.includes(kind) || !Number.isSafeInteger(value) || value < 0 || value > DEFAULT_BUDGETS[kind]) {
      throw admissionError("ADMISSION_INVALID");
    }
    result[kind] = value;
  }
  return result;
}

async function assertOwnedAdmissionRoot(root, runId) {
  if (typeof root !== "string" || !isAbsolute(root) || !RUN_ID_PATTERN.test(runId ?? "")) {
    throw admissionError("ADMISSION_OWNERSHIP_INVALID");
  }
  const metadata = await lstat(root).catch(() => null);
  if (metadata === null || metadata.isSymbolicLink() || !metadata.isDirectory()
      || (metadata.mode & 0o777) !== OWNER_DIRECTORY_MODE
      || metadata.uid !== (process.getuid?.() ?? metadata.uid)) {
    throw admissionError("ADMISSION_OWNERSHIP_INVALID");
  }
  await assertNoSymlinkPath(root);
  const marker = await readOwnerMarker(root, runId);
  if (marker.pid <= 0) {
    throw admissionError("ADMISSION_OWNERSHIP_INVALID");
  }
  return resolve(root);
}

async function readOwnerMarker(root, runId) {
  const path = join(root, ".phase9b-owner.json");
  const metadata = await lstat(path).catch(() => null);
  if (metadata === null || metadata.isSymbolicLink() || !metadata.isFile()
      || (metadata.mode & 0o777) !== OWNER_FILE_MODE || metadata.size > 4096
      || metadata.uid !== (process.getuid?.() ?? metadata.uid)) {
    throw admissionError("ADMISSION_OWNERSHIP_INVALID");
  }
  let marker;
  try {
    marker = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw admissionError("ADMISSION_OWNERSHIP_INVALID");
  }
  if (marker === null || typeof marker !== "object" || Array.isArray(marker)
      || Object.keys(marker).sort().join(",") !== "createdAtUtc,pid,runId,schemaVersion"
      || marker.schemaVersion !== SCHEMA_VERSION || marker.runId !== runId
      || !Number.isSafeInteger(marker.pid) || marker.pid <= 0
      || typeof marker.createdAtUtc !== "string" || !Number.isFinite(Date.parse(marker.createdAtUtc))) {
    throw admissionError("ADMISSION_OWNERSHIP_INVALID");
  }
  return marker;
}

async function assertPrivateFile(path, maxBytes) {
  const metadata = await lstat(path).catch(() => null);
  if (metadata === null || metadata.isSymbolicLink() || !metadata.isFile()
      || (metadata.mode & 0o777) !== OWNER_FILE_MODE || metadata.size > maxBytes) {
    throw admissionError("ADMISSION_INVALID");
  }
}

function resolveRelativePath(root, path) {
  if (!isSafeRelative(path)) {
    throw admissionError("ADMISSION_INVALID");
  }
  const result = resolve(root, path);
  if (!isWithin(root, result)) {
    throw admissionError("ADMISSION_INVALID");
  }
  return result;
}

function isSafeRelative(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 240
    && !isAbsolute(value) && !value.includes("\\")
    && value.split("/").every(part => part.length > 0 && part !== "." && part !== "..");
}

function isWithin(parent, candidate) {
  const remainder = relative(resolve(parent), resolve(candidate));
  return remainder !== ".." && !remainder.startsWith("../") && !isAbsolute(remainder);
}

async function assertNoSymlinkPath(path) {
  let current = "/";
  for (const part of resolve(path).split("/")) {
    if (part.length === 0) {
      continue;
    }
    current = current === "/" ? `/${part}` : join(current, part);
    const metadata = await lstat(current).catch(() => null);
    if (metadata?.isSymbolicLink() && !isTrustedSystemAlias(current)) {
      throw admissionError("ADMISSION_OWNERSHIP_INVALID");
    }
  }
}

function isTrustedSystemAlias(path) {
  return path === "/tmp" || path === "/var";
}

function requireAbsoluteFilePath(value) {
  if (typeof value !== "string" || !isAbsolute(value)) {
    throw admissionError("ADMISSION_INVALID");
  }
  return resolve(value);
}

function assertToken(value) {
  if (typeof value !== "string" || value.length < 32 || value.length > 256
      || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw admissionError("ADMISSION_INVALID");
  }
}

function setJsonHeaders(response) {
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
}

function sendRejection(response, statusCode, errorCategory) {
  if (response.writableEnded) {
    return;
  }
  response.statusCode = statusCode;
  response.end(JSON.stringify({ schemaVersion: SCHEMA_VERSION, status: "REJECTED", errorCategory }));
}

async function readBoundedBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) {
      throw admissionError("ADMISSION_INVALID");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function drainRequest(request) {
  request.resume();
  await new Promise(resolvePromise => request.once("end", resolvePromise));
}

async function listenLoopback(server, port) {
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw admissionError("ADMISSION_INVALID");
  }
  await new Promise((resolvePromise, reject) => {
    const onError = () => {
      server.off("listening", onListening);
      reject(admissionError("ADMISSION_UNAVAILABLE"));
    };
    const onListening = () => {
      server.off("error", onError);
      resolvePromise();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host: "127.0.0.1", port });
  });
}

async function closeServer(server) {
  if (!server.listening) {
    return;
  }
  server.closeIdleConnections?.();
  server.closeAllConnections?.();
  await new Promise(resolvePromise => server.close(() => resolvePromise()));
}

function admissionError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
