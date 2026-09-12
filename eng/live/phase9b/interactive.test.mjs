import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough, Readable, Writable } from "node:stream";
import { test } from "node:test";
import {
  INTERACTIVE_COMMANDS,
  createInteractiveSession as createInteractiveSessionRaw,
  readRuntimeFacts,
  reconcileBudget,
  parseInteractiveCommand,
  runInteractiveCli as runInteractiveCliRaw,
  writeSafeLine
} from "./interactive.mjs";
import { createBudgetTracker } from "./budgets.mjs";
import { createAdmissionClient } from "./admission.mjs";
import { ProcessSupervisor } from "./process-supervisor.mjs";

const RESOLVED_SECURITY_STATUS = "RESOLVED_NO_REUSABLE_CREDENTIAL_EXPOSURE";

function createInteractiveSession(options = {}) {
  return createInteractiveSessionRaw({
    securityRemediationStatus: RESOLVED_SECURITY_STATUS,
    ...options
  });
}

function runInteractiveCli(options = {}) {
  return runInteractiveCliRaw({
    ...options,
    sessionOptions: {
      securityRemediationStatus: RESOLVED_SECURITY_STATUS,
      ...options.sessionOptions
    }
  });
}

const fixtureProvider = {
  openAi: {
    apiKey: "azure-fixture-api-key",
    authenticationMode: "ApiKey",
    baseUrl: "https://fixture-resource.openai.azure.com/openai/v1",
    realtimeModel: "gpt-realtime-2.1-mini",
    realtimeVoice: "alloy",
    safetyIdentifierSalt: "fixture-salt"
  },
  responses: {
    provider: "DeepSeek",
    model: "deepseek-v4-flash",
    summarizerModel: "deepseek-v4-flash"
  },
  deepSeek: {
    apiKey: "deepseek-fixture-api-key",
    baseUrl: "https://api.deepseek.com/"
  }
};

function fixturePreflight() {
  return {
    schemaVersion: 1,
    status: "PASS",
    mode: "offline",
    network: { providerCalls: 2 },
    checks: {
      platform: { status: "PASS", os: "darwin", arch: "arm64", osVersion: "15.6", errors: [] },
      toolchain: { status: "PASS", errors: [], codexSha256Matches: true },
      credentials: { status: "PASS", errors: [], presence: {} },
      provider: { status: "UNVERIFIED" }
    }
  };
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "jarvis-phase9b-interactive-"));
  const repositoryRoot = join(root, "repo");
  const homeDirectory = join(root, "home");
  const baseDirectory = join(root, "safe");
  const desktopAppPath = join(root, "Jarvis.app");
  await mkdir(repositoryRoot);
  await mkdir(homeDirectory);
  await mkdir(baseDirectory);
  await chmod(baseDirectory, 0o700);
  await mkdir(desktopAppPath);
  return { root, repositoryRoot, homeDirectory, baseDirectory, desktopAppPath };
}

function captureOutput() {
  let value = "";
  const output = new Writable({
    write(chunk, _encoding, callback) {
      value += String(chunk);
      callback();
    }
  });
  return { output, value: () => value };
}

async function createFixtureDatabase(path) {
  const sqlite = await import("node:sqlite");
  const database = new sqlite.DatabaseSync(path);
  database.exec(`
    CREATE TABLE RealtimeSessions (ConnectedAtMs INTEGER, ExternalSessionId TEXT);
    CREATE TABLE TaskExecutions (WorkerKind INTEGER, TaskId TEXT, CodexThreadId TEXT, ExternalExecutionId TEXT);
    CREATE TABLE Tasks (WorkerKind INTEGER, CreatedByMessageId TEXT);
    CREATE TABLE Messages (Id TEXT, RealtimeSessionId TEXT);
  `);
  database.prepare("INSERT INTO RealtimeSessions (ConnectedAtMs, ExternalSessionId) VALUES (?, ?)")
    .run(Date.now(), "provider-session");
  database.prepare("INSERT INTO TaskExecutions (WorkerKind) VALUES (1), (1), (2), (2), (2), (2), (2)").run();
  database.exec("UPDATE TaskExecutions SET TaskId = 'task-' || rowid, CodexThreadId = 'thread-' || rowid WHERE WorkerKind = 2");
  database.exec("UPDATE TaskExecutions SET ExternalExecutionId = 'response-' || rowid WHERE WorkerKind = 1");
  database.prepare("INSERT INTO Messages (Id, RealtimeSessionId) VALUES (?, ?), (?, ?)")
    .run("message-1", "realtime-1", "message-2", "realtime-1");
  database.prepare("INSERT INTO Tasks (WorkerKind, CreatedByMessageId) VALUES (?, ?), (?, ?), (?, NULL), (?, NULL), (?, NULL), (?, NULL), (?, NULL)")
    .run(1, "message-1", 1, "message-2", 2, 2, 2, 2, 2);
  database.close();
}

async function reserveFixtureFacts(session, fetchImpl = globalThis.fetch, { codexTasks = 5 } = {}) {
  const client = createAdmissionClient({
    descriptorPath: session.privatePaths.admissionDescriptorPath,
    fetchImpl
  });
  for (let index = 0; index < 4; index += 1) {
    await client.reserve({
      kind: "providerRequests",
      logicalId: randomUUID(),
      requestKey: `fixture-provider:${randomUUID()}`
    });
  }
  await client.reserve({
    kind: "realtimeConnections",
    logicalId: randomUUID(),
    requestKey: `fixture-realtime:${randomUUID()}`
  });
  for (let index = 0; index < 2; index += 1) {
    await client.reserve({
      kind: "delegationAttempts",
      logicalId: randomUUID(),
      requestKey: `fixture-delegation:${randomUUID()}`
    });
  }
  for (let index = 0; index < codexTasks; index += 1) {
    await client.reserve({
      kind: "codexTasks",
      logicalId: randomUUID(),
      requestKey: `fixture-codex:${randomUUID()}`
    });
  }
}

test("interactive command parser accepts only bounded commands and UUIDs", () => {
  assert.deepEqual(INTERACTIVE_COMMANDS, ["prepare", "start", "observe", "stop", "restart", "finish"]);
  assert.deepEqual(parseInteractiveCommand('{"command":"prepare"}'), { command: "prepare" });
  assert.deepEqual(
    parseInteractiveCommand('{"command":"restart","service":"desktop"}'),
    { command: "restart", service: "desktop" }
  );
  const conversationId = randomUUID();
  assert.deepEqual(
    parseInteractiveCommand(`{"command":"observe","conversationId":"${conversationId}"}`),
    { command: "observe", conversationId }
  );
  for (const line of [
    "",
    "prepare",
    '{"command":"run","script":"rm -rf /"}',
    '{"command":"prepare","status":"PASS"}',
    '{"command":"observe","conversationId":"not-a-uuid"}',
    '{"command":"restart"}',
    '{"command":"stop","service":"unknown"}',
    '{"command":"restart","service":"desktop","status":"PASS"}',
    '{"command":"finish","extra":null}',
    "[]"
  ]) {
    assert.throws(() => parseInteractiveCommand(line), (error) => error.code === "INVALID_COMMAND");
  }
});

test("CLI output projection rejects unknown or private fields with a fixed result", () => {
  const capture = captureOutput();
  assert.equal(writeSafeLine(capture.output, {
    schemaVersion: 1,
    status: "FAIL",
    apiKey: "sk-proj-123456789012"
  }), false);
  assert.deepEqual(JSON.parse(capture.value()), {
    schemaVersion: 1,
    status: "FAIL",
    errorCategory: "OUTPUT_REJECTED"
  });
  assert.equal(writeSafeLine(capture.output, {
    schemaVersion: 1,
    status: "PASS",
    timestamp: Date.now()
  }), true);
});

test("interactive prepare blocks before runtime setup when security resolution is omitted", async () => {
  const fixture = await createFixture();
  const session = createInteractiveSessionRaw({
    repositoryRoot: fixture.repositoryRoot,
    homeDirectory: fixture.homeDirectory,
    baseDirectory: fixture.baseDirectory,
    desktopAppPath: fixture.desktopAppPath,
    providerConfig: fixtureProvider,
    preflightResult: fixturePreflight()
  });
  try {
    const prepared = await session.prepare();
    assert.deepEqual(prepared, {
      schemaVersion: 1,
      status: "BLOCKED_SECURITY_REMEDIATION",
      securityRemediation: { status: "BLOCKED_SECURITY_REMEDIATION" },
      errorCategory: "BLOCKED_SECURITY_REMEDIATION"
    });
    assert.equal(session.isolation, undefined);
    assert.equal((await session.finish()).status, "FINISHED");
  } finally {
    await session.finish().catch(() => {});
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("budget reconciliation keeps provider, realtime, delegation, and Codex facts separate", () => {
  const budget = createBudgetTracker();
  const facts = {
    realtimeSecretsIssued: 1,
    realtimeConnections: 1,
    responseRequests: 2,
    delegationAttemptsObserved: 2,
    codexTasks: 5,
    codexStartedTasks: 5,
    codexTaskExecutions: 5
  };
  const reserved = {
    limits: budget.snapshot().limits,
    used: {
      providerRequests: 6,
      realtimeConnections: 1,
      delegationAttempts: 2,
      codexTasks: 5,
      retries: 0
    }
  };
  const projected = reconcileBudget(budget, facts, 2, reserved);

  assert.equal(projected.delegationAttemptsObserved, 2);
  assert.deepEqual(projected.budgetObservation, {
    status: "PASS",
    observed: {
      providerRequests: 6,
      realtimeConnections: 1,
      delegationAttempts: 2,
      codexTasks: 5,
      retries: 0
    },
    reserved
  });
  assert.deepEqual(budget.snapshot().used, {
    providerRequests: 0,
    realtimeConnections: 0,
    delegationAttempts: 0,
    codexTasks: 0,
    retries: 0
  });
  assert.throws(
    () => reconcileBudget(budget, { ...facts, codexTasks: 6 }, 2, reserved),
    error => error.code === "BUDGET_EXHAUSTED"
  );
});

test("queued worker tasks wait for admission while confirmed native and provider facts remain guarded", async () => {
  const fixture = await createFixture();
  const path = join(fixture.baseDirectory, "controlled.db");
  let database;
  try {
    await createFixtureDatabase(path);
    const sqlite = await import("node:sqlite");
    database = new sqlite.DatabaseSync(path);
    database.exec("UPDATE TaskExecutions SET CodexThreadId = NULL WHERE WorkerKind = 2");
    database.exec("UPDATE TaskExecutions SET ExternalExecutionId = NULL WHERE WorkerKind = 1");
    const budget = createBudgetTracker();
    budget.consume("providerRequests", 2);
    budget.consume("realtimeConnections", 1);
    budget.consume("delegationAttempts", 2);
    const waiting = await readRuntimeFacts(path);
    assert.doesNotThrow(() => reconcileBudget(budget, waiting, 0));
    assert.equal(waiting.codexTasks, 5);
    assert.equal(waiting.codexStartedTasks, 0);
    assert.equal(waiting.responseExecutions, 2);
    assert.equal(waiting.responseRequests, 0);
    database.exec("UPDATE TaskExecutions SET ExternalExecutionId = 'controlled-response' WHERE rowid = 1");
    const responseStarted = await readRuntimeFacts(path);
    assert.throws(() => reconcileBudget(budget, responseStarted, 0), error => error.code === "OBSERVATION_INVALID");
    budget.consume("providerRequests");
    assert.doesNotThrow(() => reconcileBudget(budget, responseStarted, 0));
    database.exec("UPDATE TaskExecutions SET CodexThreadId = 'controlled-thread' WHERE rowid = 3");
    const started = await readRuntimeFacts(path);
    assert.equal(started.codexStartedTasks, 1);
    assert.throws(() => reconcileBudget(budget, started, 0), error => error.code === "OBSERVATION_INVALID");
    budget.consume("codexTasks");
    assert.doesNotThrow(() => reconcileBudget(budget, started, 0));
    database.exec("INSERT INTO TaskExecutions (WorkerKind, TaskId, CodexThreadId) VALUES (2, 'task-3', 'controlled-thread')");
    assert.equal((await readRuntimeFacts(path)).codexStartedTasks, 1);
    database.exec("INSERT INTO Tasks (WorkerKind) VALUES (2)");
    const beyondLimit = await readRuntimeFacts(path);
    assert.throws(() => reconcileBudget(budget, beyondLimit, 0), error => error.code === "BUDGET_EXHAUSTED");
  } finally {
    database?.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("prepare references the private provider source without copying keys into runtime configuration or prompt JSON", async () => {
  const fixture = await createFixture();
  const secretValues = [fixtureProvider.openAi.apiKey, fixtureProvider.deepSeek.apiKey, "fresh-local-bearer"];
  try {
    const session = createInteractiveSession({
      repositoryRoot: fixture.repositoryRoot,
      homeDirectory: fixture.homeDirectory,
      baseDirectory: fixture.baseDirectory,
      desktopAppPath: fixture.desktopAppPath,
      providerConfig: fixtureProvider,
      userSecretsPath: join(fixture.homeDirectory, "controlled-provider-source.json"),
      preflightResult: fixturePreflight(),
      secretValues,
      localBearerFactory: () => "fresh-local-bearer"
    });
    const result = await session.prepare();
    assert.equal(result.status, "PREPARED");
    assert.match(result.runId, /^[0-9a-f-]{36}$/);
    assert.equal(result.budgets.used.providerRequests, 2);
    assert.equal(Object.hasOwn(result, "paths"), false);
    assert.equal(Object.hasOwn(result, "nonceFixture"), false);
    assert.equal(typeof session.privatePaths.nonceFixturePath, "string");
    assert.equal(JSON.stringify(result).includes(secretValues[0]), false);
    assert.equal(JSON.stringify(result).includes(secretValues[1]), false);
    assert.equal(JSON.stringify(result).includes(secretValues[2]), false);
    const configText = await readFile(session.privatePaths.apiConfigPath, "utf8");
    assert.equal(configText.includes(secretValues[0]), false);
    assert.equal(configText.includes(secretValues[1]), false);
    const apiConfig = JSON.parse(configText);
    assert.equal(apiConfig.ProviderKeySource.Path, join(fixture.homeDirectory, "controlled-provider-source.json"));
    assert.equal(Object.hasOwn(apiConfig.OpenAI, "ApiKey"), false);
    assert.equal(Object.hasOwn(apiConfig.DeepSeek, "ApiKey"), false);
    assert.equal((await stat(session.privatePaths.apiConfigPath)).mode & 0o777, 0o600);
    assert.equal((await stat(session.isolation.root)).mode & 0o777, 0o700);
    const deviceConfig = JSON.parse(await readFile(session.privatePaths.deviceConfigPath, "utf8"));
    assert.deepEqual(deviceConfig.DeviceNode.CodexArguments, [
      "app-server",
      "-c",
      "features.default_mode_request_user_input=true",
      "-c",
      "features.request_permissions_tool=true"
    ]);
    assert.equal(deviceConfig.DeviceNode.Capabilities.WriteFiles, true);
    assert.deepEqual(deviceConfig.DeviceNode.Capabilities.AllowedRoots, [session.isolation.directories.allowedRoot]);
    await session.finish();
    assert.equal(await session.finish(), false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("targeted product cleanup retains authentication across failed startup and a new runtime", async () => {
  const fixture = await createFixture();
  const authRoot = await mkdtemp(join(await realpath(fixture.baseDirectory), "targeted-auth-fixture-"));
  await chmod(authRoot, 0o700);
  const codexHome = join(authRoot, "codex-home");
  for (const name of ["codex-home", "home", "tmp", "allowed-root"]) {
    await mkdir(join(authRoot, name), { mode: 0o700 });
  }
  await writeFile(join(codexHome, "auth.json"), "controlled-auth-fixture", { mode: 0o600 });
  const metadataPath = join(authRoot, "login-metadata.json");
  const runId = randomUUID();
  await writeFile(metadataPath, JSON.stringify({ schemaVersion: 1, runId, codexHome,
    runtimeRoot: authRoot, allowedRoot: join(authRoot, "allowed-root"), authenticationCompleted: true,
    credentialStore: "file", previousRuntimeReused: false }), { mode: 0o600 });
  await writeFile(join(authRoot, "targeted-auth-retention.json"), JSON.stringify({ schemaVersion: 1, runId,
    purpose: "current-targeted-gap-run", codexHome, metadataPath, authenticationVerified: true,
    retainOnProbeOrProductFailure: true, reuseUntilTargetedRunComplete: true }), { mode: 0o600 });
  const roots = [];
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const session = createInteractiveSession({ repositoryRoot: fixture.repositoryRoot,
        homeDirectory: fixture.homeDirectory, baseDirectory: fixture.baseDirectory,
        desktopAppPath: fixture.desktopAppPath, providerConfig: fixtureProvider,
        preflightResult: fixturePreflight(), targetedAuthMetadataPath: metadataPath,
        codexPath: join(fixture.root, "missing-controlled-executable") });
      try {
        assert.equal((await session.prepare()).status, "PREPARED");
        roots.push(session.isolation.root);
        assert.equal(session.isolation.runtimeEnvironment.CODEX_HOME, codexHome);
        const device = JSON.parse(await readFile(session.privatePaths.deviceConfigPath, "utf8"));
        assert.equal(device.DeviceNode.CodexHome, codexHome);
        await assert.rejects(session.start(), error => error.code === "CODEX_PATH_REQUIRED");
      } finally {
        await session.finish();
      }
      await assert.rejects(stat(roots.at(-1)), { code: "ENOENT" });
      assert.equal((await stat(join(codexHome, "auth.json"))).isFile(), true);
    }
    assert.notEqual(roots[0], roots[1]);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("runtime secret scanning includes only secrets written by this isolation", async () => {
  const fixture = await createFixture();
  const staleSafetyIdentifierSalt = "stale-user-profile-safety-salt";
  const providerConfig = {
    ...fixtureProvider,
    openAi: { ...fixtureProvider.openAi, safetyIdentifierSalt: staleSafetyIdentifierSalt }
  };
  const observedSecretValues = [];
  try {
    const session = createInteractiveSession({
      repositoryRoot: fixture.repositoryRoot,
      homeDirectory: fixture.homeDirectory,
      baseDirectory: fixture.baseDirectory,
      desktopAppPath: fixture.desktopAppPath,
      providerConfig,
      preflightResult: fixturePreflight(),
      codexPath: process.execPath,
      apiBinaryPath: process.execPath,
      deviceNodePath: process.execPath,
      desktopExecutablePath: process.execPath,
      processSupervisor: {
        start: async (_command, _args, options) => {
          observedSecretValues.push(...options.secretValues);
          const error = new Error("fixture start failure");
          error.code = "PROCESS_START_FAILED";
          throw error;
        },
        stopAll: async () => {}
      }
    });
    await session.prepare();
    await assert.rejects(() => session.start(), { code: "PROCESS_START_FAILED" });
    assert.equal(observedSecretValues.includes(staleSafetyIdentifierSalt), false);
    assert.equal(observedSecretValues.includes(providerConfig.openAi.apiKey), true);
    assert.equal(observedSecretValues.includes(providerConfig.deepSeek.apiKey), true);
    assert.equal(observedSecretValues.includes(session.isolation.localBearer), true);
    assert.equal(observedSecretValues.includes(session.isolation.safetyIdentifierSalt), true);
    await session.finish();
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("prepare reports blocked credentials without starting a process or making a request", async () => {
  const fixture = await createFixture();
  let loaderCalls = 0;
  let startCalls = 0;
  try {
    const session = createInteractiveSession({
      repositoryRoot: fixture.repositoryRoot,
      homeDirectory: fixture.homeDirectory,
      baseDirectory: fixture.baseDirectory,
      desktopAppPath: fixture.desktopAppPath,
      preflightResult: {
        ...fixturePreflight(),
        status: "PASS",
        checks: {
          ...fixturePreflight().checks,
          credentials: { status: "PASS", errors: [], presence: {} }
        }
      },
      userSecretsPath: join(fixture.homeDirectory, "controlled-provider-source.json"),
      env: { OpenAI__ApiKey: "must-not-use-ambient-fixture" },
      providerLoader: async (options) => {
        assert.deepEqual(options.env, {});
        assert.equal(options.userSecretsPath, join(fixture.homeDirectory, "controlled-provider-source.json"));
        loaderCalls += 1;
        return { status: "BLOCKED_CREDENTIALS", errors: ["MISSING_OPENAI_API_KEY"], presence: {} };
      },
      processSupervisor: {
        start: async () => {
          startCalls += 1;
          throw new Error("must not start");
        }
      }
    });
    const result = await session.prepare();
    assert.equal(result.status, "BLOCKED_CREDENTIALS");
    assert.equal(loaderCalls, 1);
    assert.equal(startCalls, 0);
    await session.finish();
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("start and observe run only owned fixture services, then finish removes the runtime", async () => {
  const fixture = await createFixture();
  const apiScript = `
    const http = require('node:http');
    const port = Number(new URL(process.env.ASPNETCORE_URLS).port);
    const body = (value) => JSON.stringify(value);
    const server = http.createServer((request, response) => {
      const routes = {
        '/health/live': { healthy: true, status: 'live' },
        '/health/ready': { healthy: true, status: 'ready' },
        '/api/v1/diagnostics': { database: { available: true }, work: { onlineDevices: 1 } },
        '/api/v1/devices': { items: [{ id: 'fixture-device' }] }
      };
      const value = routes[request.url] || { error: 'not-found' };
      response.writeHead(routes[request.url] ? 200 : 404, { 'content-type': 'application/json' });
      response.end(body(value));
    });
    server.listen(port, '127.0.0.1');
    process.on('SIGTERM', () => server.close(() => process.exit(0)));
  `;
  const keepAliveScript = "setInterval(() => {}, 1000);";
  let session;
  try {
    session = createInteractiveSession({
      repositoryRoot: fixture.repositoryRoot,
      homeDirectory: fixture.homeDirectory,
      baseDirectory: fixture.baseDirectory,
      desktopAppPath: fixture.desktopAppPath,
      providerConfig: fixtureProvider,
      preflightResult: fixturePreflight(),
      codexPath: process.execPath,
      apiBinaryPath: process.execPath,
      apiArguments: ["-e", apiScript],
      deviceNodePath: process.execPath,
      deviceNodeArguments: ["-e", keepAliveScript],
      desktopExecutablePath: process.execPath,
      desktopArguments: ["-e", keepAliveScript],
      budgetPollMs: 100
    });
    const prepared = await session.prepare();
    assert.equal(prepared.status, "PREPARED");
    await createFixtureDatabase(join(session.isolation.directories.database, "jarvis.db"));
    const sqlite = await import("node:sqlite");
    const database = new sqlite.DatabaseSync(join(session.isolation.directories.database, "jarvis.db"));
    database.exec("UPDATE TaskExecutions SET CodexThreadId = NULL WHERE WorkerKind = 2");
    database.close();
    await reserveFixtureFacts(session, globalThis.fetch, { codexTasks: 0 });
    const started = await session.start();
    assert.equal(started.status, "STARTED");
    assert.equal(started.budgetGuard.startupProviderRequests, 2);
    assert.equal(started.budgetGuard.startupRealtimeConnections, 1);
    await new Promise(resolve => setTimeout(resolve, 250));
    const queued = await session.observe();
    assert.equal(queued.services.api, "started");
    assert.equal(queued.services.deviceNode, "started");
    assert.equal(queued.services.desktop, "started");
    assert.equal(queued.facts.codexTasks, 5);
    assert.equal(queued.facts.codexStartedTasks, 0);
    assert.equal(queued.budgets.used.codexTasks, 0);
    const admission = createAdmissionClient({ descriptorPath: session.privatePaths.admissionDescriptorPath });
    for (let index = 0; index < 5; index += 1) {
      await admission.reserve({ kind: "codexTasks", logicalId: randomUUID(), requestKey: `fixture-native:${randomUUID()}` });
    }
    const admittedDatabase = new sqlite.DatabaseSync(join(session.isolation.directories.database, "jarvis.db"));
    admittedDatabase.exec("UPDATE TaskExecutions SET CodexThreadId = 'thread-' || rowid WHERE WorkerKind = 2");
    admittedDatabase.close();
    const observed = await session.observe();
    assert.equal(observed.api.live, true);
    assert.equal(observed.api.ready, true);
    assert.equal(observed.device.registered, true);
    assert.equal(observed.facts.realtimeSecretsIssued, 1);
    assert.equal(observed.facts.realtimeConnections, 1);
    assert.equal(observed.facts.delegationAttemptsObserved, 2);
    assert.equal(observed.budgets.used.providerRequests, 6);
    assert.equal(observed.budgets.used.delegationAttempts, 2);
    assert.equal(observed.budgets.used.codexTasks, 5);
    await session.finish();
    await assert.rejects(() => stat(session.isolation.root), { code: "ENOENT" });
  } finally {
    await session?.finish?.().catch(() => {});
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("CLI emitting seam completes the prepare start observe stop restart finish path", async () => {
  const fixture = await createFixture();
  const capture = captureOutput();
  const input = Readable.from([
    '{"command":"prepare"}\n',
    '{"command":"start"}\n',
    '{"command":"observe"}\n',
    '{"command":"stop","service":"desktop"}\n',
    '{"command":"restart","service":"desktop"}\n',
    '{"command":"finish"}\n'
  ]);
  const delegate = new ProcessSupervisor({ maxRestarts: 0, timeoutMs: 30_000, killGraceMs: 1_000 });
  let databaseCreated = false;
  const processSupervisor = {
    start: async (command, args, options) => {
      if (!databaseCreated && options.cwd?.endsWith("/runtime/api")) {
        databaseCreated = true;
        const root = join(options.cwd, "..", "..");
        const databasePath = join(root, "database", "jarvis.db");
        await createFixtureDatabase(databasePath);
        await reserveFixtureFacts({
          privatePaths: { admissionDescriptorPath: join(root, "runtime", "admission", "descriptor.json") }
        });
      }
      return await delegate.start(command, args, options);
    },
    stopAll: () => delegate.stopAll()
  };
  try {
    const result = await runInteractiveCli({
      input,
      output: capture.output,
      sessionOptions: {
        repositoryRoot: fixture.repositoryRoot,
        homeDirectory: fixture.homeDirectory,
        baseDirectory: fixture.baseDirectory,
        desktopAppPath: fixture.desktopAppPath,
        providerConfig: fixtureProvider,
        preflightResult: fixturePreflight(),
        processSupervisor,
        codexPath: process.execPath,
        apiBinaryPath: process.execPath,
        apiArguments: ["-e", `
          const http = require('node:http');
          const port = Number(new URL(process.env.ASPNETCORE_URLS).port);
          const routes = {
            '/health/live': { healthy: true, status: 'live' },
            '/health/ready': { healthy: true, status: 'ready' },
            '/api/v1/diagnostics': { database: { available: true }, work: { onlineDevices: 1 } },
            '/api/v1/devices': { items: [{ id: 'fixture-device' }] }
          };
          const server = http.createServer((request, response) => {
            const value = routes[request.url] || { error: 'not-found' };
            response.writeHead(routes[request.url] ? 200 : 404, { 'content-type': 'application/json' });
            response.end(JSON.stringify(value));
          });
          server.listen(port, '127.0.0.1');
          process.on('SIGTERM', () => server.close(() => process.exit(0)));
        `],
        deviceNodePath: process.execPath,
        deviceNodeArguments: ["-e", "setInterval(() => {}, 1000);"],
        desktopExecutablePath: process.execPath,
        desktopArguments: ["-e", "setInterval(() => {}, 1000);"],
        budgetPollMs: 100
      }
    });
    assert.equal(result.status, "FINISHED");
    const lines = capture.value().trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(lines.map((line) => line.status), [
      "PREPARED", "STARTED", "OBSERVED", "STOPPED", "RESTARTED", "FINISHED"
    ]);
    assert.equal(lines[1].services.api, "ready");
    assert.equal(lines[2].services.api, "started");
    assert.equal(lines[3].services.desktop, "stopped");
    assert.equal(lines[4].services.desktop, "started");
    assert.equal(lines[0].runId, lines.at(-1).runId);
    assert.equal(JSON.stringify(lines).includes(fixture.root), false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("launchd mode owns API and Device Node while Desktop remains foreground supervised", async () => {
  const fixture = await createFixture();
  const originalFetch = globalThis.fetch;
  const deviceId = randomUUID();
  const launchdCalls = [];
  const installed = new Set();
  const launchdSupervisor = {
    labels: {
      api: "com.hobocy.jarvis.phase9b.fixture.api",
      device: "com.hobocy.jarvis.phase9b.fixture.device"
    },
    startService: async (kind) => {
      launchdCalls.push(`start:${kind}`);
      installed.add(kind);
    },
    stopAll: async () => {
      launchdCalls.push("stopAll");
      installed.clear();
    },
    isInstalled: (kind) => installed.has(kind),
    registerSecret: (value) => {
      assert.equal(value, "device-fixture-credential");
    }
  };
  const desktopHandles = [];
  const processSupervisor = {
    start: async (_command, _args, options) => {
      assert.equal(options.env.JARVIS_PHASE9B_LIVE, "1");
      assert.equal(options.env.JARVIS_PHASE9B_ROTATION_AFTER_MS, "45000");
      const handle = { isRunning: () => true, stop: async () => {} };
      desktopHandles.push(handle);
      return handle;
    },
    stopAll: async () => {
      for (const handle of desktopHandles) {
        await handle.stop();
      }
    }
  };
  let session;
  try {
    globalThis.fetch = async (url) => {
      const path = new URL(url).pathname;
      if (path === "/health/live") {
        return new Response(JSON.stringify({ healthy: true, status: "live" }), { status: 200 });
      }
      if (path === "/health/ready") {
        return new Response(JSON.stringify({ healthy: true, status: "ready" }), { status: 200 });
      }
      if (path === "/api/v1/diagnostics") {
        return new Response(JSON.stringify({ database: { available: true }, work: { onlineDevices: 1 } }), { status: 200 });
      }
      if (path === "/api/v1/devices") {
        return new Response(JSON.stringify({ items: [{ deviceId, status: "online" }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: "not-found" }), { status: 404 });
    };
    session = createInteractiveSession({
      repositoryRoot: fixture.repositoryRoot,
      homeDirectory: fixture.homeDirectory,
      baseDirectory: fixture.baseDirectory,
      desktopAppPath: fixture.desktopAppPath,
      providerConfig: fixtureProvider,
      preflightResult: fixturePreflight(),
      launchdSupervisor,
      processSupervisor,
      rotationAfterMs: 45_000,
      codexPath: process.execPath,
      apiBinaryPath: process.execPath,
      deviceNodePath: process.execPath,
      desktopExecutablePath: process.execPath,
      budgetPollMs: 100
    });
    await session.prepare();
    await writeFile(
      session.privatePaths.deviceIdentityPath,
      JSON.stringify({ deviceId, deviceCredential: "device-fixture-credential" }),
      { mode: 0o600 }
    );
    await createFixtureDatabase(join(session.isolation.directories.database, "jarvis.db"));
    await reserveFixtureFacts(session, originalFetch);

    const started = await session.start();
    assert.equal(started.installation.mode, "launchd-api-device-owned-desktop");
    assert.equal(started.installation.status, "PASS");
    assert.deepEqual(launchdCalls.slice(0, 2), ["start:api", "start:device"]);
    assert.equal(desktopHandles.length, 1);

    const observed = await session.observe();
    assert.equal(observed.services.api, "started");
    assert.equal(observed.services.deviceNode, "started");
    assert.equal(observed.services.desktop, "started");

    await session.finish();
    assert.equal(launchdCalls.at(-1), "stopAll");
  } finally {
    globalThis.fetch = originalFetch;
    await session?.finish?.().catch(() => {});
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("live rotation override rejects invalid intervals before runtime preparation", () => {
  for (const rotationAfterMs of [null, "45000", 19_999, 120_001, 45_000.5, NaN, Infinity]) {
    assert.throws(() => createInteractiveSession({ rotationAfterMs }), { code: "INVALID_COMMAND" });
  }
  for (const rotationAfterMs of [undefined, 20_000, 120_000]) {
    assert.doesNotThrow(() => createInteractiveSession({ rotationAfterMs }));
  }
});

test("desktop restart reuses the isolated profile and reads the encrypted bearer", async () => {
  const fixture = await createFixture();
  const originalFetch = globalThis.fetch;
  const deviceId = randomUUID();
  const launchdCalls = [];
  const desktopStarts = [];
  let desktopStops = 0;
  const launchdSupervisor = {
    labels: {
      api: "com.hobocy.jarvis.phase9b.restart.api",
      device: "com.hobocy.jarvis.phase9b.restart.device"
    },
    startService: async kind => launchdCalls.push(`start:${kind}`),
    stopService: async kind => launchdCalls.push(`stop:${kind}`),
    stopAll: async () => launchdCalls.push("stopAll"),
    serviceState: async kind => ({
      kind,
      exists: true,
      owned: true,
      running: true
    }),
    isInstalled: () => true,
    registerSecret: () => {}
  };
  const processSupervisor = {
    start: async (_command, _args, options) => {
      desktopStarts.push(Object.hasOwn(options.env, "JARVIS_LOCAL_BEARER"));
      return {
        isRunning: () => true,
        stop: async () => { desktopStops += 1; }
      };
    },
    stopAll: async () => {}
  };
  let session;
  try {
    globalThis.fetch = async url => {
      const path = new URL(url).pathname;
      if (path === "/health/ready") {
        return new Response(JSON.stringify({ healthy: true, status: "ready" }), { status: 200 });
      }
      if (path === "/api/v1/devices") {
        return new Response(JSON.stringify({ items: [{ deviceId, status: "online" }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ healthy: true, status: "live" }), { status: 200 });
    };
    session = createInteractiveSession({
      repositoryRoot: fixture.repositoryRoot,
      homeDirectory: fixture.homeDirectory,
      baseDirectory: fixture.baseDirectory,
      desktopAppPath: fixture.desktopAppPath,
      providerConfig: fixtureProvider,
      preflightResult: fixturePreflight(),
      launchdSupervisor,
      processSupervisor,
      codexPath: process.execPath,
      apiBinaryPath: process.execPath,
      deviceNodePath: process.execPath,
      desktopExecutablePath: process.execPath,
      budgetPollMs: 100
    });
    await session.prepare();
    await writeFile(
      session.privatePaths.deviceIdentityPath,
      JSON.stringify({ deviceId, deviceCredential: "device-restart-credential" }),
      { mode: 0o600 }
    );
    await session.start();

    const restarted = await session.restart("desktop");
    assert.equal(restarted.status, "RESTARTED");
    assert.equal(restarted.service, "desktop");
    assert.deepEqual(desktopStarts, [true, false]);
    assert.equal(desktopStops, 1);
    assert.deepEqual(launchdCalls, ["start:api", "start:device"]);
    assert.equal(Object.hasOwn(restarted, "bearer"), false);
  } finally {
    globalThis.fetch = originalFetch;
    await session?.finish?.().catch(() => {});
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("launchd readiness waits through an owned starting state", async () => {
  const fixture = await createFixture();
  const originalFetch = globalThis.fetch;
  const deviceId = randomUUID();
  const stateQueues = new Map([
    ["api", [{ exists: true, owned: true, running: false }, { exists: true, owned: true, running: true }]],
    ["device", [{ exists: true, owned: true, running: false }, { exists: true, owned: true, running: true }]]
  ]);
  const serviceStateCalls = [];
  const launchdSupervisor = {
    labels: {
      api: "com.hobocy.jarvis.phase9b.starting.api",
      device: "com.hobocy.jarvis.phase9b.starting.device"
    },
    startService: async () => {},
    serviceState: async (kind) => {
      serviceStateCalls.push(kind);
      const states = stateQueues.get(kind);
      return states.length > 0 ? states.shift() : { exists: true, owned: true, running: true };
    },
    stopAll: async () => {},
    isInstalled: () => true,
    registerSecret: () => {}
  };
  const processSupervisor = {
    start: async () => ({ isRunning: () => true, stop: async () => {} }),
    stopAll: async () => {}
  };
  let session;
  try {
    globalThis.fetch = async (url) => {
      const path = new URL(url).pathname;
      if (path === "/health/ready") {
        return new Response(JSON.stringify({ healthy: true, status: "ready" }), { status: 200 });
      }
      if (path === "/api/v1/devices") {
        return new Response(JSON.stringify({ items: [{ deviceId, status: "online" }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ healthy: true, status: "live", database: { available: true }, work: { onlineDevices: 1 } }), { status: 200 });
    };
    session = createInteractiveSession({
      repositoryRoot: fixture.repositoryRoot,
      homeDirectory: fixture.homeDirectory,
      baseDirectory: fixture.baseDirectory,
      desktopAppPath: fixture.desktopAppPath,
      providerConfig: fixtureProvider,
      preflightResult: fixturePreflight(),
      launchdSupervisor,
      processSupervisor,
      codexPath: process.execPath,
      apiBinaryPath: process.execPath,
      deviceNodePath: process.execPath,
      desktopExecutablePath: process.execPath,
      budgetPollMs: 100
    });
    await session.prepare();
    await writeFile(
      session.privatePaths.deviceIdentityPath,
      JSON.stringify({ deviceId, deviceCredential: "device-starting-credential" }),
      { mode: 0o600 }
    );
    const started = await session.start();
    assert.equal(started.installation.status, "PASS");
    assert.equal(serviceStateCalls.filter((kind) => kind === "api").length >= 2, true);
    assert.equal(serviceStateCalls.filter((kind) => kind === "device").length >= 2, true);
  } finally {
    globalThis.fetch = originalFetch;
    await session?.finish?.().catch(() => {});
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a failed launchd start reuses the owned supervisor on retry", async () => {
  const fixture = await createFixture();
  const originalFetch = globalThis.fetch;
  const deviceId = randomUUID();
  const loaded = new Set();
  const supervisors = [];
  let launchdStopCalls = 0;
  const processSupervisor = {
    start: async () => {
      const error = new Error("desktop fixture failure");
      error.code = "PROCESS_START_FAILED";
      throw error;
    },
    stopAll: async () => {}
  };
  let session;
  try {
    globalThis.fetch = async (url) => {
      const path = new URL(url).pathname;
      if (path === "/health/ready") {
        return new Response(JSON.stringify({ healthy: true, status: "ready" }), { status: 200 });
      }
      if (path === "/api/v1/devices") {
        return new Response(JSON.stringify({ items: [{ deviceId, status: "online" }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ healthy: true, status: "live" }), { status: 200 });
    };
    session = createInteractiveSession({
      repositoryRoot: fixture.repositoryRoot,
      homeDirectory: fixture.homeDirectory,
      baseDirectory: fixture.baseDirectory,
      desktopAppPath: fixture.desktopAppPath,
      providerConfig: fixtureProvider,
      preflightResult: fixturePreflight(),
      launchdSupervisorFactory: async () => {
        const supervisor = {
          labels: {
            api: "com.hobocy.jarvis.phase9b.retry.api",
            device: "com.hobocy.jarvis.phase9b.retry.device"
          },
          startService: async (kind) => {
            if (loaded.has(kind) && !supervisor.isInstalled(kind)) {
              const error = new Error("foreign loaded service");
              error.code = "LAUNCHD_OWNERSHIP_INVALID";
              throw error;
            }
            loaded.add(kind);
          },
          stopAll: async () => {
            launchdStopCalls += 1;
            loaded.clear();
          },
          isInstalled: (kind) => supervisor.installed?.has(kind) === true,
          installed: new Set(),
          registerSecret: () => {}
        };
        const originalStart = supervisor.startService;
        supervisor.startService = async (kind) => {
          await originalStart(kind);
          supervisor.installed.add(kind);
        };
        supervisors.push(supervisor);
        return supervisor;
      },
      processSupervisor,
      codexPath: process.execPath,
      apiBinaryPath: process.execPath,
      deviceNodePath: process.execPath,
      desktopExecutablePath: process.execPath
    });
    await session.prepare();
    await writeFile(
      session.privatePaths.deviceIdentityPath,
      JSON.stringify({ deviceId, deviceCredential: "device-retry-credential" }),
      { mode: 0o600 }
    );
    await assert.rejects(() => session.start(), { code: "PROCESS_START_FAILED" });
    assert.equal(launchdStopCalls, 1);
    await assert.rejects(() => session.start(), { code: "PROCESS_START_FAILED" });
    assert.equal(launchdStopCalls, 2);
    assert.equal(supervisors.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    await session?.finish?.().catch(() => {});
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a start cleanup failure keeps the owned runtime for a later finish retry", async () => {
  const fixture = await createFixture();
  const originalFetch = globalThis.fetch;
  const deviceId = randomUUID();
  let launchdStopCalls = 0;
  const launchdSupervisor = {
    labels: {
      api: "com.hobocy.jarvis.phase9b.start-cleanup.api",
      device: "com.hobocy.jarvis.phase9b.start-cleanup.device"
    },
    startService: async () => {},
    stopAll: async () => {
      launchdStopCalls += 1;
      if (launchdStopCalls === 1) {
        throw new Error("fixture launchd stop failure");
      }
    },
    isInstalled: () => true,
    registerSecret: () => {}
  };
  const processSupervisor = {
    start: async () => {
      const error = new Error("fixture desktop start failure");
      error.code = "PROCESS_START_FAILED";
      throw error;
    },
    stopAll: async () => {}
  };
  let session;
  try {
    globalThis.fetch = async (url) => {
      const path = new URL(url).pathname;
      if (path === "/health/ready") {
        return new Response(JSON.stringify({ healthy: true, status: "ready" }), { status: 200 });
      }
      if (path === "/api/v1/devices") {
        return new Response(JSON.stringify({ items: [{ deviceId, status: "online" }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ healthy: true, status: "live" }), { status: 200 });
    };
    session = createInteractiveSession({
      repositoryRoot: fixture.repositoryRoot,
      homeDirectory: fixture.homeDirectory,
      baseDirectory: fixture.baseDirectory,
      desktopAppPath: fixture.desktopAppPath,
      providerConfig: fixtureProvider,
      preflightResult: fixturePreflight(),
      launchdSupervisor,
      processSupervisor,
      codexPath: process.execPath,
      apiBinaryPath: process.execPath,
      deviceNodePath: process.execPath,
      desktopExecutablePath: process.execPath
    });
    await session.prepare();
    await writeFile(
      session.privatePaths.deviceIdentityPath,
      JSON.stringify({ deviceId, deviceCredential: "device-start-cleanup-credential" }),
      { mode: 0o600 }
    );

    await assert.rejects(() => session.start(), { code: "CLEANUP_FAILED" });
    assert.equal(launchdStopCalls, 1);
    assert.equal(await stat(session.isolation.root).then(() => true), true);
    assert.equal(await stat(join(session.isolation.root, ".phase9b-owner.json")).then(() => true), true);

    const finished = await session.finish();
    assert.equal(finished.status, "FINISHED");
    assert.equal(launchdStopCalls, 2);
    await assert.rejects(() => stat(session.isolation.root), { code: "ENOENT" });
  } finally {
    globalThis.fetch = originalFetch;
    await session?.finish?.().catch(() => {});
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("budget failure stops launchd and Desktop independently before finish reports cleanup failure", async () => {
  const fixture = await createFixture();
  const originalFetch = globalThis.fetch;
  const deviceId = randomUUID();
  let launchdStopCalls = 0;
  let desktopStopCalls = 0;
  const launchdSupervisor = {
    labels: {
      api: "com.hobocy.jarvis.phase9b.budget.api",
      device: "com.hobocy.jarvis.phase9b.budget.device"
    },
    startService: async () => {},
    stopAll: async () => {
      launchdStopCalls += 1;
      throw new Error("fixture launchd cleanup failure");
    },
    isInstalled: () => true,
    registerSecret: () => {}
  };
  const processSupervisor = {
    start: async () => ({ isRunning: () => true, stop: async () => {} }),
    stopAll: async () => {
      desktopStopCalls += 1;
    }
  };
  let session;
  try {
    globalThis.fetch = async (url) => {
      const path = new URL(url).pathname;
      if (path === "/health/ready") {
        return new Response(JSON.stringify({ healthy: true, status: "ready" }), { status: 200 });
      }
      if (path === "/api/v1/devices") {
        return new Response(JSON.stringify({ items: [{ deviceId, status: "online" }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ healthy: true, status: "live" }), { status: 200 });
    };
    session = createInteractiveSession({
      repositoryRoot: fixture.repositoryRoot,
      homeDirectory: fixture.homeDirectory,
      baseDirectory: fixture.baseDirectory,
      desktopAppPath: fixture.desktopAppPath,
      providerConfig: fixtureProvider,
      preflightResult: fixturePreflight(),
      budgetOptions: { providerRequests: 5 },
      budgetPollMs: 100,
      launchdSupervisor,
      processSupervisor,
      codexPath: process.execPath,
      apiBinaryPath: process.execPath,
      deviceNodePath: process.execPath,
      desktopExecutablePath: process.execPath
    });
    await session.prepare();
    await writeFile(
      session.privatePaths.deviceIdentityPath,
      JSON.stringify({ deviceId, deviceCredential: "device-budget-credential" }),
      { mode: 0o600 }
    );
    await createFixtureDatabase(join(session.isolation.directories.database, "jarvis.db"));
    await session.start();

    const deadline = Date.now() + 2_000;
    while ((launchdStopCalls === 0 || desktopStopCalls === 0) && Date.now() < deadline) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    }
    assert.equal(launchdStopCalls > 0, true);
    assert.equal(desktopStopCalls > 0, true);
    await assert.rejects(() => session.observe(), { code: "OBSERVATION_INVALID" });
    await assert.rejects(() => session.finish(), { code: "CLEANUP_FAILED" });
  } finally {
    globalThis.fetch = originalFetch;
    await session?.finish?.().catch(() => {});
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("admission exhaustion stops every owned runtime before finish", async () => {
  const fixture = await createFixture();
  const originalFetch = globalThis.fetch;
  const deviceId = randomUUID();
  let launchdStopCalls = 0;
  let desktopStopCalls = 0;
  const launchdSupervisor = {
    labels: {
      api: "com.hobocy.jarvis.phase9b.admission-fatal.api",
      device: "com.hobocy.jarvis.phase9b.admission-fatal.device"
    },
    startService: async () => {},
    stopAll: async () => {
      launchdStopCalls += 1;
    },
    isInstalled: () => true,
    registerSecret: () => {}
  };
  const processSupervisor = {
    start: async () => ({ isRunning: () => true, stop: async () => {} }),
    stopAll: async () => {
      desktopStopCalls += 1;
    }
  };
  let session;
  try {
    globalThis.fetch = async (url) => {
      const path = new URL(url).pathname;
      if (path === "/health/ready") {
        return new Response(JSON.stringify({ healthy: true, status: "ready" }), { status: 200 });
      }
      if (path === "/api/v1/devices") {
        return new Response(JSON.stringify({ items: [{ deviceId, status: "online" }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ healthy: true, status: "live" }), { status: 200 });
    };
    session = createInteractiveSession({
      repositoryRoot: fixture.repositoryRoot,
      homeDirectory: fixture.homeDirectory,
      baseDirectory: fixture.baseDirectory,
      desktopAppPath: fixture.desktopAppPath,
      providerConfig: fixtureProvider,
      preflightResult: fixturePreflight(),
      budgetOptions: { providerRequests: 4 },
      launchdSupervisor,
      processSupervisor,
      codexPath: process.execPath,
      apiBinaryPath: process.execPath,
      deviceNodePath: process.execPath,
      desktopExecutablePath: process.execPath
    });
    await session.prepare();
    await writeFile(
      session.privatePaths.deviceIdentityPath,
      JSON.stringify({ deviceId, deviceCredential: "device-admission-fatal-credential" }),
      { mode: 0o600 }
    );
    const descriptor = createAdmissionClient({
      descriptorPath: session.privatePaths.admissionDescriptorPath,
      fetchImpl: originalFetch
    });
    await session.start();
    const logicalId = randomUUID();
    await descriptor.reserve({
      kind: "providerRequests",
      logicalId,
      requestKey: `provider:${randomUUID()}`
    });
    await descriptor.reserve({
      kind: "providerRequests",
      logicalId: randomUUID(),
      requestKey: `provider:${randomUUID()}`
    });
    await assert.rejects(
      () => descriptor.reserve({
        kind: "providerRequests",
        logicalId: randomUUID(),
        requestKey: `provider:${randomUUID()}`
      }),
      error => error.code === "BUDGET_EXHAUSTED"
    );
    const deadline = Date.now() + 2_000;
    while ((launchdStopCalls === 0 || desktopStopCalls === 0) && Date.now() < deadline) {
      await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
    }
    assert.equal(launchdStopCalls > 0, true);
    assert.equal(desktopStopCalls > 0, true);
    const finished = await session.finish();
    assert.equal(finished.status, "LIVE_BUDGET_EXHAUSTED");
    assert.equal(finished.errorCategory, "BUDGET_EXHAUSTED");
    assert.equal(finished.cleaned, true);
    assert.equal(finished.budgets.used.providerRequests, 4);
  } finally {
    globalThis.fetch = originalFetch;
    await session?.finish?.().catch(() => {});
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("budget exhaustion keeps its canonical terminal status when cleanup fails", async () => {
  const fixture = await createFixture();
  const processSupervisor = {
    start: async () => ({ isRunning: () => true, stop: async () => {} }),
    stopAll: async () => {
      throw new Error("fixture stop failure");
    }
  };
  let session;
  try {
    session = createInteractiveSession({
      repositoryRoot: fixture.repositoryRoot,
      homeDirectory: fixture.homeDirectory,
      baseDirectory: fixture.baseDirectory,
      desktopAppPath: fixture.desktopAppPath,
      providerConfig: fixtureProvider,
      preflightResult: fixturePreflight(),
      budgetOptions: { providerRequests: 2 },
      processSupervisor,
      codexPath: process.execPath,
      apiBinaryPath: process.execPath,
      deviceNodePath: process.execPath,
      desktopExecutablePath: process.execPath
    });
    await session.prepare();
    await assert.rejects(() => session.start(), error => error.code === "BUDGET_EXHAUSTED");

    const finished = await session.finish();
    assert.equal(finished.status, "LIVE_BUDGET_EXHAUSTED");
    assert.equal(finished.errorCategory, "BUDGET_EXHAUSTED");
    assert.equal(finished.cleanupErrorCategory, "CLEANUP_FAILED");
    assert.equal(finished.cleaned, false);
    assert.equal(await stat(session.isolation.root).then(() => true), true);
  } finally {
    await session?.finish?.().catch(() => {});
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("finish retains the owned runtime after stop failure and cleans it on retry", async () => {
  const fixture = await createFixture();
  const originalFetch = globalThis.fetch;
  const deviceId = randomUUID();
  let launchdStopCalls = 0;
  const launchdSupervisor = {
    labels: {
      api: "com.hobocy.jarvis.phase9b.finish.api",
      device: "com.hobocy.jarvis.phase9b.finish.device"
    },
    startService: async () => {},
    stopAll: async () => {
      launchdStopCalls += 1;
      if (launchdStopCalls === 1) {
        throw new Error("fixture launchd stop failure");
      }
    },
    isInstalled: () => true,
    registerSecret: () => {}
  };
  const processSupervisor = {
    start: async () => ({ isRunning: () => true, stop: async () => {} }),
    stopAll: async () => {}
  };
  let session;
  try {
    globalThis.fetch = async (url) => {
      const path = new URL(url).pathname;
      if (path === "/health/ready") {
        return new Response(JSON.stringify({ healthy: true, status: "ready" }), { status: 200 });
      }
      if (path === "/api/v1/devices") {
        return new Response(JSON.stringify({ items: [{ deviceId, status: "online" }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ healthy: true, status: "live" }), { status: 200 });
    };
    session = createInteractiveSession({
      repositoryRoot: fixture.repositoryRoot,
      homeDirectory: fixture.homeDirectory,
      baseDirectory: fixture.baseDirectory,
      desktopAppPath: fixture.desktopAppPath,
      providerConfig: fixtureProvider,
      preflightResult: fixturePreflight(),
      launchdSupervisor,
      processSupervisor,
      codexPath: process.execPath,
      apiBinaryPath: process.execPath,
      deviceNodePath: process.execPath,
      desktopExecutablePath: process.execPath
    });
    await session.prepare();
    await writeFile(
      session.privatePaths.deviceIdentityPath,
      JSON.stringify({ deviceId, deviceCredential: "device-finish-credential" }),
      { mode: 0o600 }
    );
    await createFixtureDatabase(join(session.isolation.directories.database, "jarvis.db"));
    await session.start();
    const launchdDirectory = join(session.isolation.root, "launchd");
    const plistPath = join(launchdDirectory, "api.plist");
    await mkdir(launchdDirectory, { recursive: true, mode: 0o700 });
    await writeFile(plistPath, "owned fixture plist\n", { mode: 0o600 });

    await assert.rejects(() => session.finish(), { code: "CLEANUP_FAILED" });
    assert.equal(await stat(session.isolation.root).then(() => true), true);
    assert.equal(await stat(join(session.isolation.root, ".phase9b-owner.json")).then(() => true), true);
    assert.equal(await stat(plistPath).then(() => true), true);

    const finished = await session.finish();
    assert.equal(finished.status, "FINISHED");
    await assert.rejects(() => stat(session.isolation.root), { code: "ENOENT" });
  } finally {
    globalThis.fetch = originalFetch;
    await session?.finish?.().catch(() => {});
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("observe rejects a known secret in a non-JSON API body before parsing it", async () => {
  const fixture = await createFixture();
  const originalFetch = globalThis.fetch;
  const handles = [];
  const processSupervisor = {
    start: async () => {
      const handle = { isRunning: () => true, stop: async () => {} };
      handles.push(handle);
      return handle;
    },
    stopAll: async () => {
      for (const handle of handles) {
        await handle.stop();
      }
    }
  };
  globalThis.fetch = async (url) => {
    const path = new URL(url).pathname;
    if (path === "/health/live") {
      return new Response(JSON.stringify({ healthy: true, status: "live" }), { status: 200 });
    }
    if (path === "/health/ready") {
      return new Response(JSON.stringify({ healthy: true, status: "ready" }), { status: 200 });
    }
    if (path === "/api/v1/diagnostics") {
      return new Response(JSON.stringify({ database: { available: true }, work: { onlineDevices: 1 } }), { status: 200 });
    }
    if (path === "/api/v1/devices") {
      return new Response(JSON.stringify({ items: [{ id: "fixture-device" }] }), { status: 200 });
    }
    if (path.startsWith("/api/v1/conversations/")) {
      return new Response(fixtureProvider.deepSeek.apiKey, { status: 200 });
    }
    return new Response(JSON.stringify({ error: "not-found" }), { status: 404 });
  };
  let session;
  try {
    session = createInteractiveSession({
      repositoryRoot: fixture.repositoryRoot,
      homeDirectory: fixture.homeDirectory,
      baseDirectory: fixture.baseDirectory,
      desktopAppPath: fixture.desktopAppPath,
      providerConfig: fixtureProvider,
      preflightResult: fixturePreflight(),
      processSupervisor,
      codexPath: process.execPath,
      apiBinaryPath: process.execPath,
      deviceNodePath: process.execPath,
      desktopExecutablePath: process.execPath,
      budgetPollMs: 100
    });
    await session.prepare();
    await createFixtureDatabase(join(session.isolation.directories.database, "jarvis.db"));
    await session.start();
    await assert.rejects(
      () => session.observe(randomUUID()),
      (error) => error.code === "SECRET_DETECTED"
    );
  } finally {
    globalThis.fetch = originalFetch;
    await session?.finish?.().catch(() => {});
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("CLI keeps the prepared runtime alive until finish and rejects user supplied PASS", async () => {
  const fixture = await createFixture();
  const capture = captureOutput();
  const input = Readable.from([
    '{"command":"prepare"}\n',
    '{"command":"prepare","status":"PASS"}\n',
    "{\"command\":\"finish\"}\n"
  ]);
  try {
    const result = await runInteractiveCli({
      input,
      output: capture.output,
      sessionOptions: {
        repositoryRoot: fixture.repositoryRoot,
        homeDirectory: fixture.homeDirectory,
        baseDirectory: fixture.baseDirectory,
        desktopAppPath: fixture.desktopAppPath,
        providerConfig: fixtureProvider,
        preflightResult: fixturePreflight()
      }
    });
    assert.equal(result.status, "FINISHED");
    const lines = capture.value().trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(lines[0].status, "PREPARED");
    assert.equal(Object.hasOwn(lines[0], "paths"), false);
    assert.equal(JSON.stringify(lines).includes(fixture.root), false);
    assert.equal(lines[1].status, "FAIL");
    assert.equal(lines[1].errorCategory, "INVALID_COMMAND");
    assert.equal(lines[2].status, "FINISHED");
    assert.equal(lines[0].runId, lines[2].runId);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("CLI reports provider budget exhaustion during prepare with its canonical status", async () => {
  const fixture = await createFixture();
  const capture = captureOutput();
  const input = Readable.from([
    '{"command":"prepare"}\n',
    '{"command":"finish"}\n'
  ]);
  try {
    const result = await runInteractiveCli({
      input,
      output: capture.output,
      sessionOptions: {
        repositoryRoot: fixture.repositoryRoot,
        homeDirectory: fixture.homeDirectory,
        baseDirectory: fixture.baseDirectory,
        desktopAppPath: fixture.desktopAppPath,
        providerConfig: fixtureProvider,
        preflightResult: fixturePreflight(),
        budgetOptions: { providerRequests: 1 }
      }
    });
    assert.equal(result.status, "LIVE_BUDGET_EXHAUSTED");
    const lines = capture.value().trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(lines.length, 1);
    assert.equal(lines[0].status, "LIVE_BUDGET_EXHAUSTED");
    assert.equal(lines[0].errorCategory, "BUDGET_EXHAUSTED");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("CLI signal cleanup stops the owned session and removes its runtime", async () => {
  const fixture = await createFixture();
  const capture = captureOutput();
  const input = new PassThrough();
  const signalSource = new EventEmitter();
  try {
    const cli = runInteractiveCli({
      input,
      output: capture.output,
      signalSource,
      sessionOptions: {
        repositoryRoot: fixture.repositoryRoot,
        homeDirectory: fixture.homeDirectory,
        baseDirectory: fixture.baseDirectory,
        desktopAppPath: fixture.desktopAppPath,
        providerConfig: fixtureProvider,
        preflightResult: fixturePreflight()
      }
    });
    input.write('{"command":"prepare"}\n');
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    signalSource.emit("SIGTERM");
    const result = await Promise.race([
      cli,
      new Promise((_, reject) => setTimeout(() => reject(new Error("signal cleanup timeout")), 2_000))
    ]);
    assert.equal(result.status, "FAIL");
    assert.equal(result.errorCategory, "INTERRUPTED");
    const lines = capture.value().trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(lines.at(-1).errorCategory, "INTERRUPTED");
  } finally {
    input.destroy();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("CLI hard timeout finishes the owned session", async () => {
  const fixture = await createFixture();
  const capture = captureOutput();
  const input = new PassThrough();
  try {
    const cli = runInteractiveCli({
      input,
      output: capture.output,
      maxRuntimeMs: 10,
      sessionOptions: {
        repositoryRoot: fixture.repositoryRoot,
        homeDirectory: fixture.homeDirectory,
        baseDirectory: fixture.baseDirectory,
        desktopAppPath: fixture.desktopAppPath,
        providerConfig: fixtureProvider,
        preflightResult: fixturePreflight()
      }
    });
    const result = await Promise.race([
      cli,
      new Promise((_, reject) => setTimeout(() => reject(new Error("hard timeout cleanup timeout")), 2_000))
    ]);
    assert.equal(result.status, "FAIL");
    assert.equal(result.errorCategory, "TIMEOUT");
    const lines = capture.value().trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(lines.at(-1).errorCategory, "TIMEOUT");
  } finally {
    input.destroy();
    await rm(fixture.root, { recursive: true, force: true });
  }
});
