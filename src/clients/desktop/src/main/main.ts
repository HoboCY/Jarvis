import { HubConnectionBuilder, type HubConnection } from "@microsoft/signalr";
import { app, BrowserWindow, ipcMain, Menu, nativeImage, safeStorage, shell, systemPreferences, Tray } from "electron";
import { randomUUID } from "node:crypto";
import { chmodSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getRendererEntryUrl,
  isAllowedExternalUrl,
  isAllowedNavigation,
  secureWebPreferences
} from "./security.js";
import {
  NotificationProjectionCache,
  createOverlayWindowOptions,
  shouldHideWindowOnClose
} from "./desktop-lifecycle.js";
import { resolveBackendBaseUrl } from "./backend-config.js";
import {
  DesktopBearerStore,
  desktopBearerEnvironmentVariable,
  resolveDesktopBearer
} from "./desktop-bearer-store.js";
import { isUuid } from "./input-validation.js";
import { desktopSignalRLogLevel } from "./signalr-config.js";
import { wakeWordErrorCode } from "../wake-word-error.js";
import {
  sanitizeWakeWordError,
  SherpaWakeWordService,
  supportedWakeWord
} from "./wake-word-service.js";
import {
  createDesktopActionFailureError,
  createDesktopIpcFailure,
  createDesktopIpcSuccess,
  projectDesktopActionFailure,
  type DesktopActionFailureCode,
  type DesktopActionFailureKind,
  type DesktopIpcHandler
} from "../renderer/desktop-ipc.js";

type JsonRecord = Record<string, unknown>;
type BackendConnectionStateValue = "connecting" | "connected" | "reconnecting" | "disconnected";
type BackendConnectionState = {
  state: BackendConnectionStateValue;
  revision: number;
  error?: string;
};

function desktopActionFailure(kind: DesktopActionFailureKind, code: DesktopActionFailureCode): Error {
  return createDesktopActionFailureError(kind, code);
}

function backendHttpFailure(status: number): Error {
  switch (status) {
    case 400:
    case 405:
    case 422:
      return desktopActionFailure("terminal", "invalid_input");
    case 401:
      return desktopActionFailure("terminal", "unauthorized");
    case 403:
      return desktopActionFailure("terminal", "forbidden");
    case 404:
      return desktopActionFailure("terminal", "not_found");
    case 409:
      return desktopActionFailure("terminal", "conflict");
    case 410:
      return desktopActionFailure("terminal", "expired");
    case 408:
      return desktopActionFailure("retryable", "timeout");
    case 429:
      return desktopActionFailure("retryable", "backend_unavailable");
    default:
      return status >= 500 && status <= 599
        ? desktopActionFailure("retryable", "backend_unavailable")
        : desktopActionFailure("retryable", "unknown");
  }
}

function handleDesktopIpc(channel: string, handler: DesktopIpcHandler): void {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return createDesktopIpcSuccess(await handler(event, ...args));
    } catch (reason) {
      return createDesktopIpcFailure(projectDesktopActionFailure(reason));
    }
  });
}

const backendBaseUrl = resolveBackendBaseUrl();
const clientHubPath = "/hubs/client";
const taskApiPath = "/api/v1/tasks";
const memoryFactApiPath = "/api/v1/memory-facts";
const notificationApiPath = "/api/v1/notifications";
const approvalApiPath = "/api/v1/approvals";
const nonTerminalTaskStatuses = new Set([
  "queued",
  "assigned",
  "running",
  "waitingForApproval",
  "waitingForUserInput",
  "recovering",
  "cancellationRequested"
]);
const rendererMountProbe = `(() => {
  const root = document.querySelector('#root');
  const wakeElement = document.querySelector('[data-wake-state]');
  const wakeBridge = window.jarvis;
  return {
    mounted: Boolean(root?.children.length),
    wakeBridgeAvailable: [
      wakeBridge?.startWakeWordDetection,
      wakeBridge?.stopWakeWordDetection,
      wakeBridge?.onWakeWordDetected,
      wakeBridge?.onWakeWordError
    ].every(value => typeof value === 'function'),
    wakeState: wakeElement?.getAttribute('data-wake-state') ?? null
  };
})()`;
const rendererMountProbeAttempts = 40;
const rendererMountProbeDelayMs = 50;

let mainWindow: BrowserWindow | undefined;
let overlayWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let signalRConnection: HubConnection | undefined;
let rendererEntryUrl: string | undefined;
let isQuitting = false;
let overlayHideTimer: NodeJS.Timeout | undefined;
let wakeWordService: SherpaWakeWordService | undefined;
let backendBearer: string | undefined;
let backendBearerConfigurationError: Error | undefined;
let backendConnectionState: BackendConnectionState = {
  state: "disconnected",
  revision: 0
};
const notificationProjectionCache = new NotificationProjectionCache();

function configureBackendBearer(): void {
  try {
    const resolution = resolveDesktopBearer(
      process.env[desktopBearerEnvironmentVariable],
      new DesktopBearerStore(
        join(app.getPath("userData"), "credentials", "local-api-bearer.bin"),
        safeStorage));
    backendBearer = resolution.token;
    backendBearerConfigurationError = resolution.token
      ? undefined
      : new Error(
        `The Desktop backend bearer is not configured. Launch Jarvis once with ${desktopBearerEnvironmentVariable}.`);
    if (resolution.persistenceError) {
      console.error(
        "The Desktop backend bearer is available for this process but could not be persisted with macOS Keychain encryption.",
        resolution.persistenceError);
    }
  } catch (error) {
    backendBearer = undefined;
    backendBearerConfigurationError = error instanceof Error ? error : new Error(String(error));
  }

  backendConnectionState = {
    state: backendBearer ? "connecting" : "disconnected",
    revision: 0,
    ...(backendBearerConfigurationError?.message
      ? { error: backendBearerConfigurationError.message }
      : {})
  };
}

function wakeWordModelRoot(): string {
  const assetPath = fileURLToPath(new URL("../assets/sherpa-kws-wenetspeech-3.3M/", import.meta.url));
  if (!app.isPackaged) {
    return assetPath;
  }

  return assetPath.replace(`${sep}app.asar${sep}`, `${sep}app.asar.unpacked${sep}`);
}

function publishWakeWordEvent(channel: "wake-word:detected" | "wake-word:error", value?: string): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(
      channel,
      channel === "wake-word:error" ? wakeWordErrorCode : value);
  }
}

function stopWakeWordService(): void {
  try {
    wakeWordService?.stop();
  } catch (error) {
    console.error("Failed to stop local wake-word detection.", sanitizeWakeWordError(error).message);
  }
}

async function ensureMicrophoneAccess(): Promise<void> {
  if (process.platform !== "darwin") {
    return;
  }

  const status = systemPreferences.getMediaAccessStatus("microphone");
  if (status === "granted") {
    return;
  }
  if (status === "not-determined" && await systemPreferences.askForMediaAccess("microphone")) {
    return;
  }

  throw desktopActionFailure("retryable", "wake_unavailable");
}

function publishBackendConnectionState(
  window: BrowserWindow,
  state: BackendConnectionStateValue,
  error?: Error
): void {
  backendConnectionState = {
    state,
    revision: backendConnectionState.revision + 1,
    ...(error?.message ? { error: error.message } : {})
  };
  if (!window.isDestroyed()) {
    window.webContents.send("backend:connectionState", backendConnectionState);
  }
}

async function writeDesktopSmokeMarker(window: BrowserWindow): Promise<void> {
  const markerPath = process.env.JARVIS_DESKTOP_SMOKE_MARKER;
  const markerRoot = process.env.JARVIS_DESKTOP_SMOKE_ROOT;
  if (!markerPath || !markerRoot || !isAbsolute(markerPath) || !isAbsolute(markerRoot)) {
    return;
  }

  const temporaryRoot = resolve(tmpdir());
  const rootPath = resolve(markerRoot);
  const markerFullPath = resolve(markerPath);
  const rootFromTemporaryDirectory = relative(temporaryRoot, rootPath);
  const markerFromRoot = relative(rootPath, markerFullPath);
  if (rootPath === temporaryRoot
    || rootFromTemporaryDirectory.length === 0
    || rootFromTemporaryDirectory.startsWith("..")
    || isAbsolute(rootFromTemporaryDirectory)
    || markerFromRoot.length === 0
    || markerFromRoot.startsWith("..")
    || isAbsolute(markerFromRoot)) {
    return;
  }

  try {
    if (window.webContents.isLoading()) {
      await new Promise<void>((resolve, reject) => {
        const onFinished = (): void => {
          window.webContents.removeListener("did-fail-load", onFailed);
          resolve();
        };
        const onFailed = (): void => {
          window.webContents.removeListener("did-finish-load", onFinished);
          reject(new Error("The packaged renderer failed to load."));
        };
        window.webContents.once("did-finish-load", onFinished);
        window.webContents.once("did-fail-load", onFailed);
      });
    }

    for (let attempt = 0; attempt < rendererMountProbeAttempts; attempt++) {
      const rendererProbe = await window.webContents.executeJavaScript(rendererMountProbe) as {
        mounted?: unknown;
        wakeBridgeAvailable?: unknown;
        wakeState?: unknown;
      };
      if (rendererProbe?.mounted === true
        && rendererProbe.wakeBridgeAvailable === true
        && rendererProbe.wakeState === "standby") {
        writeFileSync(markerFullPath, `${JSON.stringify({
          backendBearerConfigured: Boolean(backendBearer && backendBearer.length >= 32),
          event: "renderer.ready",
          wakeBridgeAvailable: true,
          wakeState: "standby",
          pid: process.pid,
          version: app.getVersion(),
          occurredAt: Date.now()
        })}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
        chmodSync(markerFullPath, 0o600);
        return;
      }

      await new Promise(resolve => setTimeout(resolve, rendererMountProbeDelayMs));
    }
  } catch {
    // The marker is an opt-in release-test seam and must not change runtime
    // startup behavior when the environment is not configured correctly.
  }
}

async function requestBackend(
  path: string,
  method: "GET" | "POST",
  body?: unknown,
  idempotencyKey?: string
): Promise<unknown> {
  if (!backendBearer || backendBearer.length < 32) {
    throw desktopActionFailure("terminal", "not_configured");
  }

  const headers = new Headers({ Authorization: `Bearer ${backendBearer}` });
  if (body !== undefined) {
    headers.set("Content-Type", "application/json");
  }
  if (method === "POST") {
    if (!idempotencyKey || idempotencyKey.length > 200) {
      throw desktopActionFailure("terminal", "invalid_input");
    }
    headers.set("Idempotency-Key", idempotencyKey);
  }

  const response = await fetch(new URL(path, backendBaseUrl), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (!response.ok) {
    throw backendHttpFailure(response.status);
  }

  return response.json();
}

function record(value: unknown): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw desktopActionFailure("terminal", "invalid_input");
  }
  return value as JsonRecord;
}

function isSignalREnvelope(value: unknown): value is JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const envelope = value as JsonRecord;
  return typeof envelope.eventId === "string"
    && envelope.eventId.length > 0
    && envelope.eventId.length <= 200
    && typeof envelope.occurredAt === "number"
    && Number.isFinite(envelope.occurredAt)
    && typeof envelope.type === "string"
    && envelope.type.length > 0
    && typeof envelope.payload === "object"
    && envelope.payload !== null
    && !Array.isArray(envelope.payload);
}

function requiredString(value: unknown, _name: string, maxLength = 200): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) {
    throw desktopActionFailure("terminal", "invalid_input");
  }
  return value.trim();
}

function requiredBody(value: unknown): JsonRecord {
  return record(value);
}

function optionalString(value: unknown, name: string, maxLength = 200): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  return requiredString(value, name, maxLength);
}

function requiredStringArray(value: unknown, _name: string, maxItems = 100): string[] {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw desktopActionFailure("terminal", "invalid_input");
  }

  return value.map(item => requiredString(item, _name));
}

function optionalStringArray(value: unknown, name: string, maxItems = 100): string[] {
  if (value === undefined || value === null) {
    return [];
  }

  return requiredStringArray(value, name, maxItems);
}

function boundedUserInputAnswers(value: unknown): Record<string, { answers: string[] }> {
  const input = requiredBody(value);
  const entries = Object.entries(input);
  if (entries.length < 1 || entries.length > 3) {
    throw desktopActionFailure("terminal", "invalid_input");
  }

  let totalLength = 0;
  const answers: Record<string, { answers: string[] }> = {};
  for (const [questionId, answerValue] of entries) {
    const normalizedQuestionId = requiredString(questionId, "questionId", 200);
    const answerRecord = requiredBody(answerValue);
    if (!Array.isArray(answerRecord.answers)
      || answerRecord.answers.length < 1
      || answerRecord.answers.length > 20) {
      throw desktopActionFailure("terminal", "invalid_input");
    }

    const normalizedAnswers = answerRecord.answers.map(answer => requiredString(answer, "answer", 4_000));
    totalLength += normalizedAnswers.reduce((sum, answer) => sum + answer.length, 0);
    if (totalLength > 20_000) {
      throw desktopActionFailure("terminal", "invalid_input");
    }
    answers[normalizedQuestionId] = { answers: normalizedAnswers };
  }

  return answers;
}

function requiredUuidArray(value: unknown, name: string, maxItems = 100): string[] {
  return requiredStringArray(value, name, maxItems).map(item => {
    if (!isUuid(item)) {
      throw desktopActionFailure("terminal", "invalid_input");
    }
    return item;
  });
}

function optionalCapabilityEnvelope(value: unknown): JsonRecord | null {
  if (value === null || value === undefined) {
    return null;
  }

  const envelope = requiredBody(value);
  for (const name of ["readFiles", "writeFiles", "runCommands", "network"] as const) {
    if (typeof envelope[name] !== "boolean") {
      throw desktopActionFailure("terminal", "invalid_input");
    }
  }
  if (!Array.isArray(envelope.allowedRoots) || envelope.allowedRoots.length > 20) {
    throw desktopActionFailure("terminal", "invalid_input");
  }

  return {
    readFiles: envelope.readFiles,
    writeFiles: envelope.writeFiles,
    runCommands: envelope.runCommands,
    network: envelope.network,
    allowedRoots: envelope.allowedRoots.map(root =>
      requiredString(root, "capabilityEnvelope.allowedRoots", 4_000))
  };
}

function createMainWindow(rendererEntryUrl: string): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 860,
    minHeight: 620,
    webPreferences: {
      ...secureWebPreferences,
      preload: new URL("../preload/index.cjs", import.meta.url).pathname
    }
  });

  window.webContents.on("will-navigate", (event, url) => {
    if (isAllowedNavigation(url, rendererEntryUrl)) {
      return;
    }

    event.preventDefault();
    if (isAllowedExternalUrl(url)) {
      void shell.openExternal(url);
    }
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });

  void window.loadURL(rendererEntryUrl);
  return window;
}

function createOverlayWindow(): BrowserWindow {
  const entryUrl = new URL("../renderer/overlay.html", import.meta.url).href;
  const window = new BrowserWindow(createOverlayWindowOptions(
    new URL("../preload/overlay.cjs", import.meta.url).pathname));
  window.setAlwaysOnTop(true, "floating");
  window.webContents.on("will-navigate", event => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.on("closed", () => {
    if (overlayWindow === window) {
      overlayWindow = undefined;
    }
  });
  void window.loadURL(entryUrl);
  return window;
}

function showNotificationOverlay(value: unknown): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return;
  }

  const payload = value as Record<string, unknown>;
  const projection = notificationProjectionCache.accept({
    id: payload.notificationId,
    title: payload.title,
    body: payload.body
  });
  if (!projection) {
    return;
  }

  overlayWindow ??= createOverlayWindow();
  const send = (): void => {
    if (!overlayWindow || overlayWindow.isDestroyed()) {
      return;
    }
    overlayWindow.webContents.send("overlay:notification", projection);
    overlayWindow.showInactive();
    if (overlayHideTimer) {
      clearTimeout(overlayHideTimer);
    }
    overlayHideTimer = setTimeout(() => overlayWindow?.hide(), 6_000);
  };
  if (overlayWindow.webContents.isLoading()) {
    overlayWindow.webContents.once("did-finish-load", send);
  } else {
    send();
  }
}

function configureMainWindow(window: BrowserWindow): void {
  window.on("close", event => {
    if (!shouldHideWindowOnClose(isQuitting)) {
      return;
    }

    event.preventDefault();
    window.hide();
  });
  window.on("closed", () => {
    if (mainWindow === window) {
      stopWakeWordService();
      mainWindow = undefined;
    }
  });
  window.on("show", updateTrayMenu);
  window.on("hide", updateTrayMenu);
}

function ensureMainWindow(): BrowserWindow | undefined {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    return mainWindow;
  }
  if (!rendererEntryUrl) {
    return undefined;
  }

  mainWindow = createMainWindow(rendererEntryUrl);
  configureMainWindow(mainWindow);
  signalRConnection ??= startSignalR(mainWindow);
  return mainWindow;
}

function updateTrayMenu(): void {
  if (!tray) {
    return;
  }

  const visible = mainWindow?.isVisible() ?? false;
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: visible ? "Hide Jarvis" : "Show Jarvis",
      click: () => {
        if (visible) {
          mainWindow?.hide();
        } else {
          ensureMainWindow();
        }
      }
    },
    {
      label: "Quit",
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]));
}

function createTray(): void {
  const icon = nativeImage.createFromPath(fileURLToPath(new URL("../assets/JarvisTemplate.png", import.meta.url)));
  const highResolutionIcon = nativeImage.createFromPath(fileURLToPath(new URL("../assets/JarvisTemplate@2x.png", import.meta.url)));
  if (!icon.isEmpty() && !highResolutionIcon.isEmpty()) {
    icon.addRepresentation({
      scaleFactor: 2.0,
      buffer: highResolutionIcon.toPNG()
    });
  }
  if (icon.isEmpty()) {
    throw new Error("The packaged Jarvis tray template asset could not be loaded.");
  }
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip("Jarvis");
  tray.on("click", () => ensureMainWindow());
  updateTrayMenu();
}

function startSignalR(window: BrowserWindow): HubConnection | undefined {
  const bearer = backendBearer;
  if (!bearer || bearer.length < 32) {
    return undefined;
  }

  const connection = new HubConnectionBuilder()
    .withUrl(new URL(clientHubPath, backendBaseUrl).toString(), {
      accessTokenFactory: () => bearer
    })
    .configureLogging(desktopSignalRLogLevel)
    .withAutomaticReconnect()
    .build();

  for (const eventType of [
    "task.updated",
    "task.eventAdded",
    "notification.created",
    "notification.updated",
    "approval.required",
    "approval.resolved",
    "conversation.summaryUpdated",
    "realtime.sessionInvalidated"
  ]) {
    connection.on(eventType, envelope => {
      if (!isSignalREnvelope(envelope)) {
        return;
      }
      if (eventType === "notification.created") {
        showNotificationOverlay(envelope.payload);
      }
      if (!window.isDestroyed()) {
        window.webContents.send("backend:event", envelope);
      }
    });
  }

  connection.onreconnecting(error => publishBackendConnectionState(window, "reconnecting", error));
  connection.onreconnected(() => publishBackendConnectionState(window, "connected"));
  connection.onclose(error => publishBackendConnectionState(window, "disconnected", error));
  void connection.start()
    .then(() => publishBackendConnectionState(window, "connected"))
    .catch(error => publishBackendConnectionState(window, "disconnected", error instanceof Error ? error : undefined));
  return connection;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.whenReady().then(() => {
    configureBackendBearer();
    wakeWordService = new SherpaWakeWordService({
      modelRoot: wakeWordModelRoot(),
      onDetected: () => publishWakeWordEvent("wake-word:detected"),
      onError: error => {
        console.error("Local wake-word detection failed.", sanitizeWakeWordError(error).message);
        publishWakeWordEvent("wake-word:error", wakeWordErrorCode);
      }
    });
    handleDesktopIpc("app:getVersion", () => app.getVersion());
    handleDesktopIpc("wake-word:start", async (_event, value: unknown) => {
      try {
        const input = requiredBody(value);
        const keyword = requiredString(input.keyword, "keyword", 20);
        if (keyword !== supportedWakeWord) {
          throw desktopActionFailure("terminal", "invalid_input");
        }
        await ensureMicrophoneAccess();
        wakeWordService?.start(keyword);
      } catch (error) {
        console.error("Local wake-word detection could not start.", sanitizeWakeWordError(error).message);
        throw desktopActionFailure("retryable", "wake_unavailable");
      }
    });
    handleDesktopIpc("wake-word:stop", () => {
      try {
        wakeWordService?.stop();
      } catch (error) {
        console.error("Local wake-word detection could not stop.", sanitizeWakeWordError(error).message);
        throw desktopActionFailure("retryable", "wake_unavailable");
      }
    });
    handleDesktopIpc("backend:getConnectionState", () => backendConnectionState);
    handleDesktopIpc("backend:getDiagnostics", () => requestBackend("/api/v1/diagnostics", "GET"));
    handleDesktopIpc("backend:getDesktopDevice", () =>
      requestBackend("/api/v1/realtime/desktop-device", "POST", {}, randomUUID()));
    handleDesktopIpc("backend:createMobilePairing", (_event, value: unknown) => {
      const input = requiredBody(value);
      return requestBackend(
        "/api/v1/mobile-pairings",
        "POST",
        {
          deviceName: requiredString(input.deviceName, "deviceName"),
          platform: requiredString(input.platform, "platform", 64),
          capabilities: optionalStringArray(input.capabilities, "capabilities", 50)
        },
        requiredString(input.idempotencyKey, "idempotencyKey"));
    });
    handleDesktopIpc("backend:createConversation", (_event, value: unknown) => {
      const input = requiredBody(value);
      return requestBackend(
        "/api/v1/conversations",
        "POST",
        { title: typeof input.title === "string" ? input.title.slice(0, 500) : null },
        requiredString(input.idempotencyKey, "idempotencyKey"));
    });
    handleDesktopIpc("backend:getConversation", (_event, value: unknown) => {
      const input = requiredBody(value);
      return requestBackend(
        `/api/v1/conversations/${encodeURIComponent(requiredString(input.conversationId, "conversationId"))}`,
        "GET");
    });
    handleDesktopIpc("backend:addTypedMessage", (_event, value: unknown) => {
      const input = requiredBody(value);
      return requestBackend(
        `/api/v1/conversations/${encodeURIComponent(requiredString(input.conversationId, "conversationId"))}/messages/typed`,
        "POST",
        {
          clientRequestId: requiredString(input.clientRequestId, "clientRequestId"),
          text: requiredString(input.text, "text", 100_000),
          replyMode: "text",
          realtimeSessionId: typeof input.realtimeSessionId === "string"
            ? requiredString(input.realtimeSessionId, "realtimeSessionId")
            : null
        },
        requiredString(input.idempotencyKey, "idempotencyKey"));
    });
    handleDesktopIpc("backend:createRealtimeClientSecret", (_event, value: unknown) => {
      const input = requiredBody(value);
      return requestBackend(
        "/api/v1/realtime/client-secrets",
        "POST",
        {
          conversationId: requiredString(input.conversationId, "conversationId"),
          deviceId: requiredString(input.deviceId, "deviceId"),
          preferredVoice: typeof input.preferredVoice === "string" ? input.preferredVoice.slice(0, 100) : null
        },
        requiredString(input.idempotencyKey, "idempotencyKey"));
    });
    handleDesktopIpc("backend:realtimeConnected", (_event, value: unknown) => {
      const input = requiredBody(value);
      return requestBackend(
        `/api/v1/realtime/sessions/${encodeURIComponent(requiredString(input.sessionId, "sessionId"))}/connected`,
        "POST",
        { externalSessionId: requiredString(input.externalSessionId, "externalSessionId") },
        requiredString(input.idempotencyKey, "idempotencyKey"));
    });
    handleDesktopIpc("backend:realtimeEnded", (_event, value: unknown) => {
      const input = requiredBody(value);
      const status = input.status;
      if (status !== "rotated" && status !== "disconnected" && status !== "failed") {
        throw desktopActionFailure("terminal", "invalid_input");
      }
      return requestBackend(
        `/api/v1/realtime/sessions/${encodeURIComponent(requiredString(input.sessionId, "sessionId"))}/ended`,
        "POST",
        { reason: requiredString(input.reason, "reason", 500), status },
        requiredString(input.idempotencyKey, "idempotencyKey"));
    });
    handleDesktopIpc("backend:ingestRealtimeEvents", (_event, value: unknown) => {
      const input = requiredBody(value);
      if (!Array.isArray(input.events) || input.events.length < 1 || input.events.length > 100) {
        throw desktopActionFailure("terminal", "invalid_input");
      }
      return requestBackend(
        `/api/v1/conversations/${encodeURIComponent(requiredString(input.conversationId, "conversationId"))}/realtime-events:ingest`,
        "POST",
        { version: 1, events: input.events },
        requiredString(input.idempotencyKey, "idempotencyKey"));
    });
    handleDesktopIpc("backend:delegateTask", (_event, value: unknown) => {
      const input = requiredBody(value);
      const requiredCapabilities = requiredStringArray(input.requiredCapabilities, "requiredCapabilities", 20);
      const sourceMessageIds = requiredUuidArray(input.sourceMessageIds, "sourceMessageIds");
      const preferredDeviceId = input.preferredDeviceId === null || input.preferredDeviceId === undefined
        ? null
        : requiredString(input.preferredDeviceId, "preferredDeviceId");
      const expectedOutput = input.expectedOutput === null || input.expectedOutput === undefined
        ? null
        : requiredString(input.expectedOutput, "expectedOutput", 100_000);
      return requestBackend(
        taskApiPath,
        "POST",
        {
          conversationId: requiredString(input.conversationId, "conversationId"),
          goal: requiredString(input.goal, "goal", 100_000),
          expectedOutput,
          requiredCapabilities,
          preferredDeviceId,
          sourceMessageIds,
          attachmentRefs: requiredStringArray(input.attachmentRefs, "attachmentRefs", 100),
          capabilityEnvelope: optionalCapabilityEnvelope(input.capabilityEnvelope)
        },
        requiredString(input.idempotencyKey, "idempotencyKey"));
    });
    handleDesktopIpc("backend:getTaskStatus", (_event, value: unknown) => {
      const input = requiredBody(value);
      return requestBackend(
        `${taskApiPath}/${encodeURIComponent(requiredString(input.taskId, "taskId"))}`,
        "GET");
    });
    handleDesktopIpc("backend:submitTaskUserInput", (_event, value: unknown) => {
      const input = requiredBody(value);
      const taskId = requiredString(input.taskId, "taskId");
      if (!isUuid(taskId)) {
        throw desktopActionFailure("terminal", "invalid_input");
      }
      const executionId = optionalString(input.executionId, "executionId");
      if (executionId !== undefined && !isUuid(executionId)) {
        throw desktopActionFailure("terminal", "invalid_input");
      }
      const requestIdIsString = input.requestIdIsString === undefined
        ? true
        : input.requestIdIsString;
      if (typeof requestIdIsString !== "boolean") {
        throw desktopActionFailure("terminal", "invalid_input");
      }
      return requestBackend(
        `${taskApiPath}/${encodeURIComponent(taskId)}/user-input`,
        "POST",
        {
          requestId: requiredString(input.requestId, "requestId", 200),
          executionId,
          requestIdIsString,
          answers: boundedUserInputAnswers(input.answers)
        },
        requiredString(input.idempotencyKey, "idempotencyKey"));
    });
    handleDesktopIpc("backend:cancelTask", (_event, value: unknown) => {
      const input = requiredBody(value);
      return requestBackend(
        `${taskApiPath}/${encodeURIComponent(requiredString(input.taskId, "taskId"))}/cancel`,
        "POST",
        {},
        requiredString(input.idempotencyKey, "idempotencyKey"));
    });
    handleDesktopIpc("backend:rememberFact", (_event, value: unknown) => {
      const input = requiredBody(value);
      const sourceMessageId = requiredString(input.sourceMessageId, "sourceMessageId");
      if (!isUuid(sourceMessageId)) {
        throw desktopActionFailure("terminal", "invalid_input");
      }
      if (typeof input.sensitive !== "boolean") {
        throw desktopActionFailure("terminal", "invalid_input");
      }
      return requestBackend(
        memoryFactApiPath,
        "POST",
        {
          key: requiredString(input.key, "key"),
          value: requiredString(input.value, "value", 20_000),
          sourceMessageId,
          sensitive: input.sensitive
        },
        requiredString(input.idempotencyKey, "idempotencyKey"));
    });
    handleDesktopIpc("backend:getTasks", (_event, value: unknown) => {
      const input = requiredBody(value);
      const conversationId = optionalString(input.conversationId, "conversationId");
      const cursor = optionalString(input.cursor, "cursor");
      const status = optionalString(input.status, "status");
      if (status && !nonTerminalTaskStatuses.has(status)) {
        throw desktopActionFailure("terminal", "invalid_input");
      }
      const query = new URLSearchParams({ limit: "100" });
      if (conversationId) {
        query.set("conversationId", conversationId);
      }
      if (cursor) {
        query.set("cursor", cursor);
      }
      if (status) {
        query.set("status", status);
      }
      const suffix = query.toString();
      return requestBackend(`${taskApiPath}${suffix ? `?${suffix}` : ""}`, "GET");
    });
    handleDesktopIpc("backend:getNotifications", (_event, value: unknown) => {
      const input = requiredBody(value);
      const conversationId = optionalString(input.conversationId, "conversationId");
      const query = new URLSearchParams({ status: "unread" });
      if (conversationId) {
        query.set("conversationId", conversationId);
      }
      return requestBackend(`${notificationApiPath}?${query.toString()}`, "GET");
    });
    for (const action of ["delivered", "read", "dismiss"] as const) {
      handleDesktopIpc(`backend:${action}Notification`, (_event, value: unknown) => {
        const input = requiredBody(value);
        return requestBackend(
          `${notificationApiPath}/${encodeURIComponent(requiredString(input.notificationId, "notificationId"))}/${action}`,
          "POST",
          {},
          requiredString(input.idempotencyKey, "idempotencyKey"));
      });
    }
    handleDesktopIpc("backend:applyNotificationAction", (_event, value: unknown) => {
      const input = requiredBody(value);
      const actionId = requiredString(input.actionId, "actionId");
      if (actionId !== "acknowledge") {
        throw desktopActionFailure("terminal", "invalid_input");
      }
      return requestBackend(
        `${notificationApiPath}/${encodeURIComponent(requiredString(input.notificationId, "notificationId"))}/actions/${actionId}`,
        "POST",
        {},
        requiredString(input.idempotencyKey, "idempotencyKey"));
    });
    handleDesktopIpc("backend:getApprovals", () =>
      requestBackend(`${approvalApiPath}?status=pending`, "GET"));
    handleDesktopIpc("backend:decideApproval", (_event, value: unknown) => {
      const input = requiredBody(value);
      const approvalId = requiredString(input.approvalId, "approvalId");
      if (!isUuid(approvalId)) {
        throw desktopActionFailure("terminal", "invalid_input");
      }
      const decision = input.decision;
      if (decision !== "approve" && decision !== "deny") {
        throw desktopActionFailure("terminal", "invalid_input");
      }
      const scope = input.scope;
      if (scope !== "once" && scope !== "taskSession") {
        throw desktopActionFailure("terminal", "invalid_input");
      }
      return requestBackend(
        `${approvalApiPath}/${encodeURIComponent(approvalId)}/decision`,
        "POST",
        {
          decision,
          scope,
          clientRequestId: requiredString(input.clientRequestId, "clientRequestId")
        },
        requiredString(input.idempotencyKey, "idempotencyKey"));
    });
    rendererEntryUrl = getRendererEntryUrl(app.isPackaged, process.env.JARVIS_DEV_SERVER_URL);
    const window = ensureMainWindow();
    createTray();
    if (window) {
      void writeDesktopSmokeMarker(window);
    }
  });
}

app.on("second-instance", () => {
  ensureMainWindow();
});

app.on("activate", () => {
  ensureMainWindow();
});

app.on("before-quit", () => {
  isQuitting = true;
  stopWakeWordService();
  if (signalRConnection) {
    void signalRConnection.stop();
  }
});
