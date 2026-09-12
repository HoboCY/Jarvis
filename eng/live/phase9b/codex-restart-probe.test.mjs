import { strict as assert } from "node:assert";
import { spawn as nodeSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmod, lstat, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CODEX_APP_SERVER_METHODS,
  PROBE_ERROR_CODES,
  RECOVERY_MODES,
  ProbeBudget,
  ServerRequestRegistry,
  buildProductPermissionArguments,
  buildProbeEnvironment,
  classifyThreadHistory,
  createRecoveryBoundary,
  createAppServer,
  createCodeOwnedTestProcessLifecycle,
  createMonotonicDeadline,
  claimProbeConsumption,
  projectProbeOutput,
  runCodexRestartProbe,
  safeExternalIdHash,
  verifyAuthMetadata
} from "./codex-restart-probe.mjs";

const THREAD_ID = "thread-a";
const TURN_ID = "turn-a";
const ITEM_ID = "item-a";
const REQUEST_ID = 41;
const TEST_PROCESS_PATH = "/usr/bin:/bin";
const CALLER_PROCESS_PATH = process.env.PATH;

before(() => {
  process.env.PATH = TEST_PROCESS_PATH;
});

after(() => {
  if (CALLER_PROCESS_PATH === undefined) {
    delete process.env.PATH;
  } else {
    process.env.PATH = CALLER_PROCESS_PATH;
  }
});

function userInputParams(overrides = {}) {
  return {
    itemId: ITEM_ID,
    threadId: THREAD_ID,
    turnId: TURN_ID,
    questions: [{
      header: "Choice",
      id: "choice",
      question: "Choose one",
      isOther: false,
      isSecret: false,
      options: [
        { label: "alpha", description: "First" },
        { label: "beta", description: "Second" }
      ]
    }],
    ...overrides
  };
}

function readHistory(overrides = {}) {
  return {
    thread: {
      id: THREAD_ID,
      turns: [{
        id: TURN_ID,
        status: "inProgress",
        items: [{
          type: "dynamicToolCall",
          id: ITEM_ID,
          status: "inProgress",
          tool: "request_user_input",
          arguments: userInputParams()
        }]
      }]
    },
    ...overrides
  };
}

async function createAuthFixture(overrides = {}, targeted = false, finalCandidateSha) {
  const prefix = finalCandidateSha !== undefined ? "final-auth-phase9b-" : targeted ? "targeted-auth-phase9b-" : "protocol-auth-phase9b-";
  const root = await mkdtemp(join(await realpath(tmpdir()), prefix));
  const paths = {
    codexHome: join(root, "codex-home"),
    allowedRoot: join(root, "allowed-root"),
    homeDirectory: join(root, "home"),
    tmpDirectory: join(root, "tmp")
  };
  await Promise.all(Object.values(paths).map((path) => mkdir(path, { mode: 0o700 })));
  await Promise.all(Object.values(paths).map((path) => chmod(path, 0o700)));
  await writeFile(join(paths.codexHome, "auth.json"), "opaque-auth-payload\n", { mode: 0o600 });
  await chmod(join(paths.codexHome, "auth.json"), 0o600);
  const metadata = {
    schemaVersion: 1,
    runId: "123e4567-e89b-42d3-a456-426614174000",
    codexHome: paths.codexHome,
    runtimeRoot: root,
    allowedRoot: paths.allowedRoot,
    authenticationCompleted: true,
    credentialStore: "file",
    previousRuntimeReused: false,
    ...overrides
  };
  const metadataPath = join(root, "login-metadata.json");
  await writeFile(metadataPath, `${JSON.stringify(metadata)}\n`, { mode: 0o600 });
  await chmod(metadataPath, 0o600);
  if (targeted) {
    await writeFile(join(root, "targeted-auth-retention.json"), JSON.stringify({
      schemaVersion: 1, runId: metadata.runId, purpose: "current-targeted-gap-run",
      codexHome: paths.codexHome, metadataPath, authenticationVerified: true,
      retainOnProbeOrProductFailure: true, reuseUntilTargetedRunComplete: true
    }), { mode: 0o600 });
  }
  if (finalCandidateSha !== undefined) {
    await writeFile(join(root, "final-auth-retention.json"), JSON.stringify({
      schemaVersion: 1, runId: metadata.runId, purpose: "final-frozen-a-j-run",
      codexHome: paths.codexHome, metadataPath, authenticationVerified: true,
      retainOnProductFailure: true, candidateSha: finalCandidateSha
    }), { mode: 0o600 });
  }
  return {
    root,
    paths,
    metadata,
    metadataPath,
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    }
  };
}

class FakeNativeChild extends EventEmitter {
  constructor({ generation, mode, profileId, children, onTurnStartResponse }) {
    super();
    this.generation = generation;
    this.mode = mode;
    this.profileId = profileId;
    this.children = children;
    this.onTurnStartResponse = onTurnStartResponse;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.pid = 60_000 + generation;
    this.exitCode = null;
    this.signal = null;
    this.writes = [];
    this.serverRequestId = generation === 1 ? 41 : mode === "new-rpc" ? 99 : 41;
    this.responded = false;
    this.stdin = {
      destroyed: false,
      write: (line, callback) => {
        this.writes.push(JSON.parse(String(line)));
        queueMicrotask(() => {
          this.handle(this.writes.at(-1));
          callback?.();
        });
        return true;
      }
    };
  }

  handle(message) {
    if (message.method === CODEX_APP_SERVER_METHODS.initialized) {
      return;
    }
    if (message.method === CODEX_APP_SERVER_METHODS.initialize) {
      this.emitJson({
        method: "thread/status/changed",
        params: {
          threadId: "native-thread",
          status: { type: "active", activeFlags: [] }
        }
      });
      this.emitJson({ id: message.id, result: {} });
      return;
    }
    if (message.method === CODEX_APP_SERVER_METHODS.threadStart) {
      this.emitJson({
        id: message.id,
        result: {
          thread: { id: "native-thread" },
          activePermissionProfile: { id: this.profileId }
        }
      });
      return;
    }
    if (message.method === CODEX_APP_SERVER_METHODS.threadResume) {
      this.emitJson({
        id: message.id,
        result: {
          thread: { id: "native-thread" },
          activePermissionProfile: { id: this.profileId }
        }
      });
      return;
    }
    if (message.method === CODEX_APP_SERVER_METHODS.turnStart) {
      const turnId = this.generation === 1 ? "native-turn" : "continuation-turn";
      const response = { id: message.id, result: { turn: { id: turnId } } };
      if (this.generation === 2 && this.mode === "continuation-late-reissue") {
        const request = this.buildRequest("continuation-turn");
        this.stdout.emit("data", Buffer.from(`${JSON.stringify(response)}\n${JSON.stringify(request)}\n`));
      } else {
        this.emitJson(response);
      }
      this.onTurnStartResponse?.({ generation: this.generation, turnId });
      if (this.generation === 1) {
        queueMicrotask(() => {
          if (this.mode === "no-initial-request") {
            return;
          }
      if (this.mode === "initial-resolved") {
            this.emitRequestAndNotification("native-turn", {
              method: CODEX_APP_SERVER_METHODS.serverRequestResolved,
              params: { requestId: this.serverRequestId, threadId: "native-thread" }
            });
            return;
          }
          if (this.mode === "initial-completed") {
            this.emitRequestAndNotification("native-turn", {
              method: CODEX_APP_SERVER_METHODS.turnCompleted,
              params: {
                threadId: "native-thread",
                turn: { id: "native-turn", items: [], status: "completed", error: null }
              }
            });
            return;
          }
          if (["input-then-error", "input-then-effectful"].includes(this.mode)) {
            this.emitRequestAndFatal("native-turn");
            return;
          }
          this.emitRequest("native-turn");
        });
      } else if (["continuation", "continuation-late-reissue"].includes(this.mode)) {
        queueMicrotask(() => this.emitCompletion("continuation-turn", "completed"));
      } else if (this.mode === "continuation-failed" || this.mode === "continuation-interrupted") {
        queueMicrotask(() => this.emitCompletion(
          "continuation-turn",
          this.mode === "continuation-failed" ? "failed" : "interrupted"
        ));
      } else if (this.mode === "continuation-completed-error") {
        queueMicrotask(() => this.emitCompletion("continuation-turn", "completed", { code: "native-error" }));
      }
      return;
    }
    if (message.method === CODEX_APP_SERVER_METHODS.threadRead) {
      if (this.mode === "read-error") {
        this.emitJson({ id: message.id, error: { code: "native-error" } });
        return;
      }
      const items = this.mode === "unsafe-history"
        ? [{ type: "commandExecution", id: "unsafe-item" }]
        : ["continuation", "continuation-late-reissue", "continuation-failed", "continuation-interrupted", "continuation-completed-error"].includes(this.mode)
          ? [controlledThreadItem()]
          : [];
      this.emitJson({
        id: message.id,
        result: {
          thread: {
            id: "native-thread",
            turns: [{ id: "native-turn", status: "inProgress", items }]
          }
        }
      });
      if ([
        "reissued",
        "new-rpc",
        "delayed-reissue",
        "reissued-resolved",
        "resolved-after-answer",
        "completion-then-error",
        "completion-then-effectful",
        "failed-completion",
        "interrupted-completion",
        "late-second-stop-error",
        "late-second-stop-effectful"
      ].includes(this.mode)) {
      if (this.mode === "reissued-resolved") {
          queueMicrotask(() => this.emitRequestAndNotification("native-turn", {
            method: CODEX_APP_SERVER_METHODS.serverRequestResolved,
            params: { requestId: this.serverRequestId, threadId: "native-thread" }
          }));
          return;
        }
        const emit = () => this.emitRequest("native-turn");
        if (this.mode === "delayed-reissue") {
          setTimeout(emit, 20);
        } else {
          queueMicrotask(emit);
        }
      }
      return;
    }
    if (message.id !== undefined && message.result !== undefined
        && String(message.id) === String(this.serverRequestId)) {
      this.responded = true;
      if (this.mode === "resolved-after-answer") {
        queueMicrotask(() => this.emitJson({
          method: CODEX_APP_SERVER_METHODS.serverRequestResolved,
          params: { requestId: this.serverRequestId, threadId: "native-thread" }
        }));
      }
      if (this.mode !== "failed-completion" && this.mode !== "interrupted-completion") {
        queueMicrotask(() => {
          this.emitCompletion("native-turn", "completed");
          if (this.mode === "completion-then-error") {
            this.emitJson({ method: "error", params: { error: { message: "private" } } });
          } else if (this.mode === "completion-then-effectful") {
            this.emitJson({ method: "item/commandExecution/requestApproval", params: {} });
          }
        });
      } else {
        queueMicrotask(() => this.emitCompletion(
          "native-turn",
          this.mode === "failed-completion" ? "failed" : "interrupted"
        ));
      }
    }
  }

  emitCompletion(turnId, status, error = undefined) {
    this.emitJson({
      method: CODEX_APP_SERVER_METHODS.turnCompleted,
      params: {
        threadId: "native-thread",
        turn: {
          id: turnId,
          items: [],
          status,
          ...(error !== undefined
            ? { error }
            : status === "completed" ? { error: null } : { error: { code: status } })
        }
      }
    });
  }

  buildRequest(turnId) {
    return {
      id: this.serverRequestId,
      method: CODEX_APP_SERVER_METHODS.requestUserInput,
      params: {
        itemId: "native-item",
        threadId: "native-thread",
        turnId,
        questions: [{
          header: "Choice",
          id: "choice",
          question: "Choose one",
          isOther: false,
          isSecret: false,
          options: [
            { label: "alpha", description: "First" },
            { label: "beta", description: "Second" }
          ]
        }]
      }
    };
  }

  emitRequest(turnId) {
    this.emitJson(this.buildRequest(turnId));
  }

  emitRequestAndFatal(turnId) {
    const fatal = this.mode === "input-then-effectful"
      ? { method: "item/commandExecution/requestApproval", params: {} }
      : { method: "error", params: {} };
    this.emitRequestAndNotification(turnId, fatal);
  }

  emitRequestAndNotification(turnId, notification) {
    const request = {
      id: this.serverRequestId,
      method: CODEX_APP_SERVER_METHODS.requestUserInput,
      params: {
        itemId: "native-item",
        threadId: "native-thread",
        turnId,
        questions: [{
          header: "Choice",
          id: "choice",
          question: "Choose one",
          isOther: false,
          isSecret: false,
          options: [
            { label: "alpha", description: "First" },
            { label: "beta", description: "Second" }
          ]
        }]
      }
    };
    this.stdout.emit("data", Buffer.from(`${JSON.stringify(request)}\n${JSON.stringify(notification)}\n`));
  }

  emitJson(value) {
    this.stdout.emit("data", Buffer.from(`${JSON.stringify(value)}\n`));
  }

  kill(signal) {
    if (this.exitCode !== null) {
      return true;
    }
    if (this.generation === 1 && this.mode === "late-stop-completion") {
      this.emitCompletion("native-turn", "completed");
    } else if (this.generation === 1 && this.mode === "late-stop-error") {
      this.emitJson({ method: "error", params: {} });
    } else if (this.generation === 2 && this.mode === "late-second-stop-error") {
      this.emitJson({ method: "error", params: {} });
    } else if (this.generation === 2 && this.mode === "late-second-stop-effectful") {
      this.emitJson({ method: "item/commandExecution/requestApproval", params: {} });
    }
    this.signal = signal;
    this.stdin.destroyed = true;
    this.exitCode = 0;
    queueMicrotask(() => this.emit("close", 0, signal));
    return true;
  }
}

class StalledWriteChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.pid = 61_000;
    this.exitCode = null;
    this.signalCode = null;
    this.signal = null;
    this.stdin = {
      destroyed: false,
      write: (line) => {
        this.lastWrite = JSON.parse(String(line));
        return true;
      }
    };
  }

  kill(signal) {
    this.signal = signal;
    this.stdin.destroyed = true;
    queueMicrotask(() => {
      this.signalCode = signal;
      this.emit("close", null, signal);
    });
    return true;
  }
}

function createStalledWriteServer({ durationMs = 100, signal = undefined } = {}) {
  const child = new StalledWriteChild();
  const deadline = createMonotonicDeadline(durationMs);
  return {
    child,
    server: createAppServer({
      command: "/private/fake/codex",
      args: [],
      cwd: "/private/fake",
      env: buildProbeEnvironment({
        codexHome: "/private/fake/codex-home",
        tmpDirectory: "/private/fake/tmp",
        allowedRoot: "/private/fake/allowed-root",
        homeDirectory: "/private/fake/home"
      }),
      spawnProcess: () => child,
      deadline,
      processLifecycleFactory: createCodeOwnedTestProcessLifecycle,
      signal
    })
  };
}

async function createRealProcessServer(script) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "probe-process-"));
  let child;
  const server = await createAppServer({
    command: process.execPath,
    args: ["-e", script],
    cwd: root,
    env: buildProbeEnvironment({
      codexHome: join(root, "codex-home"),
      tmpDirectory: join(root, "tmp"),
      allowedRoot: join(root, "allowed-root"),
      homeDirectory: join(root, "home")
    }),
    deadline: createMonotonicDeadline(3_000),
    onSpawn: (spawned) => {
      child = spawned;
    }
  });
  return {
    root,
    child,
    server,
    async cleanup() {
      if (child?.pid && !isProcessGroupGone(child.pid)) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // The owned process group may already have disappeared.
        }
      }
      await rm(root, { recursive: true, force: true });
    }
  };
}

function isProcessGroupGone(pid) {
  try {
    process.kill(-pid, 0);
    return false;
  } catch (error) {
    return error?.code === "ESRCH" || error?.code === "ENOENT";
  }
}

async function waitForProcessStartup() {
  await new Promise(resolve => setTimeout(resolve, 100));
}

function waitForOwnedProcessHandshake(child, timeoutMs = 2_000) {
  return new Promise((resolvePromise, rejectPromise) => {
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      child.off?.("message", onMessage);
      child.off?.("close", onClose);
    };
    const onMessage = (message) => {
      if (message?.type !== "probe-owned-app-server-spawn"
          || !Number.isSafeInteger(message.pid) || message.pid <= 0) {
        return;
      }
      cleanup();
      resolvePromise({ pid: message.pid });
    };
    const onClose = () => {
      cleanup();
      rejectPromise(new Error("CLI_HANDSHAKE_MISSING"));
    };
    timer = setTimeout(() => {
      cleanup();
      rejectPromise(new Error("CLI_HANDSHAKE_TIMEOUT"));
    }, timeoutMs);
    child.on("message", onMessage);
    child.once("close", onClose);
  });
}

async function waitForOwnedProcessGroupGone(pid, timeoutMs = 2_000) {
  const deadline = performance.now() + timeoutMs;
  while (!isProcessGroupGone(pid) && performance.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return isProcessGroupGone(pid);
}

test("bounds request, notification, and response writes when stdin never calls back", async () => {
  for (const kind of ["request", "notify", "respond"]) {
    const fixture = createStalledWriteServer({ durationMs: 40 });
    const server = await fixture.server;
    try {
      let operation;
      if (kind === "request") {
        operation = server.request(CODEX_APP_SERVER_METHODS.initialize, {});
      } else if (kind === "notify") {
        operation = server.notify(CODEX_APP_SERVER_METHODS.initialized, null);
      } else {
        fixture.child.stdout.emit("data", Buffer.from(JSON.stringify({
          id: REQUEST_ID,
          method: CODEX_APP_SERVER_METHODS.requestUserInput,
          params: userInputParams()
        }) + "\n"));
        operation = server.respond(REQUEST_ID, { answers: {} });
      }
      await assert.rejects(
        operation,
        (error) => error.code === PROBE_ERROR_CODES.DEADLINE_EXCEEDED);
      const stop = await server.stop();
      assert.equal(stop.completed, true);
      assert.equal(stop.processGroupGone, true);
    } finally {
      await server.stop().catch(() => undefined);
    }
  }
});

test("bounds a stalled response write and settles it when the child closes", async () => {
  const fixture = createStalledWriteServer({ durationMs: 500 });
  const server = await fixture.server;
  try {
    fixture.child.stdout.emit("data", Buffer.from(JSON.stringify({
      id: REQUEST_ID,
      method: CODEX_APP_SERVER_METHODS.requestUserInput,
      params: userInputParams()
    }) + "\n"));
    const response = server.respond(REQUEST_ID, { answers: {} });
    const stop = server.stop();
    await assert.rejects(response, (error) => error.code === PROBE_ERROR_CODES.CANCELLED);
    const stopped = await stop;
    assert.equal(stopped.completed, true);
  } finally {
    await server.stop().catch(() => undefined);
  }
});

test("settles stalled writes on abort, fatal input, and close without unhandled rejection", async () => {
  const cases = [
    { name: "abort", code: PROBE_ERROR_CODES.CANCELLED },
    { name: "fatal", code: PROBE_ERROR_CODES.PROTOCOL_INVALID },
    { name: "close", code: PROBE_ERROR_CODES.PROBE_RUNTIME_ERROR }
  ];
  for (const kind of ["request", "notify", "respond"]) {
    for (const current of cases) {
      const controller = new AbortController();
      const serverFixture = createStalledWriteServer({ durationMs: 500, signal: controller.signal });
      const server = await serverFixture.server;
      let unhandled = 0;
      const onUnhandled = () => { unhandled++; };
      process.on("unhandledRejection", onUnhandled);
      try {
        let operation;
        if (kind === "request") {
          operation = server.request(CODEX_APP_SERVER_METHODS.initialize, {});
        } else if (kind === "notify") {
          operation = server.notify(CODEX_APP_SERVER_METHODS.initialized, null);
        } else {
          serverFixture.child.stdout.emit("data", Buffer.from(JSON.stringify({
            id: REQUEST_ID,
            method: CODEX_APP_SERVER_METHODS.requestUserInput,
            params: userInputParams()
          }) + "\n"));
          operation = server.respond(REQUEST_ID, { answers: {} });
        }
        if (current.name === "abort") {
          controller.abort();
        } else if (current.name === "fatal") {
          serverFixture.child.stdout.emit("data", Buffer.from("{\n"));
        } else {
          serverFixture.child.emit("close", null, "SIGTERM");
        }
        await assert.rejects(operation, (error) => error.code === current.code);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(unhandled, 0);
      } finally {
        process.removeListener("unhandledRejection", onUnhandled);
        await server.stop().catch(() => undefined);
      }
    }
  }
});

test("preserves a valid response that arrives before the stdin callback", async () => {
  const fake = createFakeNative();
  const server = await createAppServer({
    command: "/private/fake/codex",
    args: [],
    cwd: "/private/fake",
    env: buildProbeEnvironment({
      codexHome: "/private/fake/codex-home",
      tmpDirectory: "/private/fake/tmp",
      allowedRoot: "/private/fake/allowed-root",
      homeDirectory: "/private/fake/home"
    }),
    spawnProcess: fake.spawnProcess,
    processLifecycleFactory: createCodeOwnedTestProcessLifecycle,
    deadline: createMonotonicDeadline(500)
  });
  try {
    assert.deepEqual(
      await server.request(CODEX_APP_SERVER_METHODS.initialize, {}),
      {});
  } finally {
    await server.stop();
  }
});

test("does not inspect or signal an ambient process group for an injected spawn", async () => {
  const child = new FakeNativeChild({ generation: 1, mode: "reissued", profileId: "test", children: [] });
  const originalKill = process.kill;
  let ambientSignalCount = 0;
  process.kill = () => {
    ambientSignalCount += 1;
    throw new Error("ambient process group access");
  };
  let server;
  try {
    server = await createAppServer({
      command: "/private/fake/codex",
      args: [],
      cwd: "/private/fake",
      env: buildProbeEnvironment({
        codexHome: "/private/fake/codex-home",
        tmpDirectory: "/private/fake/tmp",
        allowedRoot: "/private/fake/allowed-root",
        homeDirectory: "/private/fake/home"
      }),
      spawnProcess: () => child,
      deadline: createMonotonicDeadline(100)
    });
    const result = await server.stop();
    assert.equal(ambientSignalCount, 0);
    assert.equal(result.processGroupGone, false);
    assert.equal(result.completed, false);
  } finally {
    process.kill = originalKill;
    await server?.stop().catch(() => undefined);
  }
});

test("accepts a real Node JSONL roundtrip and null stdin callback", { skip: process.platform === "win32" }, async () => {
  const fixture = await createRealProcessServer(
    "let input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => { input += chunk; let index; while ((index = input.indexOf('\\n')) >= 0) { const line = input.slice(0, index); input = input.slice(index + 1); const message = JSON.parse(line); if (message.method === 'initialize') process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + '\\n'); } });");
  try {
    assert.deepEqual(
      await fixture.server.request(CODEX_APP_SERVER_METHODS.initialize, {}),
      {});
    await fixture.server.notify(CODEX_APP_SERVER_METHODS.initialized, null);
    const stopped = await fixture.server.stop();
    assert.equal(stopped.completed, true);
    assert.equal(stopped.processGroupGone, true);
  } finally {
    await fixture.server.stop().catch(() => undefined);
    await fixture.cleanup();
  }
});

test("cleans a real signal-exited process group", { skip: process.platform === "win32" }, async () => {
  const fixture = await createRealProcessServer(
    "setInterval(() => {}, 1000);");
  try {
    await waitForProcessStartup();
    const result = await fixture.server.stop();
    assert.equal(result.completed, true);
    assert.equal(result.processGroupGone, true);
    assert.equal(result.forcedKill, false);
    assert.equal(isProcessGroupGone(fixture.child.pid), true);
  } finally {
    await fixture.server.stop().catch(() => undefined);
    await fixture.cleanup();
  }
});

test("kills a surviving descendant after the leader exits", { skip: process.platform === "win32" }, async () => {
  const fixture = await createRealProcessServer(`
    const child = require('node:child_process').spawn(process.execPath, ['-e',
      "process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000);"
    ], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const descendantReady = new Promise(resolve => child.once('message', message => resolve(message === 'ready')));
    process.on('SIGTERM', () => process.exit(0));
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      input += chunk;
      let index;
      while ((index = input.indexOf('\\n')) >= 0) {
        const message = JSON.parse(input.slice(0, index));
        input = input.slice(index + 1);
        if (message.method === 'initialize') {
          void descendantReady.then(ready => process.stdout.write(JSON.stringify({
            id: message.id, result: { descendantReady: ready }
          }) + '\\n'));
        }
      }
    });
  `);
  try {
    assert.deepEqual(await fixture.server.request(CODEX_APP_SERVER_METHODS.initialize, {}), {
      descendantReady: true
    });
    const result = await fixture.server.stop();
    assert.equal(result.completed, true);
    assert.equal(result.processGroupGone, true);
    assert.equal(result.forcedKill, true);
    assert.equal(isProcessGroupGone(fixture.child.pid), true);
  } finally {
    await fixture.server.stop().catch(() => undefined);
    await fixture.cleanup();
  }
});

function createFakeNative({ mode = "reissued", onTurnStartResponse } = {}) {
  const children = [];
  const spawnCalls = [];
  const spawnProcess = (command, args, options) => {
    const profile = args.find((value) => value.startsWith("default_permissions="));
    const profileId = profile?.slice("default_permissions=\"".length, -1);
    const child = new FakeNativeChild({
      generation: children.length + 1,
      mode,
      profileId,
      children,
      onTurnStartResponse
    });
    children.push(child);
    spawnCalls.push({ command, args, options });
    return child;
  };
  return { children, spawnCalls, spawnProcess };
}

async function runPublicFakeProbe(mode, {
  maxDurationMs = undefined,
  signal = undefined,
  onTurnStartResponse = undefined,
  capture = undefined
} = {}) {
  const fixture = await createAuthFixture();
  const fake = createFakeNative({ mode, onTurnStartResponse });
  if (capture !== undefined) {
    capture.fake = fake;
  }
  try {
    return await runCodexRestartProbe({
      securityRemediationStatus: "RESOLVED_NO_REUSABLE_CREDENTIAL_EXPOSURE",
      offlineGatesPassed: true,
      codexPath: "/private/fake/codex",
      authMetadataPath: fixture.metadataPath,
      spawnProcess: fake.spawnProcess,
      maxDurationMs,
      signal,
      testSeam: {
        verifyAuthMetadata: async () => ({
          runId: fixture.metadata.runId,
          codexHome: fixture.paths.codexHome,
          runtimeRoot: fixture.root,
          allowedRoot: fixture.paths.allowedRoot,
          homeDirectory: fixture.paths.homeDirectory,
          tmpDirectory: fixture.paths.tmpDirectory,
          metadataRoot: fixture.root
        }),
        verifyPinnedCodex: async () => true,
        claimProbeConsumption: async () => join(fixture.root, "probe-marker"),
        createProcessLifecycle: createCodeOwnedTestProcessLifecycle
      }
    });
  } finally {
    await fixture.cleanup();
  }
}

async function createProtocolServer({ mode = "reissued", ...options } = {}) {
  const fake = createFakeNative({ mode });
  const server = await createAppServer({
    command: "/private/fake/codex",
    args: [],
    cwd: "/private/fake",
    env: buildProbeEnvironment({
      codexHome: "/private/fake/codex-home",
      tmpDirectory: "/private/fake/tmp",
      allowedRoot: "/private/fake/allowed-root",
      homeDirectory: "/private/fake/home"
    }),
    spawnProcess: fake.spawnProcess,
    processLifecycleFactory: createCodeOwnedTestProcessLifecycle,
    deadline: createMonotonicDeadline(500),
    ...options
  });
  return { fake, child: fake.children[0], server };
}

function controlledThreadItem(status = "inProgress") {
  return {
    type: "dynamicToolCall",
    id: "native-item",
    status,
    tool: "request_user_input",
    arguments: userInputParams({
      itemId: "native-item",
      threadId: "native-thread",
      turnId: "native-turn"
    })
  };
}

async function assertNotificationRejected(notification, code) {
  const { child, server } = await createProtocolServer();
  try {
    child.emitJson(notification);
    await assert.rejects(
      server.request(CODEX_APP_SERVER_METHODS.initialize, {}),
      (error) => error.code === code
    );
  } finally {
    await server.stop().catch(() => undefined);
  }
}

test("accepts native typed item lifecycle, turn completion, and fixed benign notifications", async () => {
  const { child, server } = await createProtocolServer();
  const item = controlledThreadItem();
  try {
    const initialization = server.request(CODEX_APP_SERVER_METHODS.initialize, {});
    child.emitJson({
      method: "item/started",
      params: {
        item,
        startedAtMs: 1,
        threadId: "native-thread",
        turnId: "native-turn"
      }
    });
    child.emitJson({
      method: "item/completed",
      params: {
        completedAtMs: 2,
        item: controlledThreadItem("completed"),
        threadId: "native-thread",
        turnId: "native-turn"
      }
    });
    child.emitJson({
      method: "item/reasoning/summaryPartAdded",
      params: {
        itemId: "native-item",
        summaryIndex: 0,
        threadId: "native-thread",
        turnId: "native-turn"
      }
    });
    child.emitJson({
      method: "item/reasoning/textDelta",
      params: {
        contentIndex: 0,
        delta: "safe",
        itemId: "native-item",
        threadId: "native-thread",
        turnId: "native-turn"
      }
    });
    const zeroUsage = {
      cachedInputTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0
    };
    child.emitJson({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "native-thread",
        tokenUsage: { last: zeroUsage, total: zeroUsage },
        turnId: "native-turn"
      }
    });
    child.emitJson({ method: "account/rateLimits/updated", params: { rateLimits: {} } });
    child.emitJson({
      method: CODEX_APP_SERVER_METHODS.turnCompleted,
      params: {
        threadId: "native-thread",
        turn: {
          id: "native-turn",
          items: [controlledThreadItem("completed")],
          status: "completed",
          error: null
        }
      }
    });
    child.emitJson({
      method: CODEX_APP_SERVER_METHODS.turnCompleted,
      params: {
        threadId: "native-thread",
        turn: { id: "native-turn", items: [], status: "completed" }
      }
    });
    assert.deepEqual(await initialization, {});
  } finally {
    await server.stop();
  }
});

test("rejects malformed or effectful typed notifications and removed notification methods", async () => {
  const itemLifecycle = {
    method: "item/started",
    params: {
      item: { type: "futureItem", id: "future-item" },
      startedAtMs: 1,
      threadId: "native-thread",
      turnId: "native-turn"
    }
  };
  await assertNotificationRejected(itemLifecycle, PROBE_ERROR_CODES.PROTOCOL_INVALID);
  await assertNotificationRejected({
    method: CODEX_APP_SERVER_METHODS.turnCompleted,
    params: {
      threadId: "native-thread",
      turn: {
        id: "native-turn",
        items: [{ type: "commandExecution", id: "command-item" }],
        status: "completed"
      }
    }
  }, PROBE_ERROR_CODES.EFFECTFUL_REQUEST_REJECTED);
  await assertNotificationRejected({
    method: "item/reasoning/summaryPartAdded",
    params: {
      itemId: "native-item",
      summaryIndex: 0,
      threadId: "native-thread",
      turnId: "native-turn",
      unexpected: "private"
    }
  }, PROBE_ERROR_CODES.PROTOCOL_INVALID);
  await assertNotificationRejected({ method: "error", params: { message: "private" } }, PROBE_ERROR_CODES.PROBE_RUNTIME_ERROR);
  await assertNotificationRejected({ method: "item/agentMessage/completed", params: {} }, PROBE_ERROR_CODES.UNSUPPORTED_REQUEST);
  await assertNotificationRejected({ method: "item/reasoning/summaryTextDone", params: {} }, PROBE_ERROR_CODES.UNSUPPORTED_REQUEST);
  await assertNotificationRejected({
    method: "item/commandExecution/requestApproval",
    params: {}
  }, PROBE_ERROR_CODES.EFFECTFUL_REQUEST_REJECTED);
});

test("derives native serverRequest/resolved turn identity and blocks a response after resolution", async () => {
  const resolved = [];
  const { child, server } = await createProtocolServer({
    processGeneration: 2,
    onServerRequestResolved: (value) => resolved.push(value)
  });
  try {
    child.emitJson({
      id: REQUEST_ID,
      method: CODEX_APP_SERVER_METHODS.requestUserInput,
      params: userInputParams({
        itemId: "native-item",
        threadId: THREAD_ID,
        turnId: TURN_ID
      })
    });
    child.emitJson({
      method: "serverRequest/resolved",
      params: { requestId: REQUEST_ID, threadId: THREAD_ID }
    });
    assert.deepEqual(resolved, [{
      requestId: REQUEST_ID,
      threadId: THREAD_ID,
      turnId: TURN_ID,
      processGeneration: 2
    }]);
    await assert.rejects(
      server.respond(REQUEST_ID, { answers: { choice: { answers: ["alpha"] } } }),
      (error) => error.code === PROBE_ERROR_CODES.REQUEST_ALREADY_RESOLVED
    );
    assert.equal(child.writes.length, 0);
  } finally {
    await server.stop();
  }
});

test("rejects a resolved notification with the current request id but a mismatched thread", async () => {
  const { child, server } = await createProtocolServer({ processGeneration: 2 });
  try {
    child.emitJson({
      id: REQUEST_ID,
      method: CODEX_APP_SERVER_METHODS.requestUserInput,
      params: userInputParams({ itemId: "native-item", threadId: THREAD_ID, turnId: TURN_ID })
    });
    child.emitJson({
      method: CODEX_APP_SERVER_METHODS.serverRequestResolved,
      params: { requestId: REQUEST_ID, threadId: "thread-other" }
    });
    await assert.rejects(
      server.request(CODEX_APP_SERVER_METHODS.initialize, {}),
      (error) => error.code === PROBE_ERROR_CODES.REISSUED_REQUEST_MISMATCH
    );
  } finally {
    await server.stop().catch(() => undefined);
  }
});

test("sends one physical response and rejects a second response for the consumed request", async () => {
  const { child, server } = await createProtocolServer();
  try {
    child.emitJson({
      id: REQUEST_ID,
      method: CODEX_APP_SERVER_METHODS.requestUserInput,
      params: userInputParams({ itemId: "native-item", threadId: THREAD_ID, turnId: TURN_ID })
    });
    await server.respond(REQUEST_ID, { answers: { choice: { answers: ["alpha"] } } });
    await assert.rejects(
      server.respond(REQUEST_ID, { answers: { choice: { answers: ["beta"] } } }),
      (error) => error.code === PROBE_ERROR_CODES.DUPLICATE_SERVER_REQUEST
    );
    assert.equal(child.writes.filter((message) => message.id === REQUEST_ID).length, 1);
  } finally {
    await server.stop();
  }
});

test("accepts a real resolved notification after the single answer without synthesizing one", async () => {
  const fixture = await createAuthFixture();
  const fake = createFakeNative({ mode: "resolved-after-answer" });
  try {
    const output = await runCodexRestartProbe({
      securityRemediationStatus: "RESOLVED_NO_REUSABLE_CREDENTIAL_EXPOSURE",
      offlineGatesPassed: true,
      codexPath: "/private/fake/codex",
      authMetadataPath: fixture.metadataPath,
      spawnProcess: fake.spawnProcess,
      testSeam: {
        verifyAuthMetadata: async () => ({
          runId: fixture.metadata.runId,
          codexHome: fixture.paths.codexHome,
          runtimeRoot: fixture.root,
          allowedRoot: fixture.paths.allowedRoot,
          homeDirectory: fixture.paths.homeDirectory,
          tmpDirectory: fixture.paths.tmpDirectory,
          metadataRoot: fixture.root
        }),
        verifyPinnedCodex: async () => true,
        claimProbeConsumption: async () => join(fixture.root, "probe-marker"),
        createProcessLifecycle: createCodeOwnedTestProcessLifecycle
      }
    });
    assert.equal(output.status, "PASS");
    assert.equal(output.answerCount, 1);
    assert.equal(output.resolvedObserved, true);
  } finally {
    await fixture.cleanup();
  }
});

test("does not accept a successful completion followed by a fatal notification in the same stream turn", async () => {
  for (const [mode, errorCode] of [
    ["completion-then-error", PROBE_ERROR_CODES.PROBE_RUNTIME_ERROR],
    ["completion-then-effectful", PROBE_ERROR_CODES.EFFECTFUL_REQUEST_REJECTED]
  ]) {
    const output = await runPublicFakeProbe(mode);
    assert.equal(output.status, "FAIL");
    assert.equal(output.errorCode, errorCode);
    assert.equal(output.answerCount, 1);
  }
});

test("does not restart or answer when input wakeup is followed by a fatal notification", async () => {
  for (const [mode, errorCode] of [
    ["input-then-error", PROBE_ERROR_CODES.PROBE_RUNTIME_ERROR],
    ["input-then-effectful", PROBE_ERROR_CODES.EFFECTFUL_REQUEST_REJECTED]
  ]) {
    const output = await runPublicFakeProbe(mode);
    assert.equal(output.status, "FAIL");
    assert.equal(output.errorCode, errorCode);
    assert.equal(output.restartCount, 0);
    assert.equal(output.answerCount, 0);
  }
});

test("rejects typed item envelopes whose thread or turn differs from the current request", async () => {
  for (const method of ["item/started", "item/completed"]) {
    for (const identity of [{ threadId: "thread-other", turnId: "native-turn" }, { threadId: "native-thread", turnId: "turn-other" }]) {
      const { child, server } = await createProtocolServer();
      try {
        child.emitJson({
          id: REQUEST_ID,
          method: CODEX_APP_SERVER_METHODS.requestUserInput,
          params: userInputParams({ itemId: "native-item", threadId: "native-thread", turnId: "native-turn" })
        });
        child.emitJson({
          method,
          params: {
            item: controlledThreadItem(),
            ...(method === "item/started" ? { startedAtMs: 1 } : { completedAtMs: 1 }),
            ...identity
          }
        });
        await assert.rejects(
          server.request(CODEX_APP_SERVER_METHODS.initialize, {}),
          (error) => error.code === PROBE_ERROR_CODES.REISSUED_REQUEST_MISMATCH
        );
      } finally {
        await server.stop().catch(() => undefined);
      }
    }
  }
});

test("probe output is a strict projection with bounded values and no external ids", () => {
  const output = projectProbeOutput({
    schemaVersion: 1,
    status: "PASS",
    mode: "REISSUED_REQUEST",
    taskCount: 1,
    restartCount: 1,
    answerCount: 1,
    continuationCount: 0,
    permissionProfileConfirmed: true,
    requestMethod: "item/tool/requestUserInput",
    threadIdSha256: safeExternalIdHash(THREAD_ID),
    cleanup: { completed: true, processGroupGone: true, forcedKill: false },
    streams: {
      stdout: { observed: false, suppressed: false },
      stderr: { observed: true, suppressed: false }
    }
  });

  assert.equal(output.status, "PASS");
  assert.equal(output.threadIdSha256, safeExternalIdHash(THREAD_ID));
  assert.equal("threadId" in output, false);
  assert.throws(
    () => projectProbeOutput({ schemaVersion: 1, status: "PASS", unknown: "value" }),
    (error) => error.code === PROBE_ERROR_CODES.OUTPUT_REJECTED
  );
  assert.throws(
    () => projectProbeOutput({ schemaVersion: 1, status: "PASS", threadId: THREAD_ID }),
    (error) => error.code === PROBE_ERROR_CODES.OUTPUT_REJECTED
  );
  assert.throws(
    () => projectProbeOutput({ schemaVersion: 1, status: "PASS", taskCount: Number.MAX_SAFE_INTEGER }),
    (error) => error.code === PROBE_ERROR_CODES.OUTPUT_REJECTED
  );
  assert.throws(
    () => projectProbeOutput({ schemaVersion: 1, status: "PASS", errorMessage: "private detail" }),
    (error) => error.code === PROBE_ERROR_CODES.OUTPUT_REJECTED
  );
});

test("rejected protocol diagnostics expose only fixed methods and never private input", async () => {
  for (const [message, expected, errorCode] of [
    [{ method: "thread/settings/updated", params: { private: "controlled-private-material" } }, { kind: "notification", method: "thread/settings/updated" }, PROBE_ERROR_CODES.UNSUPPORTED_REQUEST],
    [{ method: "controlled-private-material", params: {} }, { kind: "notification", method: "UNKNOWN" }, PROBE_ERROR_CODES.UNSUPPORTED_REQUEST],
    [{ id: 19, method: "attestation/generate", params: { private: "controlled-private-material" } }, { kind: "serverRequest", method: "attestation/generate" }, PROBE_ERROR_CODES.UNSUPPORTED_REQUEST],
    [{ id: 20, method: "item/commandExecution/requestApproval", params: { private: "controlled-private-material" } }, { kind: "serverRequest", method: "item/commandExecution/requestApproval" }, PROBE_ERROR_CODES.EFFECTFUL_REQUEST_REJECTED]
  ]) {
    const { child, server } = await createProtocolServer();
    try {
      child.emitJson(message);
      await assert.rejects(server.request(CODEX_APP_SERVER_METHODS.initialize, {}), error => error.code === errorCode);
      assert.deepEqual(server.rejectedMessage, expected);
      const output = projectProbeOutput({ schemaVersion: 1, status: "FAIL", rejectedMessage: server.rejectedMessage });
      assert.equal(JSON.stringify(output).includes("controlled-private-material"), false);
    } finally {
      await server.stop();
    }
  }
  for (const rejectedMessage of [
    null,
    "controlled-private-material",
    { kind: "notification", method: "controlled-private-material" },
    { kind: "private", method: "UNKNOWN" },
    { kind: "notification", method: "UNKNOWN", params: "controlled-private-material" }
  ]) {
    assert.throws(() => projectProbeOutput({ schemaVersion: 1, status: "FAIL", rejectedMessage }),
      error => error.code === PROBE_ERROR_CODES.OUTPUT_REJECTED);
  }
  assert.throws(() => projectProbeOutput({ schemaVersion: 1, status: "PASS", rejectedMessage: { kind: "notification", method: "UNKNOWN" } }),
    error => error.code === PROBE_ERROR_CODES.OUTPUT_REJECTED);
});

test("public failed probe retains the bounded rejected-message diagnostic after cleanup", async () => {
  const capture = {};
  const output = await runPublicFakeProbe("reissued", {
    capture,
    onTurnStartResponse: ({ generation }) => {
      if (generation === 1) {
        capture.fake.children[0].emitJson({
          method: "thread/settings/updated",
          params: { private: "controlled-private-material" }
        });
      }
    }
  });
  assert.equal(output.status, "FAIL");
  assert.equal(output.errorCode, PROBE_ERROR_CODES.UNSUPPORTED_REQUEST);
  assert.deepEqual(output.rejectedMessage, { kind: "notification", method: "thread/settings/updated" });
  assert.equal(output.restartCount, 0);
  assert.equal(output.answerCount, 0);
  assert.equal(output.continuationCount, 0);
  assert.equal(output.cleanup.completed, true);
  assert.equal(output.cleanup.processGroupGone, true);
  assert.equal(JSON.stringify(output).includes("controlled-private-material"), false);
});

test("public failed continuation retains the second process rejection after cleanup", async () => {
  const capture = {};
  const output = await runPublicFakeProbe("continuation", {
    capture,
    onTurnStartResponse: ({ generation }) => {
      if (generation === 2) {
        capture.fake.children[1].emitJson({ method: "thread/settings/updated", params: { private: "controlled-private-material" } });
      }
    }
  });
  assert.equal(output.status, "FAIL");
  assert.equal(output.errorCode, PROBE_ERROR_CODES.UNSUPPORTED_REQUEST);
  assert.deepEqual(output.rejectedMessage, { kind: "notification", method: "thread/settings/updated" });
  assert.equal(output.restartCount, 1);
  assert.equal(output.cleanup.completed, true);
  assert.equal(output.cleanup.processGroupGone, true);
  assert.equal(JSON.stringify(output).includes("controlled-private-material"), false);
});

test("server request registry accepts only the current logical request and consumes one answer", () => {
  const registry = new ServerRequestRegistry();
  registry.beginProcess(1);
  assert.equal(
    registry.observe({
      processGeneration: 1,
      requestId: REQUEST_ID,
      method: CODEX_APP_SERVER_METHODS.requestUserInput,
      params: userInputParams()
    }).kind,
    "INITIAL_REQUEST"
  );

  registry.endProcess(1);
  registry.beginProcess(2);
  const reissued = registry.observe({
    processGeneration: 2,
    requestId: REQUEST_ID,
    method: CODEX_APP_SERVER_METHODS.requestUserInput,
    params: userInputParams()
  });
  assert.equal(reissued.kind, "REISSUED_MATCH");
  assert.throws(
    () => registry.observe({
      processGeneration: 2,
      requestId: REQUEST_ID,
      method: CODEX_APP_SERVER_METHODS.requestUserInput,
      params: userInputParams()
    }),
    (error) => error.code === PROBE_ERROR_CODES.DUPLICATE_SERVER_REQUEST
  );

  const response = registry.consumeAnswer({
    processGeneration: 2,
    requestId: REQUEST_ID,
    answers: { choice: { answers: ["alpha"] } }
  });
  assert.deepEqual(response, { answers: { choice: { answers: ["alpha"] } } });
  assert.throws(
    () => registry.consumeAnswer({
      processGeneration: 2,
      requestId: REQUEST_ID,
      answers: { choice: { answers: ["alpha"] } }
    }),
    (error) => error.code === PROBE_ERROR_CODES.ANSWER_ALREADY_CONSUMED
  );
  assert.equal(registry.snapshot().answerConsumed, true);
  registry.resolveServerRequest({
    processGeneration: 2,
    requestId: REQUEST_ID,
    threadId: THREAD_ID
  });
  assert.throws(
    () => registry.consumeAnswer({
      processGeneration: 2,
      requestId: REQUEST_ID,
      answers: { choice: { answers: ["alpha"] } }
    }),
    (error) => error.code === PROBE_ERROR_CODES.ANSWER_ALREADY_CONSUMED
  );
  registry.endProcess(2);
  assert.throws(
    () => registry.observe({
      processGeneration: 1,
      requestId: 99,
      method: CODEX_APP_SERVER_METHODS.requestUserInput,
      params: userInputParams()
    }),
    (error) => error.code === PROBE_ERROR_CODES.STALE_REQUEST
  );
});

test("native other-input flag preserves identity without allowing uncontrolled answers", () => {
  const registry = new ServerRequestRegistry();
  registry.beginProcess(1);
  const params = userInputParams({ questions: [{ ...userInputParams().questions[0], isOther: true }] });
  registry.observe({ processGeneration: 1, requestId: REQUEST_ID, method: CODEX_APP_SERVER_METHODS.requestUserInput, params });
  assert.throws(() => registry.consumeAnswer({ processGeneration: 1, requestId: REQUEST_ID,
    answers: { choice: { answers: ["controlled-unlisted-answer"] } } }), error => error.code === PROBE_ERROR_CODES.ANSWER_INVALID);
  assert.deepEqual(registry.consumeAnswer({ processGeneration: 1, requestId: REQUEST_ID,
    answers: { choice: { answers: ["alpha"] } } }), { answers: { choice: { answers: ["alpha"] } } });
});

test("registry refuses a resolved request before accepting its answer", () => {
  const registry = new ServerRequestRegistry();
  registry.beginProcess(1);
  registry.observe({
    processGeneration: 1,
    requestId: REQUEST_ID,
    method: CODEX_APP_SERVER_METHODS.requestUserInput,
    params: userInputParams()
  });
  registry.resolveServerRequest({
    processGeneration: 1,
    requestId: REQUEST_ID,
    threadId: THREAD_ID
  });
  assert.throws(
    () => registry.consumeAnswer({
      processGeneration: 1,
      requestId: REQUEST_ID,
      answers: { choice: { answers: ["alpha"] } }
    }),
    (error) => error.code === PROBE_ERROR_CODES.REQUEST_ALREADY_RESOLVED
  );
});

test("registry rejects mismatches, stale requests, secret questions, and effectful requests without sending responses", () => {
  const registry = new ServerRequestRegistry();
  registry.beginProcess(1);
  registry.observe({
    processGeneration: 1,
    requestId: 7,
    method: CODEX_APP_SERVER_METHODS.requestUserInput,
    params: userInputParams()
  });
  registry.endProcess(1);
  registry.beginProcess(2);

  assert.equal(registry.observe({
    processGeneration: 2,
    requestId: 8,
    method: CODEX_APP_SERVER_METHODS.requestUserInput,
    params: userInputParams({ turnId: "turn-other" })
  }).kind, "REISSUED_MISMATCH");
  assert.equal(registry.unseenRequestDisposition(), "NOT_ATTEMPTED_UNSEEN_REQUEST");
  assert.throws(
    () => registry.consumeAnswer({
      processGeneration: 2,
      requestId: 8,
      answers: { choice: { answers: ["alpha"] } }
    }),
    (error) => error.code === PROBE_ERROR_CODES.REISSUED_REQUEST_MISMATCH
  );
  assert.throws(
    () => registry.resolveServerRequest({
      processGeneration: 2,
      requestId: 8,
      threadId: "thread-other"
    }),
    (error) => error.code === PROBE_ERROR_CODES.REISSUED_REQUEST_MISMATCH
  );
  assert.throws(
    () => registry.consumeAnswer({ processGeneration: 2, requestId: 7, answers: {} }),
    (error) => error.code === PROBE_ERROR_CODES.STALE_REQUEST
  );
  assert.throws(
    () => registry.observe({
      processGeneration: 2,
      requestId: 9,
      method: CODEX_APP_SERVER_METHODS.requestUserInput,
      params: userInputParams({ questions: [{ ...userInputParams().questions[0], isSecret: true }] })
    }),
    (error) => error.code === PROBE_ERROR_CODES.SECRET_INPUT_REJECTED
  );
  assert.throws(
    () => registry.observe({
      processGeneration: 2,
      requestId: 10,
      method: "item/commandExecution/requestApproval",
      params: {}
    }),
    (error) => error.code === PROBE_ERROR_CODES.EFFECTFUL_REQUEST_REJECTED
  );
});

test("registry ignores a late same-id resolution from an ended generation", () => {
  const registry = new ServerRequestRegistry();
  registry.beginProcess(1);
  registry.observe({
    processGeneration: 1,
    requestId: REQUEST_ID,
    method: CODEX_APP_SERVER_METHODS.requestUserInput,
    params: userInputParams()
  });
  registry.endProcess(1);
  registry.beginProcess(2);
  registry.observe({
    processGeneration: 2,
    requestId: REQUEST_ID,
    method: CODEX_APP_SERVER_METHODS.requestUserInput,
    params: userInputParams()
  });
  assert.throws(
    () => registry.resolveServerRequest({
      processGeneration: 1,
      requestId: REQUEST_ID,
      threadId: THREAD_ID
    }),
    (error) => error.code === PROBE_ERROR_CODES.STALE_REQUEST
  );
  assert.equal(registry.snapshot().serverRequestResolved, false);
  registry.resolveServerRequest({
    processGeneration: 2,
    requestId: REQUEST_ID,
    threadId: THREAD_ID
  });
  assert.equal(registry.snapshot().serverRequestResolved, true);
});

test("history classifier permits one read-only pending interaction and rejects unsafe or ambiguous history", () => {
  const pending = { threadId: THREAD_ID, turnId: TURN_ID, itemId: ITEM_ID, questionIds: ["choice"] };
  const safe = classifyThreadHistory(readHistory(), pending);
  assert.equal(safe.safeContinuation, true);
  assert.equal(safe.matchingPendingInput, true);
  assert.equal(safe.pendingInputCount, 1);

  const explicitFull = classifyThreadHistory(readHistory({
    thread: {
      ...readHistory().thread,
      turns: [{ ...readHistory().thread.turns[0], itemsView: "full" }]
    }
  }), pending);
  assert.equal(explicitFull.safeContinuation, true);

  for (const itemsView of ["summary", "notLoaded", "futureView"]) {
    const incompleteView = classifyThreadHistory(readHistory({
      thread: {
        ...readHistory().thread,
        turns: [{ ...readHistory().thread.turns[0], itemsView }]
      }
    }), pending);
    assert.equal(incompleteView.safeContinuation, false);
    assert.equal(incompleteView.unclassified, true);
    assert.equal(incompleteView.historyClassification, "UNCLASSIFIED_HISTORY");
  }

  const questionsOnly = classifyThreadHistory(readHistory({
    thread: {
      id: THREAD_ID,
      turns: [{
        id: TURN_ID,
        status: "inProgress",
        items: [{
          type: "dynamicToolCall",
          id: ITEM_ID,
          status: "inProgress",
          tool: "request_user_input",
          arguments: { questions: userInputParams().questions }
        }]
      }]
    }
  }), pending);
  assert.equal(questionsOnly.safeContinuation, true);
  assert.equal(questionsOnly.matchingPendingInput, true);

  const questionsOnlyWithUnknownField = classifyThreadHistory(readHistory({
    thread: {
      id: THREAD_ID,
      turns: [{
        id: TURN_ID,
        status: "inProgress",
        items: [{
          type: "dynamicToolCall",
          id: ITEM_ID,
          status: "inProgress",
          tool: "request_user_input",
          arguments: {
            questions: userInputParams().questions,
            unexpected: "ignored"
          }
        }]
      }]
    }
  }), pending);
  assert.equal(questionsOnlyWithUnknownField.safeContinuation, false);

  const questionsOnlyWithWrongId = classifyThreadHistory(readHistory({
    thread: {
      id: THREAD_ID,
      turns: [{
        id: TURN_ID,
        status: "inProgress",
        items: [{
          type: "dynamicToolCall",
          id: ITEM_ID,
          status: "inProgress",
          tool: "request_user_input",
          arguments: {
            questions: [{ ...userInputParams().questions[0], id: "other-choice" }]
          }
        }]
      }]
    }
  }), pending);
  assert.equal(questionsOnlyWithWrongId.safeContinuation, false);

  const questionsOnlyWithSecretFlag = classifyThreadHistory(readHistory({
    thread: {
      id: THREAD_ID,
      turns: [{
        id: TURN_ID,
        status: "inProgress",
        items: [{
          type: "dynamicToolCall",
          id: ITEM_ID,
          status: "inProgress",
          tool: "request_user_input",
          arguments: {
            questions: [{ ...userInputParams().questions[0], isSecret: true }]
          }
        }]
      }]
    }
  }), pending);
  assert.equal(questionsOnlyWithSecretFlag.safeContinuation, false);

  const envelopeWithSecretFlag = classifyThreadHistory(readHistory({
    thread: {
      id: THREAD_ID,
      turns: [{
        id: TURN_ID,
        status: "inProgress",
        items: [{
          type: "dynamicToolCall",
          id: ITEM_ID,
          status: "inProgress",
          tool: "request_user_input",
          arguments: userInputParams({
            questions: [{ ...userInputParams().questions[0], isSecret: true }]
          })
        }]
      }]
    }
  }), pending);
  assert.equal(envelopeWithSecretFlag.safeContinuation, false);

  for (const extraItem of [
    { type: "commandExecution", id: "prior-command" },
    { type: "futureItem", id: "prior-unknown" }
  ]) {
    const extraTurn = classifyThreadHistory(readHistory({
      thread: {
        id: THREAD_ID,
        turns: [
          readHistory().thread.turns[0],
          { id: "turn-prior", status: "inProgress", items: [extraItem] }
        ]
      }
    }), pending);
    assert.equal(extraTurn.safeContinuation, false);
    assert.equal(extraTurn.matchingPendingInput, false);
  }

  const wrongItem = classifyThreadHistory(readHistory({
    thread: {
      id: THREAD_ID,
      turns: [{
        id: TURN_ID,
        status: "inProgress",
        items: [{
          type: "dynamicToolCall",
          id: "item-other",
          status: "inProgress",
          tool: "request_user_input",
          arguments: userInputParams({ itemId: "item-other" })
        }]
      }]
    }
  }), pending);
  assert.equal(wrongItem.safeContinuation, false);
  assert.equal(wrongItem.matchingPendingInput, false);

  const wrongQuestion = classifyThreadHistory(readHistory({
    thread: {
      id: THREAD_ID,
      turns: [{
        id: TURN_ID,
        status: "inProgress",
        items: [{
          type: "dynamicToolCall",
          id: ITEM_ID,
          status: "inProgress",
          tool: "request_user_input",
          arguments: userInputParams({
            questions: [{
              ...userInputParams().questions[0],
              id: "other-choice"
            }]
          })
        }]
      }]
    }
  }), pending);
  assert.equal(wrongQuestion.safeContinuation, false);
  assert.equal(wrongQuestion.matchingPendingInput, false);

  for (const type of ["commandExecution", "fileChange", "webSearch", "dynamicToolCall"]) {
    const result = classifyThreadHistory(readHistory({
      thread: {
        id: THREAD_ID,
        turns: [{
          id: TURN_ID,
          status: "inProgress",
          items: [{ type, id: "effectful-item" }]
        }]
      }
    }), pending);
    assert.equal(result.safeContinuation, false);
    assert.equal(result.effectful, true);
  }
  const unknown = classifyThreadHistory(readHistory({
    thread: {
      id: THREAD_ID,
      turns: [{ id: TURN_ID, status: "inProgress", items: [{ type: "futureItem", id: "future" }] }]
    }
  }), pending);
  assert.equal(unknown.safeContinuation, false);
  assert.equal(unknown.unclassified, true);

  const wrongThread = classifyThreadHistory(readHistory(), { ...pending, threadId: "thread-b" });
  assert.equal(wrongThread.safeContinuation, false);
  assert.equal(wrongThread.sameThread, false);

  const safeOnly = classifyThreadHistory({
    thread: {
      id: THREAD_ID,
      turns: [{ id: TURN_ID, status: "inProgress", items: [{ type: "userMessage", id: "history-user" }] }]
    }
  }, pending);
  assert.equal(safeOnly.safeContinuation, false);
  assert.equal(safeOnly.matchingPendingInput, false);

  for (const status of ["completed", "failed", "interrupted"]) {
    const terminal = classifyThreadHistory(readHistory({
      thread: {
        id: THREAD_ID,
        turns: [{
          id: TURN_ID,
          status,
          items: [{
            type: "dynamicToolCall",
            id: ITEM_ID,
            status: "inProgress",
            tool: "request_user_input",
            arguments: userInputParams()
          }]
        }]
      }
    }), pending);
    assert.equal(terminal.safeContinuation, false);
  }
});

test("recovery boundary chooses reissue, safe continuation, or bounded fail-closed C", () => {
  const reissue = createRecoveryBoundary();
  reissue.beginProcess(1);
  reissue.observeRequest({
    processGeneration: 1,
    requestId: 1,
    method: CODEX_APP_SERVER_METHODS.requestUserInput,
    params: userInputParams()
  });
  reissue.endProcess(1);
  reissue.beginProcess(2);
  reissue.observeRequest({
    processGeneration: 2,
    requestId: 2,
    method: CODEX_APP_SERVER_METHODS.requestUserInput,
    params: userInputParams()
  });
  assert.equal(reissue.decide(readHistory()).mode, RECOVERY_MODES.REISSUED_REQUEST);
  assert.deepEqual(reissue.answer({ choice: { answers: ["alpha"] } }), {
    answers: { choice: { answers: ["alpha"] } }
  });

  const continuation = createRecoveryBoundary();
  continuation.beginProcess(1);
  continuation.observeRequest({
    processGeneration: 1,
    requestId: 3,
    method: CODEX_APP_SERVER_METHODS.requestUserInput,
    params: userInputParams()
  });
  continuation.endProcess(1);
  continuation.beginProcess(2);
  assert.equal(continuation.decide(readHistory()).mode, RECOVERY_MODES.SAFE_CONTINUATION);
  assert.throws(
    () => continuation.startContinuation(TURN_ID),
    (error) => error.code === PROBE_ERROR_CODES.INVALID_REQUEST
  );
  const continuationAudit = continuation.startContinuation("turn-b");
  assert.equal(continuationAudit.oldTurnIdSha256, safeExternalIdHash(TURN_ID));
  assert.equal(continuationAudit.newTurnIdSha256, safeExternalIdHash("turn-b"));
  const continuationBudget = continuation.budgetSnapshot();
  assert.throws(
    () => continuation.startContinuation("turn-c"),
    (error) => error.code === PROBE_ERROR_CODES.CODEX_PENDING_INTERACTION_NOT_RESUMABLE
  );
  assert.deepEqual(continuation.budgetSnapshot(), continuationBudget);

  const unsafe = createRecoveryBoundary();
  unsafe.beginProcess(1);
  unsafe.observeRequest({
    processGeneration: 1,
    requestId: 4,
    method: CODEX_APP_SERVER_METHODS.requestUserInput,
    params: userInputParams()
  });
  unsafe.endProcess(1);
  unsafe.beginProcess(2);
  const decision = unsafe.decide(readHistory({
    thread: {
      id: THREAD_ID,
      turns: [{ id: TURN_ID, status: "inProgress", items: [{ type: "commandExecution", id: "command" }] }]
    }
  }));
  assert.equal(decision.mode, RECOVERY_MODES.NOT_RESUMABLE);
  assert.equal(decision.errorCode, PROBE_ERROR_CODES.CODEX_PENDING_INTERACTION_NOT_RESUMABLE);
  assert.equal(decision.unseenRequestDisposition, "NOT_ATTEMPTED_UNSEEN_REQUEST");
});

test("recovery boundary fail-closes on lease loss, cancellation, and duplicate continuation", () => {
  const boundary = createRecoveryBoundary();
  boundary.beginProcess(1);
  boundary.observeRequest({
    processGeneration: 1,
    requestId: 5,
    method: CODEX_APP_SERVER_METHODS.requestUserInput,
    params: userInputParams()
  });
  boundary.endProcess(1);
  boundary.beginProcess(2);
  boundary.loseLease();
  assert.equal(boundary.decide(readHistory()).errorCode, PROBE_ERROR_CODES.LEASE_LOST);

  const cancelled = createRecoveryBoundary();
  cancelled.beginProcess(1);
  cancelled.observeRequest({
    processGeneration: 1,
    requestId: 6,
    method: CODEX_APP_SERVER_METHODS.requestUserInput,
    params: userInputParams()
  });
  cancelled.endProcess(1);
  cancelled.beginProcess(2);
  cancelled.cancel();
  assert.equal(cancelled.decide(readHistory()).errorCode, PROBE_ERROR_CODES.CANCELLED);

  const budget = new ProbeBudget();
  budget.reserve("task");
  budget.reserve("restart");
  budget.reserve("answer");
  budget.reserve("continuation");
  assert.throws(() => budget.reserve("restart"), (error) => error.code === PROBE_ERROR_CODES.BUDGET_EXHAUSTED);
  assert.deepEqual(budget.snapshot().used, { task: 1, restart: 1, answer: 1, continuation: 1 });
});

test("safe continuation cannot reserve or start after a late reissued request", () => {
  const boundary = createRecoveryBoundary();
  boundary.beginProcess(1);
  boundary.observeRequest({
    processGeneration: 1,
    requestId: 7,
    method: CODEX_APP_SERVER_METHODS.requestUserInput,
    params: userInputParams()
  });
  boundary.endProcess(1);
  boundary.beginProcess(2);
  assert.equal(boundary.decide(readHistory()).mode, RECOVERY_MODES.SAFE_CONTINUATION);
  boundary.prepareContinuation();
  const reserved = boundary.budgetSnapshot();
  boundary.observeRequest({
    processGeneration: 2,
    requestId: 8,
    method: CODEX_APP_SERVER_METHODS.requestUserInput,
    params: userInputParams()
  });
  assert.throws(
    () => boundary.assertContinuationAllowed(),
    (error) => error.code === PROBE_ERROR_CODES.CODEX_PENDING_INTERACTION_NOT_RESUMABLE
  );
  assert.throws(
    () => boundary.startContinuation("turn-b"),
    (error) => error.code === PROBE_ERROR_CODES.CODEX_PENDING_INTERACTION_NOT_RESUMABLE
  );
  assert.deepEqual(boundary.budgetSnapshot(), reserved);
});

test("late current-process input after the bounded wait blocks the physical continuation write", async () => {
  const boundary = createRecoveryBoundary();
  boundary.beginProcess(1);
  boundary.observeRequest({
    processGeneration: 1,
    requestId: REQUEST_ID,
    method: CODEX_APP_SERVER_METHODS.requestUserInput,
    params: userInputParams()
  });
  boundary.endProcess(1);
  boundary.beginProcess(2);
  assert.equal(boundary.decide(readHistory()).mode, RECOVERY_MODES.SAFE_CONTINUATION);
  boundary.prepareContinuation();

  const observed = [];
  const { child, server } = await createProtocolServer({
    processGeneration: 2,
    onServerRequest: (request) => observed.push(boundary.observeRequest({
      ...request,
      processGeneration: 2
    }))
  });
  try {
    await assert.rejects(
      server.waitForUserInput(createMonotonicDeadline(20)),
      (error) => error.code === PROBE_ERROR_CODES.PROTOCOL_TIMEOUT
    );
    child.emitJson({
      id: REQUEST_ID,
      method: CODEX_APP_SERVER_METHODS.requestUserInput,
      params: userInputParams()
    });
    assert.equal(observed[0].kind, "REISSUED_MATCH");
    const writesBefore = child.writes.length;
    await assert.rejects(
      server.request(
        CODEX_APP_SERVER_METHODS.turnStart,
        { threadId: THREAD_ID, input: [] },
        createMonotonicDeadline(100),
        () => boundary.assertContinuationAllowed()
      ),
      (error) => error.code === PROBE_ERROR_CODES.CODEX_PENDING_INTERACTION_NOT_RESUMABLE
    );
    assert.equal(child.writes.length, writesBefore);
  } finally {
    await server.stop();
  }
});

test("targeted authentication survives failed probes with distinct runtimes and one retained home", async () => {
  const fixture = await createAuthFixture({}, true);
  try {
    const runs = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const fake = createFakeNative({ mode: "input-then-effectful" });
      const output = await runCodexRestartProbe({
        securityRemediationStatus: "RESOLVED_NO_REUSABLE_CREDENTIAL_EXPOSURE", offlineGatesPassed: true,
        codexPath: "/private/fake/codex", authMetadataPath: fixture.metadataPath, spawnProcess: fake.spawnProcess,
        testSeam: { verifyAuthMetadata, claimProbeConsumption, verifyPinnedCodex: async () => true,
          createProcessLifecycle: createCodeOwnedTestProcessLifecycle }
      });
      assert.equal(output.status, "FAIL");
      assert.equal(output.errorCode, PROBE_ERROR_CODES.EFFECTFUL_REQUEST_REJECTED);
      assert.equal(output.cleanup.processGroupGone, true);
      assert.equal(fake.spawnCalls[0].options.env.CODEX_HOME, fixture.paths.codexHome);
      assert.equal((await lstat(join(fixture.paths.codexHome, "auth.json"))).isFile(), true);
      await assert.rejects(lstat(join(fixture.root, ".phase9b-targeted-probe-active")), { code: "ENOENT" });
      runs.push({ runId: output.runId, cwd: fake.spawnCalls[0].options.cwd });
    }
    assert.notEqual(runs[0].runId, runs[1].runId);
    assert.notEqual(runs[0].cwd, runs[1].cwd);
    await rm(join(fixture.root, "targeted-auth-retention.json"));
    await assert.rejects(verifyAuthMetadata(fixture.metadataPath), error => error.code === PROBE_ERROR_CODES.AUTH_METADATA_INVALID);
  } finally {
    await fixture.cleanup();
  }
});

test("final authentication is candidate-bound and cannot be consumed by the standalone probe", async () => {
  const finalCandidateSha = "a".repeat(40);
  const fixture = await createAuthFixture({}, false, finalCandidateSha);
  try {
    const verified = await verifyAuthMetadata(fixture.metadataPath, { finalCandidateSha });
    assert.equal(verified.reusableFinalAuth, true);
    assert.equal(verified.candidateSha, finalCandidateSha);
    await assert.rejects(verifyAuthMetadata(fixture.metadataPath, { finalCandidateSha: "b".repeat(40) }),
      error => error.code === PROBE_ERROR_CODES.AUTH_METADATA_INVALID);
    const fake = createFakeNative({ mode: "input-then-effectful" });
    const output = await runCodexRestartProbe({
      securityRemediationStatus: "RESOLVED_NO_REUSABLE_CREDENTIAL_EXPOSURE", offlineGatesPassed: true,
      codexPath: "/private/fake/codex", authMetadataPath: fixture.metadataPath, spawnProcess: fake.spawnProcess,
      testSeam: { verifyAuthMetadata, claimProbeConsumption, verifyPinnedCodex: async () => true,
        createProcessLifecycle: createCodeOwnedTestProcessLifecycle }
    });
    assert.equal(output.status, "FAIL");
    assert.equal(output.errorCode, PROBE_ERROR_CODES.AUTH_METADATA_INVALID);
    assert.equal(output.taskCount, 0);
    assert.equal(fake.spawnCalls.length, 0);
    assert.equal((await lstat(join(fixture.paths.codexHome, "auth.json"))).isFile(), true);
  } finally {
    await fixture.cleanup();
  }
});

test("auth metadata requires the helper-owned runtime layout", async () => {
  const fixture = await createAuthFixture();
  try {
    const verified = await verifyAuthMetadata(fixture.metadataPath);
    assert.deepEqual(verified, {
      runId: fixture.metadata.runId,
      codexHome: fixture.paths.codexHome,
      runtimeRoot: fixture.root,
      allowedRoot: fixture.paths.allowedRoot,
      homeDirectory: fixture.paths.homeDirectory,
      tmpDirectory: fixture.paths.tmpDirectory,
      metadataRoot: fixture.root
    });

    const alternateRuntimeRoot = join(fixture.root, "alternate-runtime");
    await mkdir(join(alternateRuntimeRoot, "home"), { recursive: true, mode: 0o700 });
    await mkdir(join(alternateRuntimeRoot, "tmp"), { recursive: true, mode: 0o700 });
    await chmod(alternateRuntimeRoot, 0o700);
    await chmod(join(alternateRuntimeRoot, "home"), 0o700);
    await chmod(join(alternateRuntimeRoot, "tmp"), 0o700);
    await writeFile(fixture.metadataPath, `${JSON.stringify({
      ...fixture.metadata,
      runtimeRoot: alternateRuntimeRoot
    })}\n`);
    await chmod(fixture.metadataPath, 0o600);
    await assert.rejects(
      () => verifyAuthMetadata(fixture.metadataPath),
      (error) => error.code === PROBE_ERROR_CODES.AUTH_METADATA_INVALID
    );
  } finally {
    await fixture.cleanup();
  }
});

test("auth metadata rejects unknown fields, path replacement, symlinks, and oversized files", async () => {
  const cases = [
    async () => createAuthFixture({ unexpected: true }),
    async () => createAuthFixture({ authenticationCompleted: "true" }),
    async () => createAuthFixture({ codexHome: 7 }),
    async () => createAuthFixture({ allowedRoot: "../outside" }),
    async () => {
      const fixture = await createAuthFixture();
      await rm(fixture.metadataPath);
      const target = join(fixture.root, "metadata-target.json");
      await writeFile(target, `${JSON.stringify(fixture.metadata)}\n`, { mode: 0o600 });
      await chmod(target, 0o600);
      await symlink(target, fixture.metadataPath);
      return fixture;
    },
    async () => {
      const fixture = await createAuthFixture();
      await rm(join(fixture.paths.codexHome, "auth.json"));
      const target = join(fixture.root, "auth-target.json");
      await writeFile(target, "opaque", { mode: 0o600 });
      await chmod(target, 0o600);
      await symlink(target, join(fixture.paths.codexHome, "auth.json"));
      return fixture;
    },
    async () => {
      const fixture = await createAuthFixture();
      await chmod(fixture.metadataPath, 0o640);
      return fixture;
    },
    async () => {
      const fixture = await createAuthFixture();
      const renamedPath = join(fixture.root, "metadata-copy.json");
      await rename(fixture.metadataPath, renamedPath);
      fixture.metadataPath = renamedPath;
      return fixture;
    },
    async () => {
      const fixture = await createAuthFixture();
      await writeFile(fixture.metadataPath, Buffer.alloc(16 * 1024 + 1));
      await chmod(fixture.metadataPath, 0o600);
      return fixture;
    },
    async () => {
      const fixture = await createAuthFixture();
      await writeFile(join(fixture.paths.codexHome, "auth.json"), Buffer.alloc(64 * 1024 + 1));
      await chmod(join(fixture.paths.codexHome, "auth.json"), 0o600);
      return fixture;
    }
  ];
  for (const createCase of cases) {
    const fixture = await createCase();
    try {
      await assert.rejects(
        () => verifyAuthMetadata(fixture.metadataPath),
        (error) => error.code === PROBE_ERROR_CODES.AUTH_METADATA_INVALID
      );
    } finally {
      await fixture.cleanup();
    }
  }
});

test("auth probe consumption is a synced one-time marker with bounded metadata", async () => {
  const fixture = await createAuthFixture();
  try {
    const verified = await verifyAuthMetadata(fixture.metadataPath);
    const markerPath = await claimProbeConsumption(verified.metadataRoot, verified.runId);
    const markerStat = await lstat(markerPath);
    assert.equal(markerStat.isFile(), true);
    assert.equal(markerStat.mode & 0o777, 0o600);
    assert.equal(markerStat.uid, process.getuid?.() ?? markerStat.uid);
    await assert.rejects(
      () => claimProbeConsumption(verified.metadataRoot, verified.runId),
      (error) => error.code === PROBE_ERROR_CODES.PROBE_ALREADY_CONSUMED
    );
  } finally {
    await fixture.cleanup();
  }
});

test("restart probe gates security and focused offline proof before any child", async () => {
  let spawnCount = 0;
  const cases = [
    {
      securityRemediationStatus: undefined,
      offlineGatesPassed: true,
      errorCode: PROBE_ERROR_CODES.SECURITY_GATE_REQUIRED
    },
    {
      securityRemediationStatus: "RESOLVED_NO_REUSABLE_CREDENTIAL_EXPOSURE",
      offlineGatesPassed: false,
      errorCode: PROBE_ERROR_CODES.OFFLINE_GATES_REQUIRED
    }
  ];
  for (const input of cases) {
    const output = await runCodexRestartProbe({
      ...input,
      authMetadataPath: "/private/phase9b-missing/login-metadata.json",
      codexPath: "/private/phase9b-missing/codex",
      spawnProcess: () => {
        spawnCount += 1;
        throw new Error("unexpected child");
      }
    });
    assert.equal(output.errorCode, input.errorCode);
    assert.equal(output.status, input.errorCode === PROBE_ERROR_CODES.SECURITY_GATE_REQUIRED
      ? "BLOCKED_SECURITY_REMEDIATION"
      : "UNVERIFIED");
  }
  assert.equal(spawnCount, 0);
});

test("public probe completes a controlled reissued request through the fake native seam", async () => {
  const fixture = await createAuthFixture();
  const fake = createFakeNative();
  const verification = [];
  try {
    const output = await runCodexRestartProbe({
      securityRemediationStatus: "RESOLVED_NO_REUSABLE_CREDENTIAL_EXPOSURE",
      offlineGatesPassed: true,
      codexPath: "/private/fake/codex",
      authMetadataPath: fixture.metadataPath,
      spawnProcess: fake.spawnProcess,
      testSeam: {
        verifyAuthMetadata: async () => {
          verification.push("auth");
          return {
            runId: fixture.metadata.runId,
            codexHome: fixture.paths.codexHome,
            runtimeRoot: fixture.root,
            allowedRoot: fixture.paths.allowedRoot,
            homeDirectory: fixture.paths.homeDirectory,
            tmpDirectory: fixture.paths.tmpDirectory,
            metadataRoot: fixture.root
          };
        },
        verifyPinnedCodex: async () => {
          verification.push("pinned");
          return true;
        },
        claimProbeConsumption: async () => {
          verification.push("claimed");
          return join(fixture.root, "probe-marker");
        },
        createProcessLifecycle: createCodeOwnedTestProcessLifecycle
      }
    });
    assert.equal(output.status, "PASS");
    assert.equal(output.answerCount, 1);
    assert.equal(output.restartCount, 1);
    assert.equal(output.resolvedObserved, false);
    assert.equal(output.permissionProfileConfirmed, true);
    assert.deepEqual(verification, ["auth", "claimed", "pinned", "pinned"]);
    assert.equal(fake.children.length, 2);
    assert.equal(fake.children[0].signal, "SIGTERM");
    assert.equal(fake.children[1].signal, "SIGTERM");
    assert.equal(fake.spawnCalls[0].options.cwd, fixture.paths.allowedRoot);
    assert.equal(fake.spawnCalls[1].options.cwd, fixture.paths.allowedRoot);
    assert.equal(fake.spawnCalls.every(({ options }) => options.env.PATH === TEST_PROCESS_PATH), true);
    const initializations = fake.children.flatMap(child => child.writes)
      .filter(message => message.method === CODEX_APP_SERVER_METHODS.initialize);
    assert.equal(initializations.length, 2);
    for (const initialization of initializations) {
      assert.equal(initialization.params.capabilities.experimentalApi, false);
      assert.equal(initialization.params.capabilities.requestAttestation, false);
      assert.deepEqual(initialization.params.capabilities.optOutNotificationMethods, ["remoteControl/status/changed", "mcpServer/startupStatus/updated", "thread/goal/cleared"]);
    }
    const starts = fake.children.flatMap((child) => child.writes)
      .filter((message) => message.method === CODEX_APP_SERVER_METHODS.threadStart
        || message.method === CODEX_APP_SERVER_METHODS.threadResume);
    assert.equal(starts.some((message) => Object.hasOwn(message.params, "permissions")), false);
  } finally {
    await fixture.cleanup();
  }
});

test("CLI routes SIGINT and SIGTERM through the actual probe finally and owned lifecycle", {
  skip: process.platform === "win32",
  timeout: 10_000
}, async () => {
  const moduleUrl = JSON.stringify(new URL("./codex-restart-probe.mjs", import.meta.url).href);
  const nativeScript = `
    const profileId = process.argv[1];
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      input += chunk;
      let index;
      while ((index = input.indexOf("\\n")) >= 0) {
        const line = input.slice(0, index);
        input = input.slice(index + 1);
        const message = JSON.parse(line);
        if (message.method === "initialize") {
          process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n");
        } else if (message.method === "thread/start") {
          process.stdout.write(JSON.stringify({
            id: message.id,
            result: {
              thread: { id: "native-thread" },
              activePermissionProfile: { id: profileId }
            }
          }) + "\\n");
        } else if (message.method === "turn/start") {
          process.stdout.write(JSON.stringify({ id: message.id, result: { turn: { id: "native-turn" } } }) + "\\n");
        }
      }
    });
  `;
  const childScript = `
    import { mkdir, mkdtemp, rm } from "node:fs/promises";
    import { spawn } from "node:child_process";
    import { tmpdir } from "node:os";
    import { join } from "node:path";
    import { runCodexRestartProbe, runProbeCli, createNativeProcessLifecycle } from ${moduleUrl};
    const root = await mkdtemp(join(tmpdir(), "probe-cli-owned-"));
    const paths = {
      codexHome: join(root, "codex-home"),
      allowedRoot: join(root, "allowed-root"),
      homeDirectory: join(root, "home"),
      tmpDirectory: join(root, "tmp")
    };
    await Promise.all(Object.values(paths).map((path) => mkdir(path, { mode: 0o700 })));
    const nativeScript = ${JSON.stringify(nativeScript)};
    const spawnProcess = (_command, args, options) => {
      const profileArg = args.find((value) => value.startsWith("default_permissions="));
      const profileId = profileArg?.slice('default_permissions="'.length, -1);
      const child = spawn(process.execPath, ["-e", nativeScript, profileId], options);
      child.once("spawn", () => {
        process.send?.({ type: "probe-owned-app-server-spawn", pid: child.pid });
      });
      return child;
    };
    const runProbe = ({ signal }) => runCodexRestartProbe({
      securityRemediationStatus: "RESOLVED_NO_REUSABLE_CREDENTIAL_EXPOSURE",
      offlineGatesPassed: true,
      codexPath: process.execPath,
      authMetadataPath: join(root, "login-metadata.json"),
      spawnProcess,
      signal,
      maxDurationMs: 60_000,
      testSeam: {
        verifyAuthMetadata: async () => ({
          runId: "123e4567-e89b-42d3-a456-426614174000",
          codexHome: paths.codexHome,
          runtimeRoot: root,
          allowedRoot: paths.allowedRoot,
          homeDirectory: paths.homeDirectory,
          tmpDirectory: paths.tmpDirectory,
          metadataRoot: root
        }),
        verifyPinnedCodex: async () => true,
        claimProbeConsumption: async () => join(root, "probe-marker"),
        createProcessLifecycle: createNativeProcessLifecycle
      }
    });
    try {
      process.exitCode = await runProbeCli({ argv: ["node", "probe", "--run"], runProbe });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  `;
  for (const signal of ["SIGTERM", "SIGINT"]) {
    const child = nodeSpawn(process.execPath, ["--input-type=module", "-e", childScript], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "ignore", "ipc"]
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    let ownedPid;
    try {
      const handshake = await waitForOwnedProcessHandshake(child);
      ownedPid = handshake.pid;
      assert.equal(isProcessGroupGone(ownedPid), false);
      child.kill(signal);
      const [exitCode] = await new Promise((resolve) => child.once("close", (code) => resolve([code])));
      const lines = stdout.trim().split("\\n").filter(Boolean).map((line) => JSON.parse(line));
      assert.equal(exitCode, 1);
      assert.equal(lines.length, 1);
      assert.equal(lines[0].status, "CANCELLED");
      assert.equal(lines[0].errorCode, "CANCELLED");
      assert.equal(lines[0].cleanup.completed, true);
      assert.equal(lines[0].cleanup.processGroupGone, true);
      assert.equal(await waitForOwnedProcessGroupGone(ownedPid), true);
    } finally {
      if (ownedPid !== undefined && !await waitForOwnedProcessGroupGone(ownedPid)) {
        try {
          process.kill(-ownedPid, "SIGKILL");
        } catch {
          // The owned process group may already have disappeared.
        }
        await waitForOwnedProcessGroupGone(ownedPid);
      }
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  }
});

test("public probe accepts a delayed reissued request within the decision window", async () => {
  const output = await runPublicFakeProbe("delayed-reissue");
  assert.equal(output.status, "PASS");
  assert.equal(output.mode, RECOVERY_MODES.REISSUED_REQUEST);
  assert.equal(output.answerCount, 1);
  assert.equal(output.restartCount, 1);
});

test("public probe records failed and interrupted completion instead of timeout", async () => {
  for (const [mode, status] of [["failed-completion", "failed"], ["interrupted-completion", "interrupted"]]) {
    const output = await runPublicFakeProbe(mode);
    assert.equal(output.status, "FAIL");
    assert.equal(output.turnCompletionObserved, true);
    assert.equal(output.turnCompletionStatus, status);
    assert.notEqual(output.errorCode, PROBE_ERROR_CODES.PROTOCOL_TIMEOUT);
  }
});

test("public probe preserves terminal facts observed while the first process stops", async () => {
  for (const mode of ["late-stop-completion", "late-stop-error"]) {
    const output = await runPublicFakeProbe(mode, { maxDurationMs: 1_000 });
    assert.equal(output.status, "FAIL");
    assert.equal(output.restartCount, 0);
    assert.equal(output.answerCount, 0);
    assert.equal(output.continuationCount, 0);
    if (mode === "late-stop-completion") {
      assert.equal(output.turnCompletionObserved, true);
      assert.equal(output.turnCompletionStatus, "completed");
    } else {
      assert.equal(output.errorCode, PROBE_ERROR_CODES.PROBE_RUNTIME_ERROR);
    }
  }
});

test("public probe preserves fatal facts observed while the second process stops", async () => {
  for (const mode of ["late-second-stop-error", "late-second-stop-effectful"]) {
    const output = await runPublicFakeProbe(mode, { maxDurationMs: 12_000 });
    assert.equal(output.status, "FAIL");
    assert.equal(output.errorCode, mode === "late-second-stop-error"
      ? PROBE_ERROR_CODES.PROBE_RUNTIME_ERROR
      : PROBE_ERROR_CODES.EFFECTFUL_REQUEST_REJECTED);
    assert.equal(output.restartCount, 1);
    assert.equal(output.answerCount, 1);
    assert.equal(output.continuationCount, 0);
    assert.equal(output.turnCompletionObserved, true);
    assert.equal(output.turnCompletionStatus, "completed");
  }
});

test("public probe treats a reissue resolved in the same batch as runtime failure", async () => {
  const output = await runPublicFakeProbe("reissued-resolved");
  assert.equal(output.status, "FAIL");
  assert.equal(output.errorCode, PROBE_ERROR_CODES.REQUEST_ALREADY_RESOLVED);
  assert.equal(output.resolvedObserved, true);
  assert.equal(output.restartCount, 1);
  assert.equal(output.answerCount, 0);
  assert.equal(output.continuationCount, 0);
});

test("public safe continuation records observed failed or interrupted completion", async () => {
  for (const [mode, status] of [["continuation-failed", "failed"], ["continuation-interrupted", "interrupted"]]) {
    const output = await runPublicFakeProbe(mode, { maxDurationMs: 12_000 });
    assert.equal(output.status, "FAIL");
    assert.equal(output.turnCompletionObserved, true);
    assert.equal(output.turnCompletionStatus, status);
    assert.equal(output.responseAccepted, false);
    assert.equal(output.errorCode, PROBE_ERROR_CODES.PROBE_RUNTIME_ERROR);
    assert.equal(output.answerCount, 1);
    assert.equal(output.continuationCount, 1);
  }
});

test("public continuation records the confirmed action before a same-batch late request fails the flow", async () => {
  const capture = {};
  const output = await runPublicFakeProbe("continuation-late-reissue", {
    maxDurationMs: 12_000,
    capture
  });
  assert.equal(output.status, "FAIL");
  assert.equal(output.errorCode, PROBE_ERROR_CODES.CODEX_PENDING_INTERACTION_NOT_RESUMABLE);
  assert.equal(output.mode, RECOVERY_MODES.SAFE_CONTINUATION);
  assert.equal(output.answerCount, 1);
  assert.equal(output.continuationCount, 1);
  assert.equal(output.oldTurnIdSha256, safeExternalIdHash("native-turn"));
  assert.equal(output.newTurnIdSha256, safeExternalIdHash("continuation-turn"));
  assert.deepEqual(output.budget.used, { task: 1, restart: 1, answer: 1, continuation: 1 });
  assert.equal(capture.fake.children[1].writes.filter((message) =>
    message.id === REQUEST_ID && Object.hasOwn(message, "result")).length, 0);
});

test("public safe continuation rejects completed turns with a native error while retaining confirmed actions", async () => {
  const output = await runPublicFakeProbe("continuation-completed-error", { maxDurationMs: 12_000 });
  assert.equal(output.status, "FAIL");
  assert.equal(output.errorCode, PROBE_ERROR_CODES.PROBE_RUNTIME_ERROR);
  assert.equal(output.turnCompletionObserved, true);
  assert.equal(output.turnCompletionStatus, "completed");
  assert.equal(output.responseAccepted, false);
  assert.equal(output.answerCount, 1);
  assert.equal(output.continuationCount, 1);
  assert.deepEqual(output.budget.used, { task: 1, restart: 1, answer: 1, continuation: 1 });
});

test("public probe does not treat initial resolved or completed input as pending", async () => {
  for (const mode of ["initial-resolved", "initial-completed"]) {
    const output = await runPublicFakeProbe(mode);
    assert.equal(output.status, "FAIL");
    assert.equal(output.restartCount, 0);
    assert.equal(output.answerCount, 0);
    assert.equal(output.errorCode, mode === "initial-resolved"
      ? PROBE_ERROR_CODES.CODEX_PENDING_INTERACTION_NOT_RESUMABLE
      : PROBE_ERROR_CODES.PROBE_RUNTIME_ERROR);
  }
});

test("public probe reports RPC failure instead of protocol limitation C", async () => {
  const output = await runPublicFakeProbe("read-error");
  assert.equal(output.status, "FAIL");
  assert.equal(output.errorCode, PROBE_ERROR_CODES.PROBE_RUNTIME_ERROR);
  assert.equal(output.mode, undefined);
});

test("run cancellation stops the active public flow before restart", async () => {
  const controller = new AbortController();
  const operation = runPublicFakeProbe("no-initial-request", { signal: controller.signal });
  await waitForProcessStartup();
  controller.abort();
  const output = await operation;
  assert.equal(output.status, "CANCELLED");
  assert.equal(output.errorCode, PROBE_ERROR_CODES.CANCELLED);
  assert.equal(output.restartCount, 0);
  assert.equal(output.answerCount, 0);
  assert.equal(output.cleanup.completed, true);
  assert.equal(output.cleanup.processGroupGone, true);
});

test("public probe waits for expected absence before bounded C", async () => {
  const output = await runPublicFakeProbe("no-reissue", { maxDurationMs: 10_000 });
  assert.equal(output.status, "BLOCKED_CODEX_PROTOCOL_LIMITATION");
  assert.equal(output.mode, RECOVERY_MODES.NOT_RESUMABLE);
  assert.equal(output.restartCount, 1);
  assert.equal(output.answerCount, 0);
  assert.equal(output.continuationCount, 0);
});

test("public probe performs one bounded safe continuation with one answer budget", async () => {
  const output = await runPublicFakeProbe("continuation", { maxDurationMs: 10_000 });
  assert.equal(output.status, "PASS");
  assert.equal(output.mode, RECOVERY_MODES.SAFE_CONTINUATION);
  assert.equal(output.continuationCount, 1);
  assert.equal(output.answerCount, 1);
  assert.deepEqual(output.budget.used, { task: 1, restart: 1, answer: 1, continuation: 1 });
});

test("safe continuation retains confirmed answer and continuation facts after cancellation", async () => {
  const controller = new AbortController();
  const output = await runPublicFakeProbe("continuation", {
    maxDurationMs: 12_000,
    signal: controller.signal,
    onTurnStartResponse: ({ generation }) => {
      if (generation === 2) {
        controller.abort();
      }
    }
  });
  assert.equal(output.status, "CANCELLED");
  assert.equal(output.errorCode, PROBE_ERROR_CODES.CANCELLED);
  assert.equal(output.answerCount, 1);
  assert.equal(output.continuationCount, 1);
  assert.equal(output.budget.used.answer, 1);
  assert.equal(output.budget.used.continuation, 1);
});

test("controlled task instruction contract names the fixed question and ordered choices", async () => {
  const fixture = await createAuthFixture();
  const fake = createFakeNative();
  try {
    await runCodexRestartProbe({
      securityRemediationStatus: "RESOLVED_NO_REUSABLE_CREDENTIAL_EXPOSURE",
      offlineGatesPassed: true,
      codexPath: "/private/fake/codex",
      authMetadataPath: fixture.metadataPath,
      spawnProcess: fake.spawnProcess,
      maxDurationMs: 1_000,
      testSeam: {
        verifyAuthMetadata: async () => ({
          runId: fixture.metadata.runId,
          codexHome: fixture.paths.codexHome,
          runtimeRoot: fixture.root,
          allowedRoot: fixture.paths.allowedRoot,
          homeDirectory: fixture.paths.homeDirectory,
          tmpDirectory: fixture.paths.tmpDirectory,
          metadataRoot: fixture.root
        }),
        verifyPinnedCodex: async () => true,
        claimProbeConsumption: async () => join(fixture.root, "probe-marker"),
        createProcessLifecycle: createCodeOwnedTestProcessLifecycle
      }
    });
    const turnStart = fake.children[0].writes.find((message) =>
      message.method === CODEX_APP_SERVER_METHODS.turnStart);
    assert.equal(typeof turnStart?.params?.input?.[0]?.text, "string");
    assert.match(turnStart.params.input[0].text, /one question/);
    assert.match(turnStart.params.input[0].text, /id choice/);
    assert.doesNotMatch(turnStart.params.input[0].text, /isOther false/);
    assert.match(turnStart.params.input[0].text, /Omit autoResolutionMs/);
    assert.match(turnStart.params.input[0].text, /isSecret false/);
    assert.match(turnStart.params.input[0].text, /alpha.*beta/);
  } finally {
    await fixture.cleanup();
  }
});

test("product permission arguments and environment are fixed and caller additions are rejected", () => {
  const args = buildProductPermissionArguments({
    taskId: "123e4567-e89b-42d3-a456-426614174000",
    allowedRoot: "/private/owned/allowed-root"
  });
  assert.equal(args[0], "app-server");
  assert.equal(args.includes("-c"), true);
  assert.equal(args.some((value) => value.includes("features.default_mode_request_user_input=true")), true);
  assert.equal(args.some((value) => value.includes("features.request_permissions_tool=true")), true);
  assert.equal(args.some((value) => value.includes("default_permissions=")), true);
  assert.equal(args.some((value) => value.includes("network.enabled=false")), true);
  assert.equal(args.some((value) => value.includes("cli_auth_credentials_store=\"file\"")), true);
  assert.equal(args.some((value) => value.includes("model=")), false);
  // Codex parses -c paths as dotted keys; quoting a path segment would
  // create a different catalog key from the selected profile id.
  const selectedProfile = "jarvis-task-123e4567e89b42d3a456426614174000";
  const profilePaths = args.filter(value => value.startsWith("permissions."))
    .map(value => value.slice(0, value.indexOf("=")));
  assert.deepEqual(profilePaths, [
    `permissions.${selectedProfile}.filesystem`,
    `permissions.${selectedProfile}.network.enabled`
  ]);

  const environment = buildProbeEnvironment({
    codexHome: "/private/owned/codex-home",
    tmpDirectory: "/private/owned/tmp",
    allowedRoot: "/private/owned/allowed-root",
    homeDirectory: "/private/owned/home",
    path: "/usr/bin:/bin"
  });
  assert.deepEqual(Object.keys(environment).sort(), [
    "CODEX_HOME", "HOME", "JARVIS_ALLOWED_ROOT", "LANG", "PATH", "TMPDIR", "cli_auth_credentials_store"
  ].sort());
  assert.equal(environment.cli_auth_credentials_store, "file");
  assert.throws(
    () => buildProbeEnvironment({
      codexHome: "/private/owned/codex-home",
      tmpDirectory: "/private/owned/tmp",
      allowedRoot: "/private/owned/allowed-root",
      homeDirectory: "/private/owned/home",
      path: "p".repeat(1_025)
    }),
    (error) => error.code === PROBE_ERROR_CODES.INVALID_ENVIRONMENT
  );
  assert.throws(
    () => buildProbeEnvironment({ codexHome: "/private/owned/codex-home", unexpected: "value" }),
    (error) => error.code === PROBE_ERROR_CODES.INVALID_ENVIRONMENT
  );
});
