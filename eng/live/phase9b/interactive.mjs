import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { lstat, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { loadProviderConfig } from "./credentials.mjs";
import { createBudgetTracker, withTimeout } from "./budgets.mjs";
import { createRunIsolation, adoptExternalCodexHome, assertSafeTempRoot, writePrivateJson } from "./isolation.mjs";
import { verifyAuthMetadata } from "./codex-restart-probe.mjs";
import { ProcessSupervisor } from "./process-supervisor.mjs";
import { LaunchdSupervisor } from "./launchd-supervisor.mjs";
import { runPreflight } from "./preflight.mjs";
import { scanKnownSecrets, validateSecurityRemediationStatus } from "./evidence.mjs";
import { createAdmissionServer } from "./admission.mjs";
import { sanitizeInteractiveOutput } from "./desktop-automation.mjs";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const API_READY_TIMEOUT_MS = 30_000;
const DEVICE_READY_TIMEOUT_MS = 30_000;
const OBSERVATION_TIMEOUT_MS = 10_000;
const MAX_COMMAND_BYTES = 2_048;
const MAX_HTTP_BODY_BYTES = 512 * 1024;
const STARTUP_PROVIDER_REQUEST_RESERVATION = 2;
const STARTUP_REALTIME_CONNECTION_RESERVATION = 1;
const DEFAULT_BUDGET_POLL_MS = 1_000;
const DEFAULT_INTERACTIVE_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_INTERACTIVE_TIMEOUT_MS = 30 * 60 * 1000;

export const INTERACTIVE_COMMANDS = Object.freeze(["prepare", "start", "observe", "stop", "restart", "finish"]);
export const INTERACTIVE_SERVICES = Object.freeze(["api", "deviceNode", "desktop"]);

export function parseInteractiveCommand(line) {
  if (typeof line !== "string" || line.length === 0 || Buffer.byteLength(line, "utf8") > MAX_COMMAND_BYTES) {
    throw safeError("INVALID_COMMAND", "Interactive command is invalid.");
  }
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    throw safeError("INVALID_COMMAND", "Interactive command is invalid.");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype
      || typeof value.command !== "string"
      || !INTERACTIVE_COMMANDS.includes(value.command)) {
    throw safeError("INVALID_COMMAND", "Interactive command is invalid.");
  }
  if (value.command === "observe") {
    const keys = Object.keys(value);
    if (keys.some((key) => key !== "command" && key !== "conversationId")) {
      throw safeError("INVALID_COMMAND", "Interactive command is invalid.");
    }
    if (value.conversationId !== undefined && !UUID_PATTERN.test(value.conversationId)) {
      throw safeError("INVALID_COMMAND", "Interactive command is invalid.");
    }
    return value.conversationId === undefined
      ? { command: value.command }
      : { command: value.command, conversationId: value.conversationId };
  }
  if (value.command === "stop" || value.command === "restart") {
    if (Object.keys(value).length !== 2
        || typeof value.service !== "string"
        || !INTERACTIVE_SERVICES.includes(value.service)) {
      throw safeError("INVALID_COMMAND", "Interactive command is invalid.");
    }
    return { command: value.command, service: value.service };
  }
  if (Object.keys(value).length !== 1) {
    throw safeError("INVALID_COMMAND", "Interactive command is invalid.");
  }
  return { command: value.command };
}

export function createInteractiveSession(options = {}) {
  return new InteractiveSession(options);
}

export class InteractiveSession {
  #options;
  #isolation;
  #preflight;
  #providerResult;
  #providerConfig;
  #securityRemediationStatus = "UNVERIFIED";
  #budget;
  #providerPreflightCalls = 0;
  #supervisor;
  #launchdSupervisor;
  #launchdMode;
  #privatePaths = {};
  #nonce;
  #secretValues = [];
  #handles = new Map();
  #budgetFailure;
  #admissionFatalStop;
  #cleanupFailure;
  #budgetSupervisorTimer;
  #budgetSupervisionInFlight;
  #startupBudgetAdmission;
  #admission;
  #shutdownController = new AbortController();
  #finishPromise;
  #activeOperation;
  #prepareResult;
  #startResult;
  #prepared = false;
  #started = false;
  #finished = false;

  constructor(options = {}) {
    if (options.rotationAfterMs !== undefined
      && (!Number.isSafeInteger(options.rotationAfterMs)
        || options.rotationAfterMs < 20_000 || options.rotationAfterMs > 120_000)) {
      throw safeError("INVALID_COMMAND", "Live rotation interval is invalid.");
    }
    this.#options = options;
    this.#launchdMode = options.useLaunchd === true || options.launchdSupervisor !== undefined
      || options.launchdSupervisorFactory !== undefined;
    this.#supervisor = options.processSupervisor ?? new ProcessSupervisor({
      maxRestarts: 0,
      timeoutMs: 30_000,
      killGraceMs: 1_000
    });
  }

  get runId() {
    return this.#isolation?.runId ?? null;
  }

  get isolation() {
    return this.#isolation;
  }

  get preflight() {
    return this.#preflight;
  }

  get privatePaths() {
    return { ...this.#privatePaths };
  }

  get budget() {
    return this.#budget;
  }

  async prepare() {
    return await this.#runExclusive(() => this.#prepareCore());
  }

  async #prepareCore() {
    if (this.#finished) {
      throw safeError("INVALID_COMMAND_STATE", "Interactive session is finished.");
    }
    if (this.#prepared) {
      return this.#prepareResult;
    }

    const options = this.#options;
    this.#securityRemediationStatus = this.#readSecurityRemediationStatus();
    if (this.#securityRemediationStatus !== "RESOLVED_NO_REUSABLE_CREDENTIAL_EXPOSURE") {
      this.#prepared = true;
      this.#prepareResult = {
        schemaVersion: 1,
        status: "BLOCKED_SECURITY_REMEDIATION",
        securityRemediation: { status: "BLOCKED_SECURITY_REMEDIATION" },
        errorCategory: "BLOCKED_SECURITY_REMEDIATION"
      };
      return this.#prepareResult;
    }
    this.#isolation = await createRunIsolation({
      repositoryRoot: options.repositoryRoot ?? process.cwd(),
      homeDirectory: options.homeDirectory ?? homedir(),
      baseDirectory: options.baseDirectory,
      runId: options.runId ?? randomUUID()
    });
    try {
      this.#assertActive();
      if ((options.providerConfig === undefined && !isAbsolute(options.userSecretsPath ?? ""))
        || (options.userSecretsPath !== undefined && !isAbsolute(options.userSecretsPath))) {
        throw safeError("INVALID_PROVIDER_CONFIG", "An absolute private provider source is required.");
      }
      this.#budget = createBudgetTracker(options.budgetOptions);
      this.#preflight = options.preflightResult ?? await runPreflight({
        repositoryRoot: options.repositoryRoot ?? process.cwd(),
        homeDirectory: options.homeDirectory ?? homedir(),
        noProviderCall: true,
        ...options.preflightOptions,
        userSecretsPath: options.userSecretsPath,
        providerEnvironment: {},
        codexPath: options.codexPath ?? options.preflightOptions?.codexPath ?? process.env.PHASE9B_CODEX_PATH
      });
      this.#assertActive();
      this.#seedProviderBudget();

      this.#providerResult = options.providerConfig === undefined
        ? await (options.providerLoader ?? loadProviderConfig)({
          repositoryRoot: options.repositoryRoot ?? process.cwd(),
          homeDirectory: options.homeDirectory ?? homedir(),
          env: {},
          userSecretsPath: options.userSecretsPath
        })
        : providerResultFor(options.providerConfig);
      this.#assertActive();
      this.#providerConfig = this.#providerResult?.config ?? options.providerConfig;
      this.#secretValues = collectSecretValues(this.#providerConfig, this.#isolation);

      await this.#writeNonceFixture();
      if (options.targetedAuthMetadataPath !== undefined) {
        if (options.externalCodexHome !== undefined) {
          throw safeError("UNSAFE_CODEX_HOME", "Authentication source is ambiguous.");
        }
        const authentication = await verifyAuthMetadata(options.targetedAuthMetadataPath);
        if (authentication.reusableTargetedAuth !== true) {
          throw safeError("UNSAFE_CODEX_HOME", "Targeted authentication retention is required.");
        }
        await assertSafeTempRoot(authentication.codexHome, { repositoryRoot: this.#isolation.root });
        this.#isolation.runtimeEnvironment.CODEX_HOME = authentication.codexHome;
      } else if (options.externalCodexHome !== undefined) {
        await adoptExternalCodexHome(options.externalCodexHome, this.#isolation, {
          allowedBinaryPath: options.codexPath ?? process.env.PHASE9B_CODEX_PATH
        });
      }

      const blockedStatus = firstBlockedStatus(this.#preflight?.status, this.#providerResult?.status);
      if (blockedStatus !== null) {
        this.#prepared = true;
        this.#prepareResult = this.#safePrepareResult(blockedStatus);
        return this.#prepareResult;
      }
      validateProviderShape(this.#providerConfig);
      this.#admission = await createAdmissionServer({
        root: this.#isolation.root,
        runId: this.#isolation.runId,
        initialUsed: { providerRequests: this.#providerPreflightCalls },
        limits: this.#budget.snapshot().limits,
        onFatal: (category) => this.#handleAdmissionFatal(category)
      });
      this.#privatePaths.admissionDescriptorPath = this.#admission.descriptorPath;
      this.#privatePaths.admissionTokenPath = this.#admission.tokenPath;
      this.#secretValues = [...this.#secretValues, this.#admission.token];
      await this.#writeRuntimeConfiguration();
      this.#prepared = true;
      this.#prepareResult = this.#safePrepareResult("PREPARED");
      return this.#prepareResult;
    } catch (error) {
      if (error?.code === "BUDGET_EXHAUSTED") {
        this.#budgetFailure ??= error;
      }
      try {
        await this.#supervisor.stopAll?.();
      } catch {
        // Preserve the original preparation failure; no runtime is usable.
      }
      await Promise.resolve(this.#admission?.stop?.()).catch(() => {});
      try {
        await this.#isolation.cleanup();
        this.#finished = true;
      } catch {
        // Keep the session available for finish() to retry owned cleanup.
      }
      throw error;
    }
  }

  async start() {
    return await this.#runExclusive(() => this.#startCore());
  }

  async stop(service) {
    return await this.#runExclusive(() => this.#stopCore(service));
  }

  async restart(service) {
    return await this.#runExclusive(() => this.#restartCore(service));
  }

  async #startCore() {
    try {
      return await this.#startCoreUnchecked();
    } catch (error) {
      if (error?.code === "BUDGET_EXHAUSTED") {
        this.#budgetFailure ??= error;
      }
      if (this.#isolation === undefined || this.#finished) {
        throw error;
      }
      const processesStopped = await this.#stopOwnedProcesses();
      if (!processesStopped) {
        if (error?.code !== "BUDGET_EXHAUSTED") {
          throw this.#cleanupFailure ?? safeError("CLEANUP_FAILED", "Owned process cleanup failed.");
        }
      } else {
        this.#cleanupFailure = undefined;
      }
      throw error;
    }
  }

  async #startCoreUnchecked() {
    if (!this.#prepared) {
      throw safeError("INVALID_COMMAND_STATE", "Prepare must complete before start.");
    }
    if (this.#finished) {
      throw safeError("INVALID_COMMAND_STATE", "Interactive session is finished.");
    }
    if (this.#prepareResult.status !== "PREPARED") {
      return this.#prepareResult;
    }
    if (this.#started) {
      return this.#startResult;
    }
    if (this.#budgetFailure !== undefined) {
      throw this.#budgetFailure;
    }
    this.#assertActive();
    await this.#assertStartupBudgetAdmission();

    const context = await this.#createStartContext();
    if (this.#launchdMode) {
      this.#launchdSupervisor = await this.#createLaunchdSupervisor({
        apiBinaryPath: context.apiBinaryPath,
        deviceNodePath: context.deviceNodePath
      });
    }
    await this.#startService("api", context);
    this.#assertBudgetHealthy();
    await this.#startService("deviceNode", context);
    this.#assertBudgetHealthy();
    this.#startBudgetSupervisor();
    this.#assertActive();
    this.#assertBudgetHealthy();
    await this.#startService("desktop", context, { includeBearer: true });
    this.#started = true;
    this.#startResult = {
      schemaVersion: 1,
      status: "STARTED",
      runId: this.#isolation.runId,
      installation: {
        mode: this.#launchdMode ? "launchd-api-device-owned-desktop" : "direct-owned-processes",
        status: this.#launchdMode ? "PASS" : "UNVERIFIED",
        ...(this.#launchdMode
          ? { labelsConfigured: true }
          : { reason: "LAUNCHD_NOT_WIRED" })
      },
      services: { api: "ready", deviceNode: "started", desktop: "started" },
      budgets: await this.#readAdmissionBudget(),
      budgetGuard: {
        status: "ARMED",
        startupProviderRequests: this.#startupBudgetAdmission.providerRequests,
        startupRealtimeConnections: this.#startupBudgetAdmission.realtimeConnections,
        observation: "sqlite-runtime-poll",
        pollMs: this.#budgetPollMs()
      }
    };
    return this.#startResult;
  }

  async #createStartContext() {
    const options = this.#options;
    const codexPath = options.codexPath ?? process.env.PHASE9B_CODEX_PATH;
    await assertExecutable(codexPath, "CODEX_PATH_REQUIRED");
    const apiBinaryPath = options.apiBinaryPath ?? join(
      options.repositoryRoot ?? process.cwd(), "artifacts", "services", "api", "Jarvis.Api");
    await assertExecutable(apiBinaryPath, "API_BINARY_UNAVAILABLE");
    const deviceNodePath = options.deviceNodePath ?? join(
      options.repositoryRoot ?? process.cwd(), "artifacts", "services", "device-node", "Jarvis.DeviceNode");
    await assertExecutable(deviceNodePath, "DEVICE_NODE_BINARY_UNAVAILABLE");
    const desktopAppPath = options.desktopAppPath ?? defaultDesktopAppPath(options.repositoryRoot ?? process.cwd());
    const desktopExecutable = options.desktopExecutablePath ?? join(desktopAppPath, "Contents", "MacOS", "Jarvis");
    await assertExecutable(desktopExecutable, "DESKTOP_BINARY_UNAVAILABLE");
    const runtimeEnvironment = this.#isolation.runtimeEnvironment;
    const apiEnvironment = {
      PATH: options.path ?? process.env.PATH ?? "",
      ASPNETCORE_URLS: runtimeEnvironment.ASPNETCORE_URLS,
      DOTNET_ENVIRONMENT: "Production",
      CODEX_HOME: runtimeEnvironment.CODEX_HOME,
      JARVIS_ALLOWED_ROOT: runtimeEnvironment.JARVIS_ALLOWED_ROOT,
      JARVIS_API_BASE_URL: `http://${this.#isolation.portHost}:${this.#isolation.port}`
    };
    return {
      options,
      apiBinaryPath,
      deviceNodePath,
      desktopAppPath,
      desktopExecutable,
      runtimeEnvironment,
      apiEnvironment,
      deviceEnvironment: { ...apiEnvironment },
      desktopArguments: options.desktopArguments ?? [
        "--phase9b-live",
        "--force-renderer-accessibility",
        `--user-data-dir=${this.#isolation.directories.desktopProfile}`
      ]
    };
  }

  async #startService(service, context, { includeBearer = false } = {}) {
    if (!INTERACTIVE_SERVICES.includes(service)) {
      throw safeError("INVALID_COMMAND", "Interactive service is invalid.");
    }
    this.#assertActive();
    if (service === "api") {
      if (this.#launchdMode) {
        await this.#launchdSupervisor.startService("api");
      } else {
        await this.#startOwned("api", context.apiBinaryPath, context.options.apiArguments ?? [], {
          cwd: dirname(this.#privatePaths.apiConfigPath),
          env: context.apiEnvironment
        });
      }
      await this.#waitForApiReady(API_READY_TIMEOUT_MS, this.#shutdownController.signal);
      return;
    }
    if (service === "deviceNode") {
      if (this.#launchdMode) {
        await this.#launchdSupervisor.startService("device");
      } else {
        await this.#startOwned("deviceNode", context.deviceNodePath, context.options.deviceNodeArguments ?? [], {
          cwd: dirname(this.#privatePaths.deviceConfigPath),
          env: context.deviceEnvironment
        });
      }
      await this.#waitForDeviceReady(DEVICE_READY_TIMEOUT_MS, this.#shutdownController.signal, {
        requireOwnedHeartbeat: this.#launchdMode
      });
      return;
    }
    const provider = this.#providerConfig;
    const environment = {
      PATH: context.options.path ?? process.env.PATH ?? "",
      NODE_ENV: "production",
      JARVIS_API_BASE_URL: context.apiEnvironment.JARVIS_API_BASE_URL,
      ...(includeBearer ? { JARVIS_LOCAL_BEARER: this.#isolation.localBearer } : {}),
      JARVIS_DESKTOP_PROFILE: this.#isolation.directories.desktopProfile,
      JARVIS_PHASE9B_LIVE: "1",
      JARVIS_PHASE9B_RUN_ID: this.#isolation.runId,
      JARVIS_PHASE9B_OWNER_MARKER: join(this.#isolation.root, ".phase9b-owner.json"),
      JARVIS_PHASE9B_ADMISSION_DESCRIPTOR: this.#privatePaths.admissionDescriptorPath,
      JARVIS_PHASE9B_REALTIME_CALL_URL: phase9bRealtimeCallUrl(provider.openAi.baseUrl),
      ...(context.options.rotationAfterMs === undefined ? {} : {
        JARVIS_PHASE9B_ROTATION_AFTER_MS: String(context.options.rotationAfterMs)
      }),
      CODEX_HOME: context.runtimeEnvironment.CODEX_HOME,
      JARVIS_ALLOWED_ROOT: context.runtimeEnvironment.JARVIS_ALLOWED_ROOT
    };
    await this.#startOwned("desktop", context.desktopExecutable, context.desktopArguments, {
      cwd: dirname(context.desktopAppPath),
      env: environment
    });
  }

  async #stopCore(service) {
    this.#assertService(service);
    if (!this.#started || this.#finished) {
      throw safeError("INVALID_COMMAND_STATE", "Start must complete before stopping a service.");
    }
    await this.#stopBudgetSupervisor();
    await this.#stopNamedService(service);
    return this.#serviceResult("STOPPED", service);
  }

  async #restartCore(service) {
    this.#assertService(service);
    if (!this.#started || this.#finished) {
      throw safeError("INVALID_COMMAND_STATE", "Start must complete before restarting a service.");
    }
    if (this.#budgetFailure !== undefined) {
      throw this.#budgetFailure;
    }
    await this.#stopBudgetSupervisor();
    try {
      await this.#stopNamedService(service);
      const context = await this.#createStartContext();
      await this.#startService(service, context, { includeBearer: service !== "desktop" });
      this.#startBudgetSupervisor();
      return this.#serviceResult("RESTARTED", service);
    } catch (error) {
      if (!await this.#stopOwnedProcesses()) {
        throw this.#cleanupFailure ?? safeError("CLEANUP_FAILED", "Owned process cleanup failed.");
      }
      throw error;
    }
  }

  #assertService(service) {
    if (typeof service !== "string" || !INTERACTIVE_SERVICES.includes(service)) {
      throw safeError("INVALID_COMMAND", "Interactive service is invalid.");
    }
  }

  async #stopNamedService(service) {
    if (service === "api" || service === "deviceNode") {
      if (this.#launchdMode) {
        if (typeof this.#launchdSupervisor?.stopService !== "function") {
          throw safeError("CLEANUP_FAILED", "The owned launchd service cannot be stopped.");
        }
        await this.#launchdSupervisor.stopService(service === "deviceNode" ? "device" : "api");
        return;
      }
    }
    const handle = this.#handles.get(service);
    if (handle === undefined) {
      return;
    }
    if (typeof handle.stop !== "function") {
      throw safeError("CLEANUP_FAILED", "The owned process cannot be stopped.");
    }
    await handle.stop();
    this.#handles.delete(service);
  }

  #serviceResult(status, service) {
    return {
      schemaVersion: 1,
      status,
      runId: this.#isolation.runId,
      service,
      services: {
        api: serviceState(this.#isHandleRunning("api")),
        deviceNode: serviceState(this.#isHandleRunning("deviceNode")),
        desktop: serviceState(this.#isHandleRunning("desktop"))
      },
      ...(status === "RESTARTED" && service === "desktop"
        ? { desktopBearerSource: "encrypted-store" }
        : {}),
      budgets: this.#budget.snapshot()
    };
  }

  async observe(conversationId) {
    return await this.#runExclusive(() => this.#observeCore(conversationId));
  }

  async #observeCore(conversationId) {
    if (!this.#started || this.#finished) {
      throw safeError("INVALID_COMMAND_STATE", "Start must complete before observe.");
    }
    if (conversationId !== undefined && !UUID_PATTERN.test(conversationId)) {
      throw safeError("INVALID_COMMAND", "Interactive command is invalid.");
    }
    if (this.#budgetFailure !== undefined) {
      throw this.#budgetFailure;
    }
    const apiBaseUrl = `http://${this.#isolation.portHost}:${this.#isolation.port}`;
    const [live, ready, diagnostics, devices, conversation, database] = await withTimeout(
      async (timeoutSignal) => await Promise.all([
        this.#getJson(`${apiBaseUrl}/health/live`, timeoutSignal),
        this.#getJson(`${apiBaseUrl}/health/ready`, timeoutSignal),
        this.#getJson(`${apiBaseUrl}/api/v1/diagnostics`, timeoutSignal),
        this.#getJson(`${apiBaseUrl}/api/v1/devices`, timeoutSignal),
        conversationId === undefined
          ? Promise.resolve(null)
          : this.#getJson(`${apiBaseUrl}/api/v1/conversations/${conversationId}`, timeoutSignal),
        readRuntimeFacts(join(this.#isolation.directories.database, "jarvis.db"), this.#scan.bind(this))
      ]),
      OBSERVATION_TIMEOUT_MS
    );
    const launchdServices = await this.#readLaunchdServices();
    const reservedBudget = await this.#readAdmissionBudget();
    const facts = reconcileBudget(
      this.#budget,
      database,
      this.#providerPreflightCalls,
      reservedBudget);
    return {
      schemaVersion: 1,
      status: "OBSERVED",
      runId: this.#isolation.runId,
      services: {
        api: serviceState(launchdServices?.api ?? this.#isHandleRunning("api")),
        deviceNode: serviceState(launchdServices?.deviceNode ?? this.#isHandleRunning("deviceNode")),
        desktop: serviceState(this.#isHandleRunning("desktop"))
      },
      api: {
        live: projectHealth(live, "live"),
        ready: projectHealth(ready, "ready"),
        database: projectDatabase(diagnostics)
      },
      device: { registered: projectItems(devices) > 0, online: projectOnlineDevices(diagnostics) },
      ...(conversationId === undefined
        ? {}
        : { conversation: { id: conversationId, messageCount: projectMessageCount(conversation) } }),
      facts,
      budgets: reservedBudget
    };
  }

  async finish() {
    if (this.#finished) {
      return false;
    }
    if (this.#finishPromise !== undefined) {
      return await this.#finishPromise;
    }
    const operation = this.#finishCore();
    this.#finishPromise = operation;
    try {
      return await operation;
    } finally {
      if (this.#finishPromise === operation) {
        this.#finishPromise = undefined;
      }
    }
  }

  async #finishCore() {
    this.#shutdownController.abort();
    await this.#activeOperation?.catch(() => {});
    await this.#stopBudgetSupervisor();
    let terminalBudget = this.#budget?.snapshot() ?? null;
    if (this.#admission !== undefined) {
      try {
        terminalBudget = await this.#readAdmissionBudget({ allowFatal: true });
      } catch {
        // Preserve cleanup and the last bounded snapshot when the ledger is
        // already unavailable; the cleanup result still fails closed.
      }
    }
    await this.#admissionFatalStop?.catch(() => {});
    const processesStopped = await this.#stopOwnedProcesses();
    let admissionStopped = true;
    try {
      await this.#admission?.stop?.();
    } catch {
      admissionStopped = false;
    }
    if (!processesStopped || !admissionStopped) {
      const cleanupFailure = this.#cleanupFailure ?? safeError("CLEANUP_FAILED", "Owned runtime cleanup failed.");
      if (this.#budgetFailure?.code === "BUDGET_EXHAUSTED") {
        return this.#budgetTerminalResult(terminalBudget, cleanupFailure);
      }
      throw cleanupFailure;
    }
    this.#cleanupFailure = undefined;
    let failure;
    try {
      if (this.#isolation !== undefined) {
        await this.#isolation.cleanup();
      }
    } catch {
      failure = safeError("CLEANUP_FAILED", "Owned runtime cleanup failed.");
    }
    if (failure !== undefined) {
      if (this.#budgetFailure?.code === "BUDGET_EXHAUSTED") {
        return this.#budgetTerminalResult(terminalBudget, failure);
      }
      throw failure;
    }
    this.#finished = true;
    if (this.#budgetFailure !== undefined) {
      return {
        schemaVersion: 1,
        status: this.#budgetFailure.code === "BUDGET_EXHAUSTED"
          ? "LIVE_BUDGET_EXHAUSTED"
          : "FAIL",
        runId: this.#isolation?.runId ?? null,
        errorCategory: safeErrorCategory(this.#budgetFailure),
        cleaned: true,
        budgets: terminalBudget
      };
    }
    return {
      schemaVersion: 1,
      status: "FINISHED",
      runId: this.#isolation?.runId ?? null,
      removed: true,
      budgets: terminalBudget
    };
  }

  #budgetTerminalResult(terminalBudget, cleanupFailure) {
    return {
      schemaVersion: 1,
      status: "LIVE_BUDGET_EXHAUSTED",
      runId: this.#isolation?.runId ?? null,
      errorCategory: "BUDGET_EXHAUSTED",
      cleanupErrorCategory: safeErrorCategory(cleanupFailure),
      cleaned: false,
      budgets: terminalBudget
    };
  }

  async #writeNonceFixture() {
    this.#assertActive();
    this.#nonce = randomUUID();
    this.#privatePaths.nonceFixturePath = await writePrivateJson(
      this.#isolation.root,
      "allowed-root/phase9b-nonce-fixture.json",
      { schemaVersion: 1, nonce: this.#nonce });
  }

  async #runExclusive(operation) {
    if (this.#activeOperation !== undefined) {
      throw safeError("INVALID_COMMAND_STATE", "Interactive command is already running.");
    }
    const promise = Promise.resolve().then(operation);
    this.#activeOperation = promise;
    try {
      return await promise;
    } finally {
      if (this.#activeOperation === promise) {
        this.#activeOperation = undefined;
      }
    }
  }

  async #writeRuntimeConfiguration() {
    this.#assertActive();
    const provider = this.#providerConfig;
    const runtime = this.#isolation.runtimeEnvironment;
    const apiConfiguration = {
      ...(this.#options.userSecretsPath === undefined ? {} : {
        ProviderKeySource: { Path: this.#options.userSecretsPath }
      }),
      ConnectionStrings: { Jarvis: runtime.ConnectionStrings__Jarvis },
      Authentication: { BearerToken: runtime.Authentication__BearerToken },
      OpenAI: {
        AuthenticationMode: provider.openAi.authenticationMode,
        BaseUrl: provider.openAi.baseUrl,
        RealtimeModel: provider.openAi.realtimeModel,
        RealtimeVoice: provider.openAi.realtimeVoice,
        SafetyIdentifierSalt: runtime.OpenAI__SafetyIdentifierSalt,
        ClientSecretLifetimeSeconds: 600,
        AllowedVoices: [provider.openAi.realtimeVoice]
      },
      Responses: {
        Provider: provider.responses.provider,
        Model: provider.responses.model,
        SummarizerModel: provider.responses.summarizerModel,
        TimeoutSeconds: 60,
        MaxTransientRetries: 0,
        PollingIntervalMs: 250
      },
      DeepSeek: {
        BaseUrl: provider.deepSeek.baseUrl
      },
      BudgetAdmission: {
        Enabled: true,
        DescriptorPath: this.#privatePaths.admissionDescriptorPath,
        TokenPath: this.#privatePaths.admissionTokenPath,
        RunId: this.#isolation.runId
      },
      SummaryWorker: { Enabled: false },
      FakeWorker: { Enabled: false },
      ResponsesWorker: { Enabled: true, PollingIntervalMs: 250, LeaseDurationMs: 65_001 },
      Logging: {
        LogLevel: {
          Default: "Warning",
          "Microsoft.AspNetCore": "Warning",
          "Microsoft.EntityFrameworkCore": "Warning"
        }
      },
      WakeWord: { Enabled: true, Keyword: "贾维斯" },
      Diagnostics: { Enabled: true, RequireLoopback: true },
      Resilience: {
        Enabled: true,
        MaxRetryAttempts: 0,
        RetryBaseDelayMs: 1,
        RetryMaxDelayMs: 1,
        AttemptTimeoutMs: 30_000,
        TotalTimeoutMs: 30_000,
        CircuitFailureRatio: 0.5,
        CircuitMinimumThroughput: 10,
        CircuitSamplingDurationMs: 30_000,
        CircuitBreakDurationMs: 30_000,
        MaxRetryAfterMs: 10_000
      }
    };
    this.#privatePaths.apiConfigPath = await writePrivateJson(
      this.#isolation.root,
      "runtime/api/appsettings.Production.json",
      apiConfiguration);

    const codexPath = this.#options.codexPath ?? process.env.PHASE9B_CODEX_PATH ?? "codex";
    const deviceConfiguration = {
      DeviceNode: {
        ApiBaseUrl: `http://${this.#isolation.portHost}:${this.#isolation.port}`,
        DeviceId: "00000000-0000-0000-0000-000000000000",
        BootstrapBearer: runtime.Authentication__BearerToken,
        CredentialFilePath: join(this.#isolation.root, "runtime", "device-node", "identity.json"),
        Name: "Phase9B Desktop Device",
        Platform: "macos",
        WorkingDirectory: this.#isolation.directories.allowedRoot,
        CodexHome: this.#isolation.runtimeEnvironment.CODEX_HOME,
        CodexBinaryPath: codexPath,
        CodexArguments: [
          "app-server",
          "-c",
          "features.default_mode_request_user_input=true",
          "-c",
          "features.request_permissions_tool=true"
        ],
        PollingIntervalMs: 100,
        HeartbeatIntervalMs: 1_000,
        MaxRestartAttempts: 1,
        RestartDelayMs: 100,
        Capabilities: {
          ReadFiles: true,
          WriteFiles: true,
          RunCommands: false,
          Network: false,
          AllowedRoots: [this.#isolation.directories.allowedRoot]
        }
      },
      BudgetAdmission: {
        Enabled: true,
        DescriptorPath: this.#privatePaths.admissionDescriptorPath,
        TokenPath: this.#privatePaths.admissionTokenPath,
        RunId: this.#isolation.runId
      },
      Logging: {
        LogLevel: {
          Default: "Warning",
          "Microsoft.AspNetCore": "Warning",
          "Microsoft.EntityFrameworkCore": "Warning"
        }
      },
      Resilience: {
        Enabled: true,
        MaxRetryAttempts: 0,
        RetryBaseDelayMs: 1,
        RetryMaxDelayMs: 1,
        AttemptTimeoutMs: 30_000,
        TotalTimeoutMs: 30_000,
        CircuitFailureRatio: 0.5,
        CircuitMinimumThroughput: 10,
        CircuitSamplingDurationMs: 30_000,
        CircuitBreakDurationMs: 30_000,
        MaxRetryAfterMs: 10_000
      }
    };
    this.#privatePaths.deviceConfigPath = await writePrivateJson(
      this.#isolation.root,
      "runtime/device-node/appsettings.Production.json",
      deviceConfiguration);
    this.#privatePaths.deviceIdentityPath = deviceConfiguration.DeviceNode.CredentialFilePath;
  }

  async #createLaunchdSupervisor({ apiBinaryPath, deviceNodePath }) {
    if (this.#launchdSupervisor !== undefined) {
      return this.#launchdSupervisor;
    }
    const launchdOptions = {
      root: this.#isolation.root,
      runId: this.#isolation.runId,
      apiExecutable: apiBinaryPath,
      apiWorkingDirectory: dirname(this.#privatePaths.apiConfigPath),
      deviceExecutable: deviceNodePath,
      deviceWorkingDirectory: dirname(this.#privatePaths.deviceConfigPath),
      apiPort: this.#isolation.port,
      secretValues: this.#secretValues
    };
    if (this.#options.launchdSupervisor !== undefined) {
      return this.#options.launchdSupervisor;
    }
    if (typeof this.#options.launchdSupervisorFactory === "function") {
      return await this.#options.launchdSupervisorFactory(launchdOptions);
    }
    return new LaunchdSupervisor(launchdOptions);
  }

  async #startOwned(name, command, args, options) {
    this.#assertActive();
    if (typeof this.#supervisor.start !== "function") {
      throw safeError("PROCESS_START_FAILED", "Process supervisor cannot start services.");
    }
    try {
      const handle = await this.#supervisor.start(command, args, {
        ...options,
        secretValues: this.#secretValues
      });
      if (this.#shutdownController.signal.aborted || this.#finished) {
        await handle?.stop?.();
        throw safeError("INVALID_COMMAND_STATE", "Interactive session is stopping.");
      }
      this.#handles.set(name, handle);
    } catch (error) {
      try {
        await this.#supervisor.stopAll?.();
      } catch {
        // Preserve the bounded start error; finish() owns cleanup reporting.
      }
      throw error?.code === undefined ? safeError("PROCESS_START_FAILED", "Process could not be started.") : error;
    }
  }

  async #stopOwnedProcesses() {
    const operations = [];
    if (this.#launchdSupervisor !== undefined) {
      operations.push(Promise.resolve().then(() => this.#launchdSupervisor.stopAll()));
    }
    if (typeof this.#supervisor.stopAll === "function") {
      operations.push(Promise.resolve().then(() => this.#supervisor.stopAll()));
    } else {
      operations.push(Promise.resolve().then(
        () => Promise.all([...this.#handles.values()].map((handle) => handle.stop?.()))));
    }
    const results = await Promise.allSettled(operations);
    if (results.some((result) => result.status === "rejected")) {
      this.#cleanupFailure ??= safeError("CLEANUP_FAILED", "Owned process cleanup failed.");
      return false;
    }
    return true;
  }

  #handleAdmissionFatal(category) {
    if (category !== "BUDGET_EXHAUSTED" || this.#budgetFailure !== undefined) {
      return;
    }
    this.#budgetFailure = safeError("BUDGET_EXHAUSTED", "The live budget admission boundary is exhausted.");
    if (this.#admissionFatalStop === undefined) {
      this.#admissionFatalStop = this.#stopOwnedProcesses().catch(() => false);
    }
    return this.#admissionFatalStop;
  }

  #assertBudgetHealthy() {
    if (this.#budgetFailure !== undefined) {
      throw this.#budgetFailure;
    }
  }

  async #readAdmissionBudget({ allowFatal = false } = {}) {
    if (typeof this.#admission?.snapshot !== "function") {
      throw safeError("ADMISSION_UNAVAILABLE", "The live budget admission boundary is unavailable.");
    }
    const snapshot = await this.#admission.snapshot();
    this.#syncBudgetFromAdmission(snapshot);
    if (!allowFatal && this.#admission.getFatalCategory?.() === "BUDGET_EXHAUSTED") {
      this.#assertBudgetHealthy();
      throw safeError("BUDGET_EXHAUSTED", "The live budget admission boundary is exhausted.");
    }
    return snapshot;
  }

  #syncBudgetFromAdmission(snapshot) {
    const current = this.#budget.snapshot();
    if (snapshot === null || typeof snapshot !== "object"
        || JSON.stringify(snapshot.limits) !== JSON.stringify(current.limits)) {
      throw safeError("ADMISSION_INTEGRITY", "The live budget ledger limits changed.");
    }
    for (const kind of Object.keys(current.used)) {
      const amount = snapshot.used?.[kind];
      if (!Number.isSafeInteger(amount) || amount < current.used[kind] || amount > current.limits[kind]) {
        throw safeError("ADMISSION_INTEGRITY", "The live budget ledger is inconsistent.");
      }
      if (amount > current.used[kind]) {
        this.#budget.consume(kind, amount - current.used[kind]);
      }
    }
    const expectedRemaining = Object.fromEntries(
      Object.keys(current.limits).map(kind => [kind, current.limits[kind] - snapshot.used[kind]]));
    if (JSON.stringify(snapshot.remaining) !== JSON.stringify(expectedRemaining)) {
      throw safeError("ADMISSION_INTEGRITY", "The live budget ledger readback is inconsistent.");
    }
  }

  async #assertStartupBudgetAdmission() {
    if (this.#admission === undefined) {
      throw safeError("ADMISSION_UNAVAILABLE", "The live budget admission boundary is unavailable.");
    }
    await this.#readAdmissionBudget();
    if (!this.#budget.canConsume("providerRequests", STARTUP_PROVIDER_REQUEST_RESERVATION)
        || !this.#budget.canConsume("realtimeConnections", STARTUP_REALTIME_CONNECTION_RESERVATION)) {
      throw safeError("BUDGET_EXHAUSTED", "The live runtime has no budget for Desktop startup.");
    }
    this.#startupBudgetAdmission = {
      providerRequests: STARTUP_PROVIDER_REQUEST_RESERVATION,
      realtimeConnections: STARTUP_REALTIME_CONNECTION_RESERVATION
    };
  }

  #budgetPollMs() {
    const value = this.#options.budgetPollMs ?? DEFAULT_BUDGET_POLL_MS;
    if (!Number.isSafeInteger(value) || value < 100 || value > 10_000) {
      throw safeError("VALIDATION_FAILED", "Budget supervision interval is invalid.");
    }
    return value;
  }

  #startBudgetSupervisor() {
    if (this.#budgetSupervisorTimer !== undefined) {
      return;
    }
    const interval = this.#budgetPollMs();
    this.#budgetSupervisorTimer = setInterval(() => {
      if (this.#budgetSupervisionInFlight !== undefined) {
        return;
      }
      const check = this.#superviseBudget().catch(() => {});
      this.#budgetSupervisionInFlight = check;
      void check.finally(() => {
        if (this.#budgetSupervisionInFlight === check) {
          this.#budgetSupervisionInFlight = undefined;
        }
      });
    }, interval);
    this.#budgetSupervisorTimer.unref?.();
  }

  async #stopBudgetSupervisor() {
    if (this.#budgetSupervisorTimer !== undefined) {
      clearInterval(this.#budgetSupervisorTimer);
      this.#budgetSupervisorTimer = undefined;
    }
    if (this.#budgetSupervisionInFlight !== undefined) {
      await this.#budgetSupervisionInFlight;
      this.#budgetSupervisionInFlight = undefined;
    }
  }

  async #superviseBudget() {
    if (this.#finished || !this.#started || this.#budgetFailure !== undefined) {
      return;
    }
    if (this.#admission?.getFatalCategory?.() === "BUDGET_EXHAUSTED") {
      await this.#handleAdmissionFatal("BUDGET_EXHAUSTED");
      return;
    }
    try {
      await this.#launchdSupervisor?.scanOutput?.();
      const facts = await readRuntimeFacts(
        join(this.#isolation.directories.database, "jarvis.db"),
        this.#scan.bind(this));
      // Reservations precede native effects. Read their monotonic snapshot
      // after the database facts so concurrent admitted work cannot appear
      // newer than the reservation snapshot used to validate it.
      const reservedBudget = await this.#readAdmissionBudget();
      reconcileBudget(this.#budget, facts, this.#providerPreflightCalls, reservedBudget);
    } catch (error) {
      this.#budgetFailure = error?.code === "BUDGET_EXHAUSTED" || error?.code === "SECRET_DETECTED"
        ? error
        : safeError("OBSERVATION_INVALID", "Runtime budget observation failed.");
      await this.#stopOwnedProcesses();
    }
  }

  async #waitForApiReady(timeoutMs, signal = this.#shutdownController.signal) {
    const deadline = Date.now() + timeoutMs;
    let lastError;
    while (Date.now() < deadline) {
      try {
        if (!await this.#assertLaunchdServiceRunning("api")) {
          await delay(100);
          continue;
        }
        const result = await withTimeout(
          (signal) => this.#getJson(
            `http://${this.#isolation.portHost}:${this.#isolation.port}/health/ready`,
            signal),
          2_000,
          { signal });
        if (projectHealth(result, "ready")) {
          return;
        }
      } catch (error) {
        lastError = error;
        if (signal.aborted) {
          throw safeError("INVALID_COMMAND_STATE", "Interactive session is stopping.");
        }
        if (this.#launchdSupervisor !== undefined && error?.code?.startsWith("LAUNCHD_")) {
          throw error;
        }
        const processFailure = this.#processFailure("api");
        if (processFailure !== null) {
          throw safeError(processFailure, "API process failed before readiness.");
        }
      }
      await delay(100);
    }
    throw safeError(lastError?.code === "SECRET_DETECTED" ? "SECRET_DETECTED" : "SERVICE_UNREADY", "API did not become ready.");
  }

  async #waitForDeviceReady(
    timeoutMs,
    signal = this.#shutdownController.signal,
    { requireOwnedHeartbeat = false } = {}) {
    const deadline = Date.now() + timeoutMs;
    let lastError;
    while (Date.now() < deadline) {
      try {
        if (!await this.#assertLaunchdServiceRunning("device")) {
          await delay(100);
          continue;
        }
        const result = await withTimeout(
          (signal) => this.#getJson(
            `http://${this.#isolation.portHost}:${this.#isolation.port}/api/v1/devices`,
            signal),
          2_000,
          { signal });
        const identity = requireOwnedHeartbeat
          ? await this.#readOwnedDeviceIdentity()
          : null;
        if (identity !== null) {
          await this.#launchdSupervisor?.scanOutput?.();
        }
        if (projectItems(result) > 0
            && (!requireOwnedHeartbeat
              || identity !== null && projectOwnedOnlineDevice(result, identity.deviceId))) {
          return;
        }
      } catch (error) {
        lastError = error;
        if (signal.aborted) {
          throw safeError("INVALID_COMMAND_STATE", "Interactive session is stopping.");
        }
        if (this.#launchdSupervisor !== undefined && error?.code?.startsWith("LAUNCHD_")) {
          throw error;
        }
        const processFailure = this.#processFailure("deviceNode");
        if (processFailure !== null) {
          throw safeError(processFailure, "Device Node process failed before readiness.");
        }
      }
      await delay(100);
    }
    throw safeError(lastError?.code === "SECRET_DETECTED" ? "SECRET_DETECTED" : "SERVICE_UNREADY", "Device Node did not become ready.");
  }

  async #getJson(url, signal) {
    const response = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${this.#isolation.localBearer}` },
      signal
    });
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_HTTP_BODY_BYTES) {
      throw safeError("OBSERVATION_INVALID", "Observation response is too large.");
    }
    this.#scan(text);
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      throw safeError("OBSERVATION_INVALID", "Observation response is invalid.");
    }
    this.#scan(value);
    if (!response.ok) {
      throw safeError(response.status === 401 || response.status === 403 ? "API_UNAUTHORIZED" : "API_OBSERVATION_FAILED", "Observation request failed.");
    }
    return value;
  }

  #scan(value) {
    if (scanKnownSecrets(value, this.#secretValues)) {
      throw safeError("SECRET_DETECTED", "Known secret detected in runtime output.");
    }
    return false;
  }

  #isHandleRunning(name) {
    if (this.#launchdSupervisor !== undefined && (name === "api" || name === "deviceNode")) {
      return this.#launchdSupervisor.isInstalled(name === "deviceNode" ? "device" : "api");
    }
    const handle = this.#handles.get(name);
    return handle?.isRunning?.() === true;
  }

  async #assertLaunchdServiceRunning(kind) {
    if (this.#launchdSupervisor?.serviceState === undefined) {
      return true;
    }
    const state = await this.#launchdSupervisor.serviceState(kind);
    if (!state?.exists) {
      throw safeError("LAUNCHD_SERVICE_UNREADY", "The owned launchd service is unavailable.");
    }
    if (!state.owned) {
      throw safeError("LAUNCHD_OWNERSHIP_INVALID", "The launchd service is not owned by this run.");
    }
    return state.running === true;
  }

  async #readLaunchdServices() {
    if (this.#launchdSupervisor?.serviceState === undefined) {
      return null;
    }
    const [api, device] = await Promise.all([
      this.#launchdSupervisor.serviceState("api"),
      this.#launchdSupervisor.serviceState("device")
    ]);
    return { api: api?.running === true, deviceNode: device?.running === true };
  }

  async #readOwnedDeviceIdentity() {
    const path = this.#privatePaths.deviceIdentityPath;
    const metadata = await lstat(path).catch(() => null);
    if (metadata === null || metadata.isSymbolicLink() || !metadata.isFile()
        || (metadata.mode & 0o077) !== 0 || metadata.size > 16 * 1024) {
      return null;
    }
    let parsed;
    try {
      parsed = JSON.parse(await readFile(path, "utf8"));
    } catch {
      return null;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)
        || Object.keys(parsed).sort().join(",") !== "deviceCredential,deviceId"
        || !UUID_PATTERN.test(parsed.deviceId)
        || typeof parsed.deviceCredential !== "string"
        || parsed.deviceCredential.length < 16 || parsed.deviceCredential.length > 4096) {
      return null;
    }
    this.#launchdSupervisor?.registerSecret?.(parsed.deviceCredential);
    return { deviceId: parsed.deviceId };
  }

  #processFailure(name) {
    const handle = this.#handles.get(name);
    if (handle?.isRunning?.() !== false) {
      return null;
    }
    const category = handle.result?.()?.errorCategory;
    return new Set(["PROCESS_START_FAILED", "PROCESS_ERROR", "SECRET_DETECTED", "TIMEOUT"]).has(category)
      ? category
      : "PROCESS_ERROR";
  }

  #assertActive() {
    if (this.#finished || this.#shutdownController.signal.aborted) {
      throw safeError("INVALID_COMMAND_STATE", "Interactive session is stopping.");
    }
  }

  #seedProviderBudget() {
    const fromPreflight = this.#preflight?.network?.providerCalls;
    const explicit = this.#options.preflightProviderCalls;
    for (const value of [fromPreflight, explicit]) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 0 || value > 12)) {
        throw safeError("BUDGET_EXHAUSTED", "Provider preflight budget is invalid.");
      }
    }
    const count = Math.max(explicit ?? 0, fromPreflight ?? 0);
    if (count > 0) {
      try {
        this.#budget.consume("providerRequests", count);
      } catch (error) {
        throw safeError("BUDGET_EXHAUSTED", "Provider request budget is exhausted.", error);
      }
    }
    this.#providerPreflightCalls = count;
  }

  #safePrepareResult(status) {
    return {
      schemaVersion: 1,
      status,
      runId: this.#isolation.runId,
      securityRemediation: { status: this.#securityRemediationStatus },
      preflight: {
        status: this.#preflight.status,
        providerCalls: this.#providerPreflightCalls
      },
      credentials: {
        status: this.#providerResult?.status ?? "BLOCKED_CREDENTIALS",
        presence: boundedPresence(this.#providerResult?.presence)
      },
      budgets: this.#budget.snapshot()
    };
  }

  #readSecurityRemediationStatus() {
    const value = this.#options.securityRemediationStatus;
    try {
      return validateSecurityRemediationStatus(value === undefined ? "UNVERIFIED" : value);
    } catch {
      throw safeError("INVALID_COMMAND", "Security remediation status is invalid.");
    }
  }
}

export async function runInteractiveCli({
  input = process.stdin,
  output = process.stdout,
  sessionOptions = {},
  signalSource = process,
  maxRuntimeMs = DEFAULT_INTERACTIVE_TIMEOUT_MS
} = {}) {
  if (!Number.isSafeInteger(maxRuntimeMs) || maxRuntimeMs <= 0 || maxRuntimeMs > MAX_INTERACTIVE_TIMEOUT_MS) {
    throw safeError("TIMEOUT", "Interactive runtime timeout is invalid.");
  }
  const session = createInteractiveSession(sessionOptions);
  const reader = createInterface({ input, crlfDelay: Infinity });
  let finalResult;
  let finalResultWritten = false;
  let stopping = false;
  let shutdownReason;
  let shutdownPromise;
  const requestShutdown = (reason) => {
    if (shutdownPromise !== undefined) {
      return shutdownPromise;
    }
    stopping = true;
    shutdownReason = reason;
    reader.close();
    input.pause?.();
    input.destroy?.();
    shutdownPromise = session.finish().catch((error) => cliErrorResult(session, error));
    return shutdownPromise;
  };
  const signalHandlers = [];
  for (const signalName of ["SIGINT", "SIGTERM"]) {
    if (typeof signalSource?.once === "function") {
      const handler = () => { void requestShutdown("INTERRUPTED"); };
      signalSource.once(signalName, handler);
      signalHandlers.push([signalName, handler]);
    }
  }
  const hardTimeout = setTimeout(() => { void requestShutdown("TIMEOUT"); }, maxRuntimeMs);
  try {
    try {
      for await (const line of reader) {
        if (stopping) {
          break;
        }
        let command;
        try {
          command = parseInteractiveCommand(line);
          const result = command.command === "prepare"
            ? await session.prepare()
            : command.command === "start"
              ? await session.start()
              : command.command === "observe"
                ? await session.observe(command.conversationId)
                : command.command === "stop"
                  ? await session.stop(command.service)
                  : command.command === "restart"
                    ? await session.restart(command.service)
                : await session.finish();
          if (result !== false) {
            const outputAccepted = writeSafeLine(output, result);
            if (!outputAccepted) {
              if (command.command === "finish") {
                finalResult = {
                  schemaVersion: 1,
                  status: "FAIL",
                  ...(session.runId === null ? {} : { runId: session.runId }),
                  errorCategory: "OUTPUT_REJECTED",
                  cleaned: true
                };
                finalResultWritten = true;
              } else {
                await requestShutdown("OUTPUT_REJECTED");
              }
              break;
            }
          }
          if (command.command === "finish") {
            if (result !== false) {
              finalResult = result;
              finalResultWritten = true;
            }
            break;
          }
        } catch (error) {
          if (!stopping) {
            const errorResult = cliErrorResult(session, error);
            if (!writeSafeLine(output, errorResult)) {
              await requestShutdown("OUTPUT_REJECTED");
              break;
            }
            if (errorResult.status === "LIVE_BUDGET_EXHAUSTED") {
              finalResult = errorResult;
            }
          }
        }
      }
    } catch (error) {
      if (!stopping) {
        const errorResult = cliErrorResult(session, error);
        if (!writeSafeLine(output, errorResult)) {
          await requestShutdown("OUTPUT_REJECTED");
        }
        if (errorResult.status === "LIVE_BUDGET_EXHAUSTED") {
          finalResult = errorResult;
        }
      }
    }
  } finally {
    clearTimeout(hardTimeout);
    for (const [signalName, handler] of signalHandlers) {
      signalSource.off?.(signalName, handler);
      signalSource.removeListener?.(signalName, handler);
    }
    reader.close();
    if (shutdownPromise !== undefined) {
      const cleaned = await shutdownPromise;
      finalResult = shutdownReason === undefined || cleaned?.status !== "FINISHED"
        ? cleaned
        : {
          schemaVersion: 1,
          status: "FAIL",
          ...(session.runId === null ? {} : { runId: session.runId }),
          errorCategory: shutdownReason,
          cleaned: true
        };
      if (!finalResultWritten && finalResult !== false) {
        finalResultWritten = writeSafeLine(output, finalResult);
      }
    } else if (finalResult === undefined) {
      try {
        finalResult = await session.finish();
        if (finalResult !== false) {
          finalResultWritten = writeSafeLine(output, finalResult);
        }
      } catch (error) {
        finalResult = cliErrorResult(session, error);
        finalResultWritten = writeSafeLine(output, finalResult);
      }
    }
  }
  return finalResult ?? { status: "FINISHED", runId: session.runId };
}

export async function readRuntimeFacts(databasePath, scan = () => {}) {
  const metadata = await lstat(databasePath).catch(() => null);
  if (metadata === null || metadata.isSymbolicLink() || !metadata.isFile()) {
    throw safeError("OBSERVATION_INVALID", "Runtime database is unavailable.");
  }
  let database;
  try {
    const sqlite = await import("node:sqlite");
    database = new sqlite.DatabaseSync(databasePath, { readOnly: true });
    database.exec("BEGIN");
    const count = (sql) => {
      const value = database.prepare(sql).get()?.count;
      return Number.isSafeInteger(value) && value >= 0 ? value : 0;
    };
    const realtimeSecretsIssued = count("SELECT COUNT(*) AS count FROM RealtimeSessions");
    const realtimeConnections = count("SELECT COUNT(*) AS count FROM RealtimeSessions WHERE ConnectedAtMs IS NOT NULL");
    const responseExecutions = count("SELECT COUNT(*) AS count FROM TaskExecutions WHERE WorkerKind = 1");
    const responseRequests = count("SELECT COUNT(*) AS count FROM TaskExecutions WHERE WorkerKind = 1 AND ExternalExecutionId IS NOT NULL");
    const responseTasks = count("SELECT COUNT(*) AS count FROM Tasks WHERE WorkerKind = 1");
    const delegationAttemptsObserved = count(`
      SELECT COUNT(*) AS count
      FROM Tasks AS task
      INNER JOIN Messages AS message ON message.Id = task.CreatedByMessageId
      WHERE task.WorkerKind = 1 AND message.RealtimeSessionId IS NOT NULL`);
    const codexTaskExecutions = count("SELECT COUNT(*) AS count FROM TaskExecutions WHERE WorkerKind = 2");
    const codexTasks = count("SELECT COUNT(*) AS count FROM Tasks WHERE WorkerKind = 2");
    const codexStartedTasks = count("SELECT COUNT(DISTINCT TaskId) AS count FROM TaskExecutions WHERE WorkerKind = 2 AND CodexThreadId IS NOT NULL");
    const facts = {
      // Keep the short aliases for existing callers, but make each observed
      // source explicit so a report cannot confuse tasks with wire requests.
      realtimeSecretsIssued,
      realtimeSessions: realtimeSecretsIssued,
      realtimeConnections,
      responseRequests,
      responseExecutions,
      responseTasks,
      delegationAttemptsObserved,
      codexTaskExecutions,
      codexExecutions: codexTaskExecutions,
      codexTasks,
      codexStartedTasks,
      sources: {
        realtimeSecretsIssued: "sqlite:RealtimeSessions.rows",
        realtimeConnections: "sqlite:RealtimeSessions.ConnectedAtMs",
        responseRequests: "sqlite:TaskExecutions.Responses.ExternalExecutionId",
        responseTasks: "sqlite:Tasks.WorkerKind.Responses",
        delegationAttemptsObserved: "sqlite:ResponsesTasks.join.RealtimeMessages",
        codexTasks: "sqlite:Tasks.WorkerKind.Codex",
        codexStartedTasks: "sqlite:TaskExecutions.CodexThreadId.distinctTaskId"
      }
    };
    database.exec("COMMIT");
    scan(facts);
    return facts;
  } catch (error) {
    if (error?.code === "SECRET_DETECTED") {
      throw error;
    }
    throw safeError("OBSERVATION_INVALID", "Runtime database observation failed.");
  } finally {
    database?.close?.();
  }
}

export function reconcileBudget(budget, facts, providerPreflightCalls, reservedBudget = budget?.snapshot?.()) {
  const observed = {
    // A client-secret issuance and the subsequent Desktop `/calls` handshake
    // are separate provider requests. These are durable observations, so a
    // failed request or idempotent replay remains outside this inferred count.
    providerRequests: providerPreflightCalls + facts.realtimeSecretsIssued + facts.realtimeConnections + facts.responseRequests,
    realtimeConnections: facts.realtimeConnections,
    // Codex executions are a separate budget. Only Responses tasks linked to
    // a persisted Realtime message are attributable to delegate_task.
    delegationAttempts: facts.delegationAttemptsObserved,
    // A queued or claimed row exists before the Device Node's launch
    // reservation. Native thread identity is a durable lower bound on
    // admitted tasks; failed launches remain counted by the admission ledger.
    codexTasks: facts.codexStartedTasks,
    retries: 0
  };
  if (reservedBudget === undefined || reservedBudget === null
      || reservedBudget.used === undefined || reservedBudget.limits === undefined) {
    throw safeError("ADMISSION_INTEGRITY", "The live budget reservation snapshot is unavailable.");
  }
  if (!Number.isSafeInteger(facts.codexStartedTasks) || facts.codexStartedTasks < 0
      || facts.codexStartedTasks > facts.codexTasks) {
    throw safeError("OBSERVATION_INVALID", "Native task observations are invalid.");
  }
  if (facts.codexTasks > reservedBudget.limits.codexTasks) {
    throw safeError("BUDGET_EXHAUSTED", "The created Codex task limit is exhausted.");
  }
  const mismatches = Object.entries(observed)
    .filter(([kind, amount]) => amount > reservedBudget.used[kind])
    .map(([kind]) => kind);
  if (mismatches.length > 0) {
    throw safeError("OBSERVATION_INVALID", "Runtime facts exceed durable budget reservations.");
  }
  return {
    ...facts,
    budgetObservation: {
      status: "PASS",
      observed,
      reserved: {
        limits: { ...reservedBudget.limits },
        used: { ...reservedBudget.used }
      }
    }
  };
}

function validateProviderShape(config) {
  const values = [
    config?.openAi?.apiKey,
    config?.openAi?.authenticationMode,
    config?.openAi?.baseUrl,
    config?.openAi?.realtimeModel,
    config?.openAi?.realtimeVoice,
    config?.responses?.provider,
    config?.responses?.model,
    config?.responses?.summarizerModel,
    config?.deepSeek?.apiKey,
    config?.deepSeek?.baseUrl
  ];
  if (values.some((value) => typeof value !== "string" || value.length === 0)) {
    throw safeError("INVALID_PROVIDER_CONFIG", "Provider configuration is incomplete.");
  }
}

function providerResultFor(config) {
  return {
    status: "PASS",
    errors: [],
    presence: {
      userSecretsFound: false,
      openAiApiKey: Boolean(config?.openAi?.apiKey),
      deepSeekApiKey: Boolean(config?.deepSeek?.apiKey)
    },
    config
  };
}

function collectSecretValues(config, isolation) {
  return [
    isolation?.localBearer,
    isolation?.safetyIdentifierSalt,
    config?.openAi?.apiKey,
    config?.deepSeek?.apiKey
  ].filter((value) => typeof value === "string" && value.length > 0);
}

function firstBlockedStatus(...statuses) {
  for (const status of statuses) {
    if (typeof status === "string" && status.startsWith("BLOCKED")) {
      return status;
    }
  }
  return null;
}

function boundedPresence(value) {
  const presence = value ?? {};
  return {
    userSecretsFound: presence.userSecretsFound === true,
    openAiApiKey: presence.openAiApiKey === true,
    deepSeekApiKey: presence.deepSeekApiKey === true
  };
}

async function assertExecutable(path, missingCode) {
  if (typeof path !== "string" || !isAbsolute(path)) {
    throw safeError(missingCode, "Executable path is invalid.");
  }
  const metadata = await lstat(path).catch(() => null);
  if (metadata === null || metadata.isSymbolicLink() || !metadata.isFile() || (metadata.mode & 0o111) === 0) {
    throw safeError(missingCode, "Executable is unavailable.");
  }
}

function defaultDesktopAppPath(repositoryRoot) {
  return join(resolve(repositoryRoot), "src", "clients", "desktop", "out", "Jarvis-darwin-arm64", "Jarvis.app");
}

function projectHealth(value, expectedStatus) {
  return value?.healthy === true && value?.status === expectedStatus;
}

function projectDatabase(value) {
  return value?.database?.available === true;
}

function projectItems(value) {
  return Array.isArray(value?.items) ? value.items.length : 0;
}

function projectOnlineDevices(value) {
  const amount = value?.work?.onlineDevices;
  return Number.isSafeInteger(amount) && amount >= 0 ? amount : 0;
}

function projectOwnedOnlineDevice(value, deviceId) {
  if (!UUID_PATTERN.test(deviceId) || !Array.isArray(value?.items)) {
    return false;
  }
  return value.items.some((item) => item?.deviceId === deviceId && item?.status === "online");
}

function projectMessageCount(value) {
  const amount = value?.messageCount;
  return Number.isSafeInteger(amount) && amount >= 0 ? amount : 0;
}

function serviceState(running) {
  return running === true ? "started" : "stopped";
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

export function writeSafeLine(output, value) {
  let serialized;
  try {
    serialized = `${JSON.stringify(sanitizeInteractiveOutput(value))}\n`;
  } catch {
    serialized = `${JSON.stringify({
      schemaVersion: 1,
      status: "FAIL",
      errorCategory: "OUTPUT_REJECTED"
    })}\n`;
    try {
      output.write(serialized);
    } catch {
      // The caller owns the output stream; no raw error is safe to report here.
    }
    return false;
  }
  try {
    output.write(serialized);
    return true;
  } catch {
    // The caller owns the output stream; no raw error is safe to report here.
    return false;
  }
}

function cliErrorResult(session, error) {
  const errorCategory = safeErrorCategory(error);
  return {
    schemaVersion: 1,
    status: errorCategory === "BUDGET_EXHAUSTED" ? "LIVE_BUDGET_EXHAUSTED" : "FAIL",
    ...(session.runId === null ? {} : { runId: session.runId }),
    errorCategory
  };
}

function phase9bRealtimeCallUrl(baseUrl) {
  let base;
  try {
    base = new URL(baseUrl);
  } catch {
    throw safeError("INVALID_PROVIDER_CONFIG", "The live Realtime endpoint is invalid.");
  }
  const basePath = base.pathname.replace(/\/$/, "");
  const versionPath = basePath.endsWith("/v1") ? basePath : `${basePath}/v1`;
  return `${base.origin}${versionPath}/realtime/calls`;
}

function safeErrorCategory(error) {
  const allowed = new Set([
    "API_BINARY_UNAVAILABLE",
    "ADMISSION_UNAVAILABLE",
    "ADMISSION_INTEGRITY",
    "ADMISSION_INVALID",
    "ADMISSION_OWNERSHIP_INVALID",
    "ADMISSION_RESTART_UNSAFE",
    "API_OBSERVATION_FAILED",
    "API_UNAUTHORIZED",
    "BLOCKED_CREDENTIALS",
    "BLOCKED_CODEX_AUTH",
    "BLOCKED_PROVIDER_ACCESS",
    "BLOCKED_PROVIDER_CONFIG",
    "BLOCKED_SECURITY_REMEDIATION",
    "BLOCKED_TOOLCHAIN",
    "BUDGET_EXHAUSTED",
    "CLEANUP_FAILED",
    "CODEX_BINARY_UNAVAILABLE",
    "CODEX_BINARY_UNSAFE",
    "CODEX_HOME_ADOPTION_FAILED",
    "CODEX_PATH_REQUIRED",
    "DESKTOP_BINARY_UNAVAILABLE",
    "DEVICE_NODE_BINARY_UNAVAILABLE",
    "INVALID_COMMAND",
    "INVALID_COMMAND_STATE",
    "INVALID_AUTOMATION_OUTPUT",
    "INTERRUPTED",
    "INVALID_PROVIDER_CONFIG",
    "INVALID_RUN_ID",
    "LAUNCHD_BOOTSTRAP_FAILED",
    "LAUNCHD_CLEANUP_FAILED",
    "LAUNCHD_CWD_INVALID",
    "LAUNCHD_EXECUTABLE_INVALID",
    "LAUNCHD_LABEL_INVALID",
    "LAUNCHD_OPERATION_FAILED",
    "LAUNCHD_OWNERSHIP_INVALID",
    "LAUNCHD_PLIST_INVALID",
    "LAUNCHD_SERVICE_INVALID",
    "LAUNCHD_SERVICE_UNREADY",
    "LAUNCHD_UNAVAILABLE",
    "OBSERVATION_INVALID",
    "OWNERSHIP_MARKER_INVALID",
    "OUTPUT_REJECTED",
    "PORT_ALLOCATION_FAILED",
    "PRIVATE_FILE_INTEGRITY",
    "PROCESS_ERROR",
    "PROCESS_START_FAILED",
    "SECRET_DETECTED",
    "SERVICE_UNREADY",
    "TIMEOUT",
    "UNSAFE_PROCESS_ARGUMENTS",
    "UNSAFE_PROCESS_CWD",
    "UNSAFE_PROCESS_ENVIRONMENT",
    "UNSAFE_CODEX_HOME",
    "UNSAFE_PRIVATE_PATH",
    "UNSAFE_TEMP_ROOT",
    "UNSAFE_TEMP_ROOT_SYMLINK",
    "VALIDATION_FAILED"
  ]);
  return allowed.has(error?.code) ? error.code : "INTERACTIVE_RUN_FAILED";
}

function safeError(code, message, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.code = code;
  return error;
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] !== undefined && resolve(process.argv[1]) === currentFile) {
  const providerPreflightCalls = process.env.PHASE9B_PROVIDER_PREFLIGHT_CALLS === undefined
    ? 0
    : Number(process.env.PHASE9B_PROVIDER_PREFLIGHT_CALLS);
  const result = await runInteractiveCli({
    sessionOptions: {
      repositoryRoot: process.cwd(),
      userSecretsPath: process.env.PHASE9B_PROVIDER_CONFIG_FILE,
      targetedAuthMetadataPath: process.env.PHASE9B_TARGETED_AUTH_METADATA,
      rotationAfterMs: process.env.PHASE9B_ROTATION_AFTER_MS === undefined
        ? undefined : Number(process.env.PHASE9B_ROTATION_AFTER_MS),
      codexPath: process.env.PHASE9B_CODEX_PATH,
      externalCodexHome: process.env.PHASE9B_CODEX_HOME ?? process.env.PHASE9B_ISOLATED_CODEX_HOME,
      apiBinaryPath: process.env.PHASE9B_API_PATH,
      deviceNodePath: process.env.PHASE9B_DEVICE_NODE_PATH,
      desktopAppPath: process.env.PHASE9B_DESKTOP_APP_PATH,
      preflightProviderCalls: providerPreflightCalls,
      securityRemediationStatus: process.env.PHASE9B_SECURITY_REMEDIATION_STATUS,
      useLaunchd: process.env.PHASE9B_USE_LAUNCHD === "1"
    }
  });
  process.exitCode = result?.status === "FAIL" || String(result?.status).startsWith("BLOCKED") ? 1 : 0;
}
