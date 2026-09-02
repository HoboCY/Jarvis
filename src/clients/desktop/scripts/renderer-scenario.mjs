import { app, BrowserWindow, ipcMain } from "electron";
import { existsSync, statSync } from "node:fs";
import { mkdir, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { resolveRendererDependencies } from "./renderer-dependencies.mjs";

const desktopRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));
const repositoryRoot = resolve(desktopRoot, "../../..");
const canonicalDistRoot = resolve(join(desktopRoot, "dist"));
const distRoot = resolve(process.env.JARVIS_DESKTOP_SCENARIO_DIST ?? canonicalDistRoot);
const scenarioOutput = process.env.JARVIS_DESKTOP_SCENARIO_OUTPUT
  ? resolve(process.env.JARVIS_DESKTOP_SCENARIO_OUTPUT)
  : undefined;
const rendererDependencies = resolveRendererDependencies(desktopRoot);
const rendererDependencyPlugin = {
  name: "desktop-scenario-renderer-dependencies",
  setup(esbuild) {
    esbuild.onResolve({ filter: /^(?:react|react\/jsx-runtime|react-dom\/client)$/ }, args => {
      const target = rendererDependencies.get(args.path);
      return target ? { path: target } : undefined;
    });
  }
};
const workspaceSourcePlugin = {
  name: "desktop-scenario-workspace-sources",
  setup(esbuild) {
    const sources = new Map([
      ["@jarvis/contracts-ts", join(repositoryRoot, "packages/contracts-ts/src/index.ts")],
      ["@jarvis/realtime-agent", join(repositoryRoot, "packages/realtime-agent/src/index.ts")]
    ]);
    esbuild.onResolve({ filter: /^@jarvis\/(?:contracts-ts|realtime-agent)$/ }, args => {
      const source = sources.get(args.path);
      return source ? { path: source } : undefined;
    });
  }
};

const taskId = "0198b0a1-0000-7000-8000-000000000201";
const executionId = "0198b0a1-0000-7000-8000-000000000202";
const conversationId = "0198b0a1-0000-7000-8000-000000000203";
const approvalId = "0198b0a1-0000-7000-8000-000000000204";
const notificationId = "0198b0a1-0000-7000-8000-000000000205";
const inputTaskId = "0198b0a1-0000-7000-8000-000000000206";
const inputExecutionId = "0198b0a1-0000-7000-8000-000000000207";
const approvalIdTwo = "0198b0a1-0000-7000-8000-000000000210";
const notificationIdTwo = "0198b0a1-0000-7000-8000-000000000211";
const notificationIdThree = "0198b0a1-0000-7000-8000-000000000213";
const scenarioUserDataPrefix = "jarvis-desktop-scenario-";
const registeredChannels = new Set();
const configuredUserDataPath = process.env.JARVIS_DESKTOP_SCENARIO_USER_DATA;
const scenarioUserDataPath = typeof configuredUserDataPath === "string"
  ? resolve(configuredUserDataPath)
  : undefined;
let scenarioUserDataMode;
let canonicalDistProof;
let distBundleProof = { rendererBundle: false, preloadBundle: false };
const desktopIpcEnvelopeBrand = "jarvis.desktop.ipc";
const desktopActionFailureBrand = "jarvis.desktop.action-failure";
const desktopIpcProtocolVersion = 1;
function scenarioIpcFailure(kind, code) {
  if (typeof kind !== "string" || typeof code !== "string" || !kind || !code) {
    throw new Error("The renderer scenario requires an allowlisted IPC failure.");
  }
  return {
    brand: desktopIpcEnvelopeBrand,
    version: desktopIpcProtocolVersion,
    ok: false,
    failure: {
      brand: desktopActionFailureBrand,
      version: desktopIpcProtocolVersion,
      kind,
      code
    }
  };
}

function isScenarioIpcFailureEnvelope(value) {
  const failure = value?.failure;
  return Boolean(value
    && typeof value === "object"
    && !Array.isArray(value)
    && value.brand === desktopIpcEnvelopeBrand
    && value.version === desktopIpcProtocolVersion
    && value.ok === false
    && failure
    && typeof failure === "object"
    && !Array.isArray(failure)
    && failure.brand === desktopActionFailureBrand
    && failure.version === desktopIpcProtocolVersion
    && typeof failure.kind === "string"
    && typeof failure.code === "string");
}

const scenarioDiagnosticsFailure = scenarioIpcFailure("retryable", "backend_unavailable");
const retryableDeliveryFailure = scenarioIpcFailure("retryable", "backend_unavailable");
const terminalDeliveryFailure = scenarioIpcFailure("terminal", "not_pending");
let diagnosticsAttempts = 0;
const approvalDecisions = [];
const taskInputSubmissions = [];
const taskStatusRequests = [];
const cancelledTasks = [];
const pairingRequests = [];
const notificationActions = [];
const notificationDeliveryOutcomes = new Map([
  [notificationId, "succeeded"],
  [notificationIdTwo, "retryable"],
  [notificationIdThree, "terminal"]
]);
const notificationDeliveryAttemptCounts = new Map();
const notificationDeliveryAttempts = [];
const notificationReadAttemptCounts = new Map();
const notificationReadAttempts = [];
let notificationDeliveryDeferredEntered;
let notificationDeliveryDeferredEnteredResolve;
let notificationDeliveryDeferred;
let notificationDeliveryDeferredResolve;

function assertScenarioUserDataPath() {
  if (typeof scenarioUserDataPath !== "string") {
    throw new Error("The renderer scenario requires a parent-owned userData path.");
  }

  const temporaryRoot = resolve(tmpdir());
  const relativePath = relative(temporaryRoot, scenarioUserDataPath);
  if (dirname(scenarioUserDataPath) !== temporaryRoot
    || !basename(scenarioUserDataPath).startsWith(scenarioUserDataPrefix)
    || relativePath.length === 0
    || relativePath.startsWith("..")
    || relativePath.includes("..")
    || !existsSync(scenarioUserDataPath)) {
    throw new Error("The renderer scenario userData path is not isolated.");
  }
}

function configureScenarioStorage() {
  if (typeof scenarioUserDataPath !== "string") {
    return;
  }

  assertScenarioUserDataPath();
  const mode = statSync(scenarioUserDataPath).mode & 0o777;
  if (mode !== 0o700) {
    throw new Error(`Scenario userData must be owner-only; received mode ${mode.toString(8)}.`);
  }
  scenarioUserDataMode = mode;
  app.setPath("userData", scenarioUserDataPath);
  app.setPath("sessionData", scenarioUserDataPath);
  app.commandLine.appendSwitch("user-data-dir", scenarioUserDataPath);
  app.commandLine.appendSwitch("disk-cache-dir", join(scenarioUserDataPath, "Cache"));
}

configureScenarioStorage();
app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("force-prefers-reduced-motion");

function armNotificationDeliveryDeferred() {
  notificationDeliveryDeferredEntered = new Promise(resolve => {
    notificationDeliveryDeferredEnteredResolve = resolve;
  });
  notificationDeliveryDeferred = new Promise(resolve => {
    notificationDeliveryDeferredResolve = resolve;
  });
  notificationDeliveryOutcomes.set(notificationIdTwo, "deferred");
}

async function waitForNotificationDeliveryDeferred() {
  if (!notificationDeliveryDeferredEntered) {
    throw new Error("The renderer scenario did not arm deferred notification delivery.");
  }
  await Promise.race([
    notificationDeliveryDeferredEntered,
    wait(2_000).then(() => {
      throw new Error("The renderer scenario did not enter deferred notification delivery.");
    })
  ]);
}

async function readNotificationDeliveryFeedback(window, title) {
  return evaluate(window, `(() => {
    const item = [...document.querySelectorAll(".notification-item")]
      .find(element => element.querySelector("strong")?.textContent?.trim() === ${JSON.stringify(title)});
    const feedback = item?.querySelector(".notification-delivery-feedback .action-feedback");
    return {
      title: ${JSON.stringify(title)},
      itemFound: Boolean(item),
      className: typeof feedback?.className === "string" ? feedback.className : null,
      text: feedback?.textContent?.trim() ?? null,
      role: feedback?.getAttribute("role") ?? null,
      userActionFeedbackPresent: Boolean(item?.querySelector(".notification-action-feedback"))
    };
  })()`);
}

async function readInitialNotificationDeliveryFeedback(window) {
  const titles = ["任务需要关注", "报告已准备", "归档已完成"];
  let feedback = [];
  for (let attempt = 0; attempt < 20; attempt++) {
    feedback = await Promise.all(titles.map(title => readNotificationDeliveryFeedback(window, title)));
    if (feedback.every(item => item.itemFound && item.className && item.text && item.role)) {
      return feedback;
    }
    await wait(25);
  }
  return feedback;
}

async function waitForNotificationDeliveryFeedback(window, title, className, text) {
  let feedback;
  for (let attempt = 0; attempt < 20; attempt++) {
    feedback = await readNotificationDeliveryFeedback(window, title);
    if (feedback.itemFound
      && feedback.className === className
      && feedback.text === text) {
      return feedback;
    }
    await wait(25);
  }
  return feedback;
}

async function readNotificationActionFeedback(window, title) {
  return evaluate(window, `(() => {
    const item = [...document.querySelectorAll(".notification-item")]
      .find(element => element.querySelector("strong")?.textContent?.trim() === ${JSON.stringify(title)});
    const deliveryFeedback = item?.querySelector(".notification-delivery-feedback .action-feedback");
    const actionFeedback = item?.querySelector(".notification-action-feedback .action-feedback");
    const readButton = [...(item?.querySelectorAll(".notification-actions button") ?? [])]
      .find(element => ["已读", "重试已读"].includes(element.textContent?.trim() ?? ""));
    return {
      title: ${JSON.stringify(title)},
      itemFound: Boolean(item),
      deliveryClassName: typeof deliveryFeedback?.className === "string" ? deliveryFeedback.className : null,
      deliveryText: deliveryFeedback?.textContent?.trim() ?? null,
      actionClassName: typeof actionFeedback?.className === "string" ? actionFeedback.className : null,
      actionText: actionFeedback?.textContent?.trim() ?? null,
      actionRole: actionFeedback?.getAttribute("role") ?? null,
      readButtonText: readButton?.textContent?.trim() ?? null,
      readButtonDisabled: readButton instanceof HTMLButtonElement ? readButton.disabled : null
    };
  })()`);
}

async function waitForNotificationReadFeedback(window, title) {
  let feedback;
  for (let attempt = 0; attempt < 20; attempt++) {
    feedback = await readNotificationActionFeedback(window, title);
    if (feedback.itemFound
      && feedback.deliveryClassName === "action-feedback is-succeeded"
      && feedback.deliveryText === "通知送达回执：已完成"
      && feedback.actionClassName === "action-feedback is-retryable"
      && feedback.actionText === "通知已读：Backend 暂时不可用，请稍后重试。"
      && feedback.readButtonText === "重试已读"
      && feedback.readButtonDisabled === false) {
      return feedback;
    }
    await wait(25);
  }
  return feedback;
}

async function waitForNotificationRemoved(window, title) {
  let feedback;
  for (let attempt = 0; attempt < 20; attempt++) {
    feedback = await readNotificationActionFeedback(window, title);
    if (!feedback.itemFound) {
      return feedback;
    }
    await wait(25);
  }
  return feedback;
}

const conversation = {
  id: conversationId,
  title: "Renderer scenario conversation",
  messages: [
    { id: "message-1", role: "user", text: "检查控制面板", status: "completed" },
    { id: "message-2", role: "assistant", text: "控制面板已连接。", status: "completed" }
  ],
  messageCount: 2
};

const tasks = [
  { id: taskId, status: "running", goal: "检查控制面板", execution: { id: executionId }, progressSummary: "正在收集状态" },
  {
    id: inputTaskId,
    status: "waitingForUserInput",
    goal: "选择报告格式",
    execution: { id: inputExecutionId },
    pendingUserInput: {
      requestId: "scenario-request-1",
      itemId: "scenario-item-1",
      threadId: "scenario-thread-1",
      turnId: "scenario-turn-1",
      questions: [{ id: "format", header: "格式", question: "选择输出格式", options: [
        { label: "Markdown", description: "便于阅读" },
        { label: "PDF", description: "适合归档" }
      ] }]
    }
  }
];

const approvals = [
  {
    id: approvalId,
    taskId,
    executionId,
    deviceId: "0198b0a1-0000-7000-8000-000000000208",
    kind: "fileWrite",
    reason: "保存报告到工作区",
    status: "pending",
    scope: null
  },
  {
    id: approvalIdTwo,
    taskId: inputTaskId,
    executionId: inputExecutionId,
    deviceId: "0198b0a1-0000-7000-8000-000000000212",
    kind: "command",
    reason: "执行报告整理命令",
    status: "pending",
    scope: null
  }
];

const notifications = [
  {
    id: notificationId,
    status: "pending",
    title: "任务需要关注",
    body: "控制面板场景通知",
    actionsJson: '["acknowledge"]'
  },
  {
    id: notificationIdTwo,
    status: "pending",
    title: "报告已准备",
    body: "控制面板第二条通知",
    actionsJson: '["acknowledge"]'
  },
  {
    id: notificationIdThree,
    status: "pending",
    title: "归档已完成",
    body: "控制面板第三条通知",
    actionsJson: '["acknowledge"]'
  }
];

// Keep this list at the user-surface boundary. It is intentionally explicit so
// the built scenario cannot pass while only a handful of action buttons happen
// to be visible. Retry controls are conditional because their truthful UI is
// only rendered while the corresponding realtime failure is active.
const requiredControlSpecs = [
  { id: "nav-assistant", selector: 'button.nav-item[aria-label="助手"]', container: "viewport" },
  { id: "nav-conversation", selector: 'button.nav-item[aria-label="会话"]', container: "viewport" },
  { id: "nav-tasks", selector: 'button.nav-item[aria-label="任务"]', container: "viewport" },
  { id: "nav-approvals", selector: 'button.nav-item[aria-label="审批"]', container: "viewport" },
  { id: "nav-settings", selector: 'button.nav-item[aria-label="设置"]', container: "viewport" },
  { id: "header-notifications", selector: ".notification-button", container: "viewport" },
  { id: "header-connection", selector: ".connection-button", container: "viewport" },
  { id: "header-session-summary", selector: '.session-menu > summary[aria-label="会话选项"]', container: "viewport" },
  { id: "header-session-new", selector: ".session-popover button", text: "新建", container: "viewport" },
  { id: "header-conversation-input", selector: '#conversation-id[aria-label="Conversation ID"]', container: "viewport" },
  { id: "header-conversation-load", selector: ".session-input-row button", text: "加载", container: "viewport" },
  { id: "realtime-persistence-retry", selector: ".header-actions .quiet-button", text: "重试保存", required: false, container: "viewport" },
  { id: "realtime-wake-retry", selector: ".header-actions .quiet-button", text: "重试唤醒", required: false, container: "viewport" },
  { id: "voice-presence", selector: ".voice-presence", container: "viewport" },
  { id: "composer-input", selector: '.composer input[aria-label="Typed message"]', container: "viewport" },
  { id: "composer-microphone", selector: ".composer-mic", container: "viewport" },
  { id: "composer-send", selector: ".composer-send", container: "viewport" },
  { id: "composer-stop", selector: ".composer-note button", text: "停止回答", required: false, container: "viewport" },
  { id: "task-cancel-running", selector: ".task-list .task-item:nth-child(1) .text-action", container: "action-scroll" },
  { id: "task-cancel-user-input", selector: ".task-list .task-item:nth-child(2) .text-action", container: "action-scroll" },
  { id: "task-input-select", selector: ".task-list .task-item:nth-child(2) .task-input-form select", container: "action-scroll" },
  { id: "task-input-submit", selector: ".task-list .task-item:nth-child(2) .task-input-form button", text: "提交答案", container: "action-scroll" },
  { id: "approval-one-approve", selector: ".approval-list .approval-item:nth-child(1) .approval-actions .approve-button", container: "action-scroll" },
  { id: "approval-one-deny", selector: ".approval-list .approval-item:nth-child(1) .approval-actions button:not(.approve-button)", container: "action-scroll" },
  { id: "approval-two-approve", selector: ".approval-list .approval-item:nth-child(2) .approval-actions .approve-button", container: "action-scroll" },
  { id: "approval-two-deny", selector: ".approval-list .approval-item:nth-child(2) .approval-actions button:not(.approve-button)", container: "action-scroll" },
  { id: "notification-one-acknowledge", selector: ".notification-list .notification-item:nth-child(1) .notification-actions button:nth-of-type(1)", container: "action-scroll" },
  { id: "notification-one-read", selector: ".notification-list .notification-item:nth-child(1) .notification-actions button:nth-of-type(2)", container: "action-scroll" },
  { id: "notification-one-dismiss", selector: ".notification-list .notification-item:nth-child(1) .notification-actions button:nth-of-type(3)", container: "action-scroll" },
  { id: "notification-two-acknowledge", selector: ".notification-list .notification-item:nth-child(2) .notification-actions button:nth-of-type(1)", container: "action-scroll" },
  { id: "notification-two-read", selector: ".notification-list .notification-item:nth-child(2) .notification-actions button:nth-of-type(2)", container: "action-scroll" },
  { id: "notification-two-dismiss", selector: ".notification-list .notification-item:nth-child(2) .notification-actions button:nth-of-type(3)", container: "action-scroll" },
  { id: "notification-three-acknowledge", selector: ".notification-list .notification-item:nth-child(3) .notification-actions button:nth-of-type(1)", container: "action-scroll" },
  { id: "notification-three-read", selector: ".notification-list .notification-item:nth-child(3) .notification-actions button:nth-of-type(2)", container: "action-scroll" },
  { id: "notification-three-dismiss", selector: ".notification-list .notification-item:nth-child(3) .notification-actions button:nth-of-type(3)", container: "action-scroll" },
  { id: "diagnostics-refresh", selector: ".diagnostics-button", container: "action-scroll" },
  { id: "mobile-pairing-create", selector: ".pairing-section > button", container: "action-scroll" },
  { id: "toast-live-status", selector: '.notification-toast[role="dialog"][aria-live="polite"]', interactive: false, container: "viewport" },
  { id: "toast-acknowledge", selector: ".notification-toast .toast-actions button:nth-of-type(1)", container: "viewport" },
  { id: "toast-read", selector: ".notification-toast .toast-actions button:nth-of-type(2)", container: "viewport" },
  { id: "toast-dismiss", selector: ".notification-toast .toast-actions button:nth-of-type(3)", container: "viewport" }
];

function registerHandler(channel, handler) {
  ipcMain.handle(channel, async (event, ...args) => {
    const value = await handler(event, ...args);
    if (isScenarioIpcFailureEnvelope(value)) {
      return value;
    }
    return {
      brand: desktopIpcEnvelopeBrand,
      version: desktopIpcProtocolVersion,
      ok: true,
      value
    };
  });
  registeredChannels.add(channel);
}

function registerScenarioIpc() {
  registerHandler("app:getVersion", () => "scenario");
  registerHandler("backend:getDesktopDevice", () => ({
    deviceId: "scenario-device",
    name: "Scenario Mac",
    deviceType: "desktop",
    platform: "macos",
    status: "online"
  }));
  registerHandler("backend:getConnectionState", () => ({ state: "connected", revision: 1 }));
  registerHandler("backend:getConversation", () => conversation);
  registerHandler("backend:createConversation", () => conversation);
  registerHandler("backend:getTasks", () => ({ items: tasks, nextCursor: null }));
  registerHandler("backend:getNotifications", () => ({ items: notifications }));
  registerHandler("backend:getApprovals", () => ({ items: approvals }));
  registerHandler("backend:getDiagnostics", () => {
    diagnosticsAttempts++;
    if (diagnosticsAttempts <= 2) {
      return scenarioDiagnosticsFailure;
    }
    return {
      version: "scenario",
      uptimeSeconds: 12,
      database: { available: true },
      work: {
        tasksByStatus: { running: 1, waitingForUserInput: 1 },
        pendingApprovals: 2,
        unreadNotifications: 3,
        pendingOutbox: 0,
        onlineDevices: 1
      },
      workers: { desktop: "ready" },
      circuits: { backend: "closed" }
    };
  });
  registerHandler("backend:deliveredNotification", async (_event, input) => {
    const deliveredNotificationId = input?.notificationId ?? null;
    const attempt = (notificationDeliveryAttemptCounts.get(deliveredNotificationId) ?? 0) + 1;
    const idempotencyKey = typeof input?.idempotencyKey === "string"
      && input.idempotencyKey.length <= 200
      ? input.idempotencyKey
      : null;
    const outcome = notificationDeliveryOutcomes.get(deliveredNotificationId) ?? "succeeded";
    notificationDeliveryAttemptCounts.set(deliveredNotificationId, attempt);
    notificationDeliveryAttempts.push({
      notificationId: deliveredNotificationId,
      idempotencyKey,
      attempt,
      outcome
    });
    if (outcome === "retryable") {
      return retryableDeliveryFailure;
    }
    if (outcome === "terminal") {
      return terminalDeliveryFailure;
    }
    if (outcome === "deferred") {
      notificationDeliveryDeferredEnteredResolve?.();
      await notificationDeliveryDeferred;
      return undefined;
    }
    notificationActions.push({ action: "delivered", notificationId: deliveredNotificationId });
    return undefined;
  });
  registerHandler("backend:readNotification", (_event, input) => {
    const readNotificationId = input?.notificationId ?? null;
    const attempt = (notificationReadAttemptCounts.get(readNotificationId) ?? 0) + 1;
    const idempotencyKey = typeof input?.idempotencyKey === "string"
      && input.idempotencyKey.length <= 200
      ? input.idempotencyKey
      : null;
    const outcome = readNotificationId === notificationIdTwo && attempt === 1
      ? "retryable"
      : "succeeded";
    notificationReadAttemptCounts.set(readNotificationId, attempt);
    notificationReadAttempts.push({
      notificationId: readNotificationId,
      idempotencyKey,
      attempt,
      outcome
    });
    if (outcome === "retryable") {
      return retryableDeliveryFailure;
    }
    notificationActions.push({ action: "read", notificationId: readNotificationId });
    return undefined;
  });
  registerHandler("backend:dismissNotification", (_event, input) => {
    notificationActions.push({ action: "dismiss", notificationId: input?.notificationId ?? null });
    return undefined;
  });
  registerHandler("backend:applyNotificationAction", (_event, input) => {
    notificationActions.push({
      action: input?.actionId ?? "acknowledge",
      notificationId: input?.notificationId ?? null
    });
    return undefined;
  });
  registerHandler("backend:cancelTask", (_event, input) => {
    cancelledTasks.push(input?.taskId ?? null);
    return { accepted: true, status: "cancellationRequested" };
  });
  registerHandler("backend:submitTaskUserInput", (_event, input) => {
    taskInputSubmissions.push({
      taskId: input?.taskId ?? null,
      requestId: input?.requestId ?? null,
      answers: input?.answers ?? null,
      idempotencyKey: input?.idempotencyKey ?? null
    });
    return {
      taskId: inputTaskId,
      executionId: inputExecutionId,
      requestId: "scenario-request-1",
      accepted: true,
      status: "queued",
      executionStatus: "assigned"
    };
  });
  registerHandler("backend:decideApproval", (_event, input) => {
    approvalDecisions.push({
      approvalId: input?.approvalId ?? null,
      decision: input?.decision ?? null,
      idempotencyKey: input?.idempotencyKey ?? null
    });
    return {
      ...(approvals.find(approval => approval.id === input?.approvalId) ?? approvals[0]),
      status: input?.decision === "approve" ? "approved" : "denied",
      scope: input?.scope ?? "once"
    };
  });
  registerHandler("backend:createMobilePairing", (_event, input) => {
    pairingRequests.push({ idempotencyKey: input?.idempotencyKey ?? null });
    return {
      code: "scenario-pairing-code-0000000000000000000000000000",
      expiresAtMs: Date.now() + 60_000
    };
  });
  registerHandler("backend:createRealtimeClientSecret", () => ({
    realtimeSessionId: "0198b0a1-0000-7000-8000-000000000209",
    clientSecret: "scenario-client-secret",
    webRtcUrl: "https://example.invalid/realtime",
    model: "scenario",
    voice: "scenario",
    instructions: "scenario",
    wakeWord: { enabled: true, keyword: "贾维斯" }
  }));
  registerHandler("backend:addTypedMessage", () => ({ accepted: true }));
  registerHandler("backend:realtimeConnected", () => ({ accepted: true }));
  registerHandler("backend:realtimeEnded", () => ({ accepted: true }));
  registerHandler("backend:ingestRealtimeEvents", () => ({ accepted: true }));
  registerHandler("backend:delegateTask", () => ({ accepted: true }));
  registerHandler("backend:getTaskStatus", (_event, input) => {
    taskStatusRequests.push(input?.taskId ?? null);
    return input?.taskId === inputTaskId
      ? {
        id: inputTaskId,
        status: "waitingForUserInput",
        execution: { id: inputExecutionId },
        progressSummary: null,
        pendingUserInput: tasks[1].pendingUserInput
      }
      : { id: taskId, status: "running", execution: { id: executionId }, progressSummary: null };
  });
  registerHandler("backend:rememberFact", () => ({ accepted: true }));
  registerHandler("wake-word:start", () => undefined);
  registerHandler("wake-word:stop", () => undefined);
}

function wait(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function evaluate(window, expression) {
  return window.webContents.executeJavaScript(expression);
}

async function buildRealtimeRecoveryHarness() {
  const result = await build({
    absWorkingDir: repositoryRoot,
    bundle: true,
    conditions: ["browser", "import", "default"],
    entryPoints: [fileURLToPath(new URL("./realtime-recovery-scenario.tsx", import.meta.url))],
    format: "iife",
    jsx: "automatic",
    logLevel: "silent",
    platform: "browser",
    plugins: [workspaceSourcePlugin, rendererDependencyPlugin],
    target: "es2022",
    write: false
  });
  const output = result.outputFiles?.[0]?.text;
  if (!output) {
    throw new Error("The realtime recovery scenario harness did not produce an in-memory bundle.");
  }
  return output;
}

async function inspectHarnessControl(window, attributeName, controlKey, expectedVisible) {
  const controlSelector = `[${attributeName}="${controlKey}"]`;
  const checks = [];
  for (const factor of [0.9, 1, 1.1]) {
    window.webContents.setZoomFactor(factor);
    await wait(40);
    const sentinelFocused = await evaluate(window, `(() => {
      const sentinel = document.querySelector("[data-realtime-recovery-tab-sentinel]");
      if (!(sentinel instanceof HTMLElement)) {
        return false;
      }
      sentinel.focus({ preventScroll: true });
      return document.activeElement === sentinel;
    })()`);
    if (expectedVisible && sentinelFocused) {
      window.webContents.sendInputEvent({ type: "keyDown", keyCode: "TAB" });
      window.webContents.sendInputEvent({ type: "keyUp", keyCode: "TAB" });
      await wait(20);
    }
    checks.push({
      factor,
      ...(await evaluate(window, `(() => {
        const host = document.querySelector("[data-realtime-recovery-scenario]");
        const button = host?.querySelector(${JSON.stringify(controlSelector)});
        const viewport = { width: window.innerWidth, height: window.innerHeight };
        const hostRect = host?.getBoundingClientRect();
        const rect = button?.getBoundingClientRect();
        const inBounds = value => Boolean(value
          && value.width > 0 && value.height > 0
          && value.left >= 0 && value.right <= viewport.width
          && value.top >= 0 && value.bottom <= viewport.height);
        const insideContainer = Boolean(rect && hostRect
          && rect.left >= hostRect.left && rect.right <= hostRect.right
          && rect.top >= hostRect.top && rect.bottom <= hostRect.bottom);
        const present = button instanceof HTMLButtonElement;
        const focusable = present && !button.disabled && button.tabIndex >= 0;
        const activeElement = document.activeElement;
        const keyboardFocused = activeElement === button;
        const focusVisible = focusable && keyboardFocused && button.matches(":focus-visible");
        const buttonRectInBounds = inBounds(rect);
        const centerX = rect ? rect.left + rect.width / 2 : 0;
        const centerY = rect ? rect.top + rect.height / 2 : 0;
        const hit = buttonRectInBounds ? document.elementFromPoint(centerX, centerY) : null;
        const hitByControl = Boolean(hit && (hit === button || button?.contains(hit) || hit?.contains(button)));
        const criticalOverlap = Boolean(rect && buttonRectInBounds && !hitByControl);
        return {
          expectedVisible: ${expectedVisible ? "true" : "false"},
          attributeName: ${JSON.stringify(attributeName)},
          controlKey: ${JSON.stringify(controlKey)},
          present,
          controlIds: [...(host?.querySelectorAll(${JSON.stringify(`[${attributeName}]`)}) ?? [])]
            .map(element => element.getAttribute(${JSON.stringify(attributeName)})),
          label: button?.getAttribute("aria-label") ?? button?.textContent?.trim() ?? null,
          disabled: button instanceof HTMLButtonElement ? button.disabled : null,
          focusable,
          keyboardFocused,
          focusVisible,
          sentinelFocused: ${sentinelFocused ? "true" : "false"},
          insideContainer,
          inViewport: buttonRectInBounds,
          noHorizontalOverflow: document.documentElement.scrollWidth <= viewport.width,
          criticalOverlap,
          rect: rect ? {
            left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
            width: rect.width, height: rect.height
          } : null
        };
      })()`))
    });
  }
  window.webContents.setZoomFactor(1);
  await wait(40);
  return checks;
}

async function inspectRealtimeRecoveryControl(window, recoveryKey, expectedVisible) {
  return inspectHarnessControl(window, "data-realtime-recovery", recoveryKey, expectedVisible);
}

async function inspectRealtimeConnectionControl(window) {
  return inspectHarnessControl(window, "data-realtime-connection", "connect", true);
}

async function tab(window) {
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "TAB" });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "TAB" });
  await wait(10);
  return evaluate(window, `(() => {
    const active = document.activeElement;
    return active instanceof HTMLElement
      ? {
        tag: active.tagName,
        label: active.getAttribute("aria-label"),
        text: active.textContent?.trim() ?? "",
        focusVisible: active.matches(":focus-visible"),
        outline: getComputedStyle(active).outline,
        outlineStyle: getComputedStyle(active).outlineStyle,
        outlineWidth: getComputedStyle(active).outlineWidth
      }
      : null;
  })()`);
}

async function clickCenter(window, selector) {
  const point = await evaluate(window, `(() => {
    const scopedSelector = ${JSON.stringify(`[data-realtime-recovery-scenario] ${selector}`)};
    const element = document.querySelector(scopedSelector) ?? document.querySelector(${JSON.stringify(selector)});
    const rect = element?.getBoundingClientRect();
    return rect
      ? { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
      : null;
  })()`);
  if (!point) {
    throw new Error("The renderer scenario could not locate the requested control.");
  }
  window.webContents.sendInputEvent({
    type: "mouseDown",
    x: point.x,
    y: point.y,
    button: "left",
    clickCount: 1
  });
  await wait(10);
  window.webContents.sendInputEvent({
    type: "mouseUp",
    x: point.x,
    y: point.y,
    button: "left",
    clickCount: 1
  });
}

async function prepareScenarioUserData() {
  assertScenarioUserDataPath();

  const mode = (await stat(scenarioUserDataPath)).mode & 0o777;
  if (mode !== 0o700) {
    throw new Error(`Scenario userData must be owner-only; received mode ${mode.toString(8)}.`);
  }
  scenarioUserDataMode = mode;
}

async function runScenario() {
  let resolvedDistRoot;
  let resolvedCanonicalDistRoot;
  try {
    [resolvedDistRoot, resolvedCanonicalDistRoot] = await Promise.all([
      realpath(distRoot),
      realpath(canonicalDistRoot)
    ]);
    await Promise.all([
      stat(join(resolvedDistRoot, "renderer/main.js")),
      stat(join(resolvedDistRoot, "preload/index.cjs"))
    ]);
    distBundleProof = { rendererBundle: true, preloadBundle: true };
  } catch {
    throw new Error("The renderer scenario could not verify the canonical Desktop dist output.");
  }
  canonicalDistProof = resolvedDistRoot === resolvedCanonicalDistRoot;
  if (!canonicalDistProof) {
    throw new Error("The renderer scenario must use the canonical Desktop dist output.");
  }
  await prepareScenarioUserData();
  await app.whenReady();
  if (resolve(app.getPath("userData")) !== scenarioUserDataPath) {
    throw new Error("Electron did not use the isolated renderer scenario userData path.");
  }
  registerScenarioIpc();
  const window = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    minWidth: 860,
    minHeight: 620,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(distRoot, "preload/index.cjs")
    }
  });

  const consoleErrors = [];
  const knownBrowserMessages = ["frame-ancestors' is ignored when delivered via a <meta> element"];
  window.webContents.on("console-message", details => {
    if (details.level === "error"
      && !knownBrowserMessages.some(message => details.message.includes(message))) {
      consoleErrors.push(details.message);
    }
  });
  await window.loadFile(join(distRoot, "renderer/index.html"));
  window.show();
  window.focus();
  await wait(350);
  await evaluate(window, `(() => {
    document.querySelector(".session-menu summary")?.click();
    const input = document.querySelector('input[aria-label="Conversation ID"]');
    if (!(input instanceof HTMLInputElement)) {
      return;
    }
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, "${conversationId}");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  await wait(30);
  await evaluate(window, `(() => {
    const button = [...document.querySelectorAll(".session-popover button")]
      .find(element => element.textContent?.includes("加载"));
    button?.click();
  })()`);
  await wait(100);
  const initial = await evaluate(window, `(() => {
    const root = document.querySelector("#root");
    const requiredLabels = ["助手", "会话", "任务", "审批", "设置", "Typed message", "发送文字", "运行诊断", "生成配对码"];
    const labels = [...document.querySelectorAll("button, input, select, summary")]
      .map(element => element.getAttribute("aria-label") || element.textContent?.trim() || "");
    const requiredActions = [...document.querySelectorAll("button")]
      .filter(element => ["取消任务", "提交答案", "仅批准本次", "拒绝", "已读", "忽略"].some(label => element.textContent?.includes(label)))
      .map(element => ({ text: element.textContent?.trim() ?? "", disabled: element.disabled }));
    return {
      mounted: Boolean(root?.children.length),
      labels,
      requiredLabelsPresent: requiredLabels.every(label => labels.some(value => value.includes(label))),
      requiredActions,
      realProjectionPresent: document.body.textContent?.includes("检查控制面板") === true
        && document.body.textContent?.includes("保存报告到工作区") === true
        && document.body.textContent?.includes("控制面板场景通知") === true,
      persistedConversationPresent: document.querySelector(".workspace-context")?.textContent === "Renderer scenario conversation"
        && document.body.textContent?.includes("控制面板已连接") === true,
      secretFree: !document.body.textContent?.includes("scenario-client-secret"),
      deviceStatus: document.body.textContent?.includes("Desktop 设备在线") === true,
      localAudioAvailable: document.body.textContent?.includes("音频在 Scenario Mac 本机处理") === true,
      wakeState: document.querySelector("[data-wake-state]")?.getAttribute("data-wake-state"),
      bodyWidth: document.body.getBoundingClientRect().width,
      scrollWidth: document.documentElement.scrollWidth
    };
  })()`);

  await evaluate(window, `document.querySelector(".diagnostics-button")?.click()`);
  await wait(120);
  const ipcFailure = await evaluate(window, `(() => {
    const banner = document.querySelector(".error-banner");
    const action = document.querySelector(".diagnostics-button");
    const text = banner?.textContent?.trim() ?? "";
    return {
      retryable: action?.textContent?.includes("重试诊断") === true,
      publicMessage: text,
      secretFree: !text.includes("scenario-client-secret")
        && !text.includes("jarvis.desktop")
        && !text.includes("backend_unavailable")
    };
  })()`);
  const ipcBridgeProbe = await evaluate(window, `window.jarvis.getDiagnostics()
    .then(() => ({ resolved: true }))
    .catch(error => ({
      resolved: false,
      constructor: error?.constructor?.name ?? null,
      name: error?.name ?? null,
      keys: Object.keys(error ?? {}),
      failure: error?.failure ?? null,
      brand: error?.brand ?? null,
      version: error?.version ?? null,
      kind: error?.kind ?? null,
      code: error?.code ?? null,
      message: error?.message ?? null
    }))`);
  await evaluate(window, `document.querySelector(".diagnostics-button")?.click()`);
  await wait(120);
  const ipcRecovery = await evaluate(window, `(() => ({
    recovered: document.querySelector(".diagnostics-panel")?.textContent?.includes("scenario") === true,
    failureAttemptCount: ${diagnosticsAttempts}
  }))()`);
  const initialDeliveryFeedback = await readInitialNotificationDeliveryFeedback(window);
  const expectedInitialDeliveryFeedback = [
    {
      title: "任务需要关注",
      className: "action-feedback is-succeeded",
      text: "通知送达回执：已完成"
    },
    {
      title: "报告已准备",
      className: "action-feedback is-retryable",
      text: "通知送达回执：Backend 暂时不可用，请稍后重试。"
    },
    {
      title: "归档已完成",
      className: "action-feedback is-terminal",
      text: "通知送达回执：目标已不再待处理。"
    }
  ];
  const initialThreeStatesVisible = expectedInitialDeliveryFeedback.every(expected => {
    const actual = initialDeliveryFeedback.find(item => item.title === expected.title);
    return actual?.itemFound === true
      && actual.className === expected.className
      && actual.text === expected.text
      && actual.role === "status"
      && actual.userActionFeedbackPresent === false;
  });

  const keyboardPath = [];
  await evaluate(window, `document.querySelector('input[aria-label="Typed message"]')?.focus()`);
  for (let index = 0; index < 10; index++) {
    keyboardPath.push(await tab(window));
  }

  window.setSize(860, 620);
  await wait(30);
  const windowBounds = window.getBounds();
  const controlSpecJson = JSON.stringify(requiredControlSpecs);
  const inspectControls = async () => evaluate(window, `(() => {
    const specs = ${controlSpecJson};
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const actionScroll = document.querySelector(".action-scroll");
    const allowedDisabled = new Set(["composer-microphone", "composer-send", "composer-stop"]);
    const resolveElement = spec => {
      const candidates = [...document.querySelectorAll(spec.selector)];
      return spec.text
        ? candidates.find(element => element.textContent?.includes(spec.text))
        : candidates[0];
    };
    const rectFor = element => {
      const rect = element?.getBoundingClientRect();
      return rect
        ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height }
        : null;
    };
    const inBounds = rect => Boolean(rect
      && rect.width > 0 && rect.height > 0
      && rect.left >= 0 && rect.right <= viewport.width
      && rect.top >= 0 && rect.bottom <= viewport.height);
    const inContainer = (rect, container) => Boolean(rect && container
      && rect.left >= container.left && rect.right <= container.right
      && rect.top >= container.top && rect.bottom <= container.bottom);
    const controls = specs.map(spec => {
      const sessionMenu = document.querySelector(".session-menu");
      const isSessionControl = spec.id.startsWith("header-session-")
        || spec.id.startsWith("header-conversation-");
      if (isSessionControl && sessionMenu && !sessionMenu.open) {
        sessionMenu.querySelector("summary")?.click();
      } else if (!isSessionControl && sessionMenu?.open) {
        sessionMenu.removeAttribute("open");
      }
      const element = resolveElement(spec);
      const required = spec.required !== false;
      if (!element) {
        return {
          id: spec.id,
          selector: spec.selector,
          required,
          interactive: spec.interactive !== false,
          present: false,
          focusable: false,
          focusVisible: false,
          insideContainer: false,
          inViewport: false,
          noHorizontalOverflow: document.documentElement.scrollWidth <= viewport.width,
          criticalOverlap: false,
          disabled: false,
          disabledAllowed: false,
          text: "",
          label: null
        };
      }

      element.scrollIntoView({ behavior: "auto", block: "start", inline: "nearest" });
      const rect = rectFor(element);
      const actionRect = rectFor(actionScroll);
      const container = spec.container === "action-scroll" ? actionRect : {
        left: 0,
        top: 0,
        right: viewport.width,
        bottom: viewport.height
      };
      const disabled = "disabled" in element && Boolean(element.disabled);
      const interactive = spec.interactive !== false;
      const focusable = interactive && !disabled && element instanceof HTMLElement
        && element.tabIndex >= 0 && !element.hasAttribute("inert");
      if (focusable) {
        element.focus({ preventScroll: true });
      }
      const inViewportValue = inBounds(rect);
      const insideContainerValue = spec.container === "action-scroll"
        ? inContainer(rect, container)
        : inViewportValue;
      const noHorizontalOverflow = Boolean(rect
        && rect.left >= 0 && rect.right <= viewport.width
        && document.documentElement.scrollWidth <= viewport.width);
      const disabledAllowed = !disabled || allowedDisabled.has(spec.id);
      const centerX = rect ? rect.left + rect.width / 2 : 0;
      const centerY = rect ? rect.top + rect.height / 2 : 0;
      const hit = rect && inViewportValue ? document.elementFromPoint(centerX, centerY) : null;
      const hitByControl = Boolean(hit && (hit === element || element.contains(hit) || hit.contains(element)));
      const criticalOverlap = Boolean(rect && inViewportValue && !hitByControl);
      const stateAppropriateDisabled = disabled && disabledAllowed;
      return {
        id: spec.id,
        selector: spec.selector,
        required,
        interactive,
        present: true,
        text: element.textContent?.trim() ?? "",
        label: element.getAttribute("aria-label") || element.getAttribute("aria-labelledby") || null,
        disabled,
        disabledAllowed,
        stateAppropriateDisabled,
        focusable,
        focusVisible: focusable && element.matches(":focus-visible"),
        insideContainer: insideContainerValue,
        inViewport: inViewportValue,
        noHorizontalOverflow,
        criticalOverlap,
        coveredBy: criticalOverlap ? hit?.className?.toString?.() || hit?.tagName || null : null,
        rect,
        container: spec.container
      };
    });
    const eligible = control => control.present
      && control.insideContainer
      && control.inViewport
      && control.noHorizontalOverflow
      && !control.criticalOverlap
      && (!control.interactive
        || (control.disabled ? control.stateAppropriateDisabled : control.focusable && control.focusVisible));
    const requiredControls = controls.filter(control => control.required);
    const optionalVisibleControls = controls.filter(control => !control.required && control.present);
    return {
      viewport,
      documentWidth: document.documentElement.scrollWidth,
      controls,
      controlIds: controls.map(control => control.id),
      requiredControlIds: requiredControls.map(control => control.id),
      missingRequired: requiredControls.filter(control => !eligible(control)).map(control => control.id),
      optionalVisibleFailures: optionalVisibleControls.filter(control => !eligible(control)).map(control => control.id),
      allRequiredControls: requiredControls.every(eligible) && optionalVisibleControls.every(eligible),
      controlsReachable: requiredControls.every(eligible) && optionalVisibleControls.every(eligible)
    };
  })()`);

  const minimumViewport = {
    ...(await inspectControls()),
    windowBounds: JSON.parse(JSON.stringify(windowBounds))
  };

  async function inspectZoom(factor) {
    window.webContents.setZoomFactor(factor);
    await wait(40);
    const result = await inspectControls();
    return { factor, ...result };
  }

  const zoomChecks = [];
  for (const factor of [0.9, 1, 1.1]) {
    zoomChecks.push(await inspectZoom(factor));
  }
  window.webContents.setZoomFactor(1);
  await wait(40);

  const recoveryHarnessBundle = await buildRealtimeRecoveryHarness();
  await evaluate(window, recoveryHarnessBundle);
  await wait(40);
  const realtimePersistenceFailure = await evaluate(window,
    "globalThis.__jarvisRealtimePersistenceRecovery.start()");
  const realtimePersistenceFailureControls = await inspectRealtimeRecoveryControl(
    window,
    "realtime-retry-persistence",
    true);
  await clickCenter(window, '[data-realtime-recovery="realtime-retry-persistence"]');
  await wait(30);
  await evaluate(window, "globalThis.__jarvisRealtimePersistenceRecovery.waitForRetry()");
  await wait(40);
  const realtimePersistenceRecovered = await evaluate(window,
    "globalThis.__jarvisRealtimePersistenceRecovery.snapshot()");
  const realtimePersistenceRecoveredControls = await inspectRealtimeRecoveryControl(
    window,
    "realtime-retry-persistence",
    false);
  const realtimeRecoveryPersistence = {
    failure: realtimePersistenceFailure,
    failureControls: realtimePersistenceFailureControls,
    clicked: true,
    recovered: realtimePersistenceRecovered,
    recoveredControls: realtimePersistenceRecoveredControls,
    failureControlsReachable: realtimePersistenceFailureControls.every(check =>
      check.expectedVisible
      && check.present
      && check.controlIds.length === 1
      && check.controlIds[0] === "realtime-retry-persistence"
      && check.focusable
      && check.keyboardFocused
      && check.focusVisible
      && check.sentinelFocused
      && check.insideContainer
      && check.inViewport
      && check.noHorizontalOverflow
      && !check.criticalOverlap),
    recoveredControlsClear: realtimePersistenceRecoveredControls.every(check =>
      !check.expectedVisible
      && !check.present
      && check.controlIds.length === 0
      && check.noHorizontalOverflow)
  };
  const realtimeWakeFailure = await evaluate(window,
    "globalThis.__jarvisRealtimePersistenceRecovery.startWakeFailure()");
  const realtimeWakeFailureControls = await inspectRealtimeRecoveryControl(
    window,
    "realtime-retry-wake",
    true);
  await clickCenter(window, '[data-realtime-recovery="realtime-retry-wake"]');
  await wait(30);
  await evaluate(window, "globalThis.__jarvisRealtimePersistenceRecovery.waitForWakeRetry()");
  await wait(40);
  const realtimeWakeRecovered = await evaluate(window,
    "globalThis.__jarvisRealtimePersistenceRecovery.wakeSnapshot()");
  const realtimeWakeRecoveredControls = await inspectRealtimeRecoveryControl(
    window,
    "realtime-retry-wake",
    false);
  const realtimeRecoveryWake = {
    failure: realtimeWakeFailure,
    failureControls: realtimeWakeFailureControls,
    clicked: true,
    recovered: realtimeWakeRecovered,
    recoveredControls: realtimeWakeRecoveredControls,
    failureControlsReachable: realtimeWakeFailureControls.every(check =>
      check.expectedVisible
      && check.present
      && check.controlIds.length === 1
      && check.controlIds[0] === "realtime-retry-wake"
      && check.focusable
      && check.keyboardFocused
      && check.focusVisible
      && check.sentinelFocused
      && check.insideContainer
      && check.inViewport
      && check.noHorizontalOverflow
      && !check.criticalOverlap),
    recoveredControlsClear: realtimeWakeRecoveredControls.every(check =>
      !check.expectedVisible
      && !check.present
      && check.controlIds.length === 0
      && check.noHorizontalOverflow)
  };
  const realtimeTransportFailure = await evaluate(window,
    "globalThis.__jarvisRealtimePersistenceRecovery.startTransportFailure()");
  const realtimeTransportPersistenceControls = await inspectRealtimeRecoveryControl(
    window,
    "realtime-retry-persistence",
    false);
  const realtimeTransportWakeControls = await inspectRealtimeRecoveryControl(
    window,
    "realtime-retry-wake",
    false);
  const realtimeTransportFailureControls = await inspectRealtimeConnectionControl(window);
  const realtimeTransportRecoveryControls = await evaluate(window,
    "[...document.querySelectorAll('[data-realtime-recovery]')].map(element => element.getAttribute('data-realtime-recovery'))");
  await clickCenter(window, '[data-realtime-connection="connect"]');
  await wait(120);
  const realtimeTransportAfterClick = await evaluate(window,
    "globalThis.__jarvisRealtimePersistenceRecovery.transportSnapshot()");
  const realtimeRecoveryTransport = {
    failure: realtimeTransportFailure,
    recoveryControls: realtimeTransportRecoveryControls,
    persistenceControls: realtimeTransportPersistenceControls,
    wakeControls: realtimeTransportWakeControls,
    failureControls: realtimeTransportFailureControls,
    clicked: true,
    afterClick: realtimeTransportAfterClick,
    failureControlsReachable: realtimeTransportFailureControls.every(check =>
      check.expectedVisible
      && check.present
      && check.controlIds.length === 1
      && check.controlIds[0] === "connect"
      && check.focusable
      && check.keyboardFocused
      && check.focusVisible
      && check.sentinelFocused
      && check.insideContainer
      && check.inViewport
      && check.noHorizontalOverflow
      && !check.criticalOverlap),
    reconnectProjection: realtimeTransportFailureControls.every(check =>
      check.label === "需要处理" && check.disabled === false)
  };
  await evaluate(window, "globalThis.__jarvisRealtimePersistenceRecovery.dispose()");
  window.webContents.setZoomFactor(1);
  await wait(40);

  const interactionProof = {
    connection: await evaluate(window, `(() => {
      const element = document.querySelector(".connection-button");
      return element instanceof HTMLButtonElement
        ? { label: element.textContent?.trim() ?? "", disabled: element.disabled, state: element.className }
        : { label: "", disabled: true, state: "missing" };
    })()`),
    voice: await evaluate(window, `(() => {
      const element = document.querySelector(".voice-presence");
      return element instanceof HTMLButtonElement
        ? { label: element.getAttribute("aria-label"), wakeState: element.getAttribute("data-wake-state"), focusable: element.tabIndex >= 0 }
        : { label: null, wakeState: null, focusable: false };
    })()`),
    composer: await evaluate(window, `(() => {
      const input = document.querySelector('.composer input[aria-label="Typed message"]');
      const microphone = document.querySelector(".composer-mic");
      const send = document.querySelector(".composer-send");
      return {
        inputFocusable: input instanceof HTMLInputElement && !input.disabled && input.tabIndex >= 0,
        microphoneDisabled: microphone instanceof HTMLButtonElement && microphone.disabled,
        sendDisabled: send instanceof HTMLButtonElement && send.disabled
      };
    })()`),
    realtimeRecovery: {
      persistence: realtimeRecoveryPersistence,
      wake: realtimeRecoveryWake,
      transport: realtimeRecoveryTransport
    }
  };
  interactionProof.realtimeRetry = await evaluate(window, `(() => {
    const retryButtons = [...document.querySelectorAll(".header-actions .quiet-button")]
      .map(element => element.textContent?.trim() ?? "");
    return {
      persistenceVisible: retryButtons.some(text => text.includes("重试保存")),
      wakeVisible: retryButtons.some(text => text.includes("重试唤醒")),
      healthyProjection: retryButtons.length === 0
    };
  })()`);

  let pendingDeliveryFeedback;
  let recoveredDeliveryFeedback;
  let readFailureCoexists;
  let readRetry;

  await evaluate(window, `(() => {
    const select = document.querySelector(".task-input-form select");
    if (!(select instanceof HTMLSelectElement)) {
      return;
    }
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
    setter?.call(select, "Markdown");
    select.dispatchEvent(new Event("change", { bubbles: true }));
  })()`);
  await wait(35);
  armNotificationDeliveryDeferred();
  await evaluate(window, `document.querySelector(".task-input-form button[type=submit]")?.click()`);
  await waitForNotificationDeliveryDeferred();
  await wait(16);
  pendingDeliveryFeedback = await waitForNotificationDeliveryFeedback(
    window,
    "报告已准备",
    "action-feedback is-pending",
    "通知送达回执：处理中…");
  notificationDeliveryOutcomes.set(notificationIdTwo, "succeeded");
  notificationActions.push({ action: "delivered", notificationId: notificationIdTwo });
  if (!notificationDeliveryDeferredResolve) {
    throw new Error("The renderer scenario did not expose a deferred notification resolver.");
  }
  notificationDeliveryDeferredResolve();
  recoveredDeliveryFeedback = await waitForNotificationDeliveryFeedback(
    window,
    "报告已准备",
    "action-feedback is-succeeded",
    "通知送达回执：已完成");
  await wait(120);
  await evaluate(window, `(() => {
    const select = document.querySelector(".task-input-form select");
    if (!(select instanceof HTMLSelectElement)) {
      return;
    }
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
    setter?.call(select, "PDF");
    select.dispatchEvent(new Event("input", { bubbles: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
  })()`);
  await wait(35);
  await evaluate(window, `document.querySelector(".task-input-form button[type=submit]")?.click()`);
  await wait(120);
  interactionProof.taskInput = {
    reconciled: taskStatusRequests.includes(inputTaskId),
    submitted: taskInputSubmissions.length === 2
      && taskInputSubmissions.every(submission => submission.taskId === inputTaskId)
      && taskInputSubmissions.map(submission => submission.answers?.format?.answers?.[0]).join(",") === "Markdown,PDF",
    submissionCount: taskInputSubmissions.length,
    answers: taskInputSubmissions.map(submission => submission.answers?.format?.answers?.[0] ?? null),
    idempotencyKeys: taskInputSubmissions.map(submission => submission.idempotencyKey ?? null),
    distinctIdempotencyKeys: new Set(taskInputSubmissions.map(submission => submission.idempotencyKey)).size === 2
  };

  await evaluate(window, `document.querySelector(".task-list .task-item:first-child .text-action")?.click()`);
  await wait(120);
  interactionProof.cancel = {
    submitted: cancelledTasks.includes(taskId),
    taskIds: [...cancelledTasks]
  };

  await evaluate(window, `document.querySelector(".approval-list .approval-item:first-child .approve-button")?.click()`);
  await wait(120);
  await evaluate(window, `(() => {
    const item = [...document.querySelectorAll(".approval-item")]
      .find(element => element.textContent?.includes("执行报告整理命令"));
    [...(item?.querySelectorAll("button") ?? [])]
      .find(element => element.textContent?.includes("拒绝"))
      ?.click();
  })()`);
  await wait(120);
  interactionProof.approvals = {
    isolated: approvalDecisions.length === 2
      && approvalDecisions[0].approvalId === approvalId
      && approvalDecisions[0].decision === "approve"
      && approvalDecisions[1].approvalId === approvalIdTwo
      && approvalDecisions[1].decision === "deny",
    decisions: [...approvalDecisions]
  };

  await evaluate(window, `document.querySelector(".notification-toast .toast-actions button:nth-of-type(1)")?.click()`);
  await wait(120);
  await evaluate(window, `(() => {
    const item = [...document.querySelectorAll(".notification-item")]
      .find(element => element.textContent?.includes("报告已准备"));
    [...(item?.querySelectorAll("button") ?? [])]
      .find(element => element.textContent?.includes("已读"))
      ?.click();
  })()`);
  readFailureCoexists = await waitForNotificationReadFeedback(window, "报告已准备");
  await evaluate(window, `(() => {
    const item = [...document.querySelectorAll(".notification-item")]
      .find(element => element.querySelector("strong")?.textContent?.trim() === "报告已准备");
    [...(item?.querySelectorAll("button") ?? [])]
      .find(element => element.textContent?.trim() === "重试已读")
      ?.click();
  })()`);
  const readRemoved = await waitForNotificationRemoved(window, "报告已准备");
  const readAttempts = notificationReadAttempts.filter(item => item.notificationId === notificationIdTwo);
  const readKeys = readAttempts.map(item => item.idempotencyKey);
  const readUniqueKeys = [...new Set(readKeys.filter(key => typeof key === "string" && key.length > 0))];
  readRetry = {
    ...readRemoved,
    attempts: [...readAttempts],
    attemptCount: readAttempts.length,
    idempotencyKeys: readKeys,
    nonEmptyIdempotencyKeys: readKeys.length > 0
      && readKeys.every(key => typeof key === "string" && key.length > 0),
    sameIdempotencyKey: readUniqueKeys.length === 1
      && readKeys.length === readAttempts.length,
    successfulActionCount: notificationActions.filter(item =>
      item.action === "read" && item.notificationId === notificationIdTwo).length
  };
  await evaluate(window, `(() => {
    const item = [...document.querySelectorAll(".notification-item")]
      .find(element => element.textContent?.includes("归档已完成"));
    [...(item?.querySelectorAll("button") ?? [])]
      .find(element => element.textContent?.includes("忽略"))
      ?.click();
  })()`);
  await wait(120);
  interactionProof.notifications = {
    delivered: notificationActions.some(item => item.action === "delivered" && item.notificationId === notificationId)
      && notificationActions.some(item => item.action === "delivered" && item.notificationId === notificationIdTwo)
      && !notificationActions.some(item => item.action === "delivered" && item.notificationId === notificationIdThree),
    deliveryAttempts: [...notificationDeliveryAttempts],
    deliveryFeedback: {
      initial: initialDeliveryFeedback,
      initialThreeStatesVisible,
      pending: pendingDeliveryFeedback,
      recovered: recoveredDeliveryFeedback,
      readFailureCoexists,
      readRetry,
      keys: notificationDeliveryAttempts
        .filter(item => item.notificationId === notificationIdTwo)
        .map(item => item.idempotencyKey),
      keyProof: (() => {
        const attempts = notificationDeliveryAttempts
          .filter(item => item.notificationId === notificationIdTwo);
        const keys = attempts.map(item => item.idempotencyKey);
        const uniqueKeys = [...new Set(keys.filter(key => typeof key === "string" && key.length > 0))];
        return {
          nonEmpty: keys.length > 0 && keys.every(key => typeof key === "string" && key.length > 0),
          uniqueKeys,
          sameIdempotencyKey: uniqueKeys.length === 1 && keys.length === attempts.length,
          containsRetryable: attempts.some(item => item.outcome === "retryable"),
          containsDeferred: attempts.some(item => item.outcome === "deferred")
        };
      })()
    },
    acknowledged: notificationActions.some(item => item.action === "acknowledge" && item.notificationId === notificationId),
    read: notificationActions.some(item => item.action === "read" && item.notificationId === notificationIdTwo),
    dismissed: notificationActions.some(item => item.action === "dismiss" && item.notificationId === notificationIdThree),
    actions: [...notificationActions]
  };

  await evaluate(window, `document.querySelector(".pairing-section > button")?.click()`);
  await wait(120);
  const pairingState = await evaluate(window, `({
    codeVisible: document.body.textContent?.includes("scenario-pairing-code") === true,
    buttonText: document.querySelector(".pairing-section > button")?.textContent?.trim() ?? ""
  })`);
  interactionProof.pairing = {
    submitted: pairingRequests.length === 1,
    codeVisible: pairingState.codeVisible,
    buttonText: pairingState.buttonText,
    requestCount: pairingRequests.length
  };

  const navigationProof = [];
  for (const [label, id] of [
    ["助手", "assistant-panel"],
    ["会话", "conversation-panel"],
    ["任务", "task-panel"],
    ["审批", "approval-panel"],
    ["设置", "system-panel"]
  ]) {
    await evaluate(window, `document.querySelector('button.nav-item[aria-label="${label}"]')?.click()`);
    await wait(35);
    navigationProof.push(await evaluate(window, `(() => {
      const target = document.getElementById("${id}");
      const rect = target?.getBoundingClientRect();
      const scroller = target?.closest(".action-scroll, .conversation-scroll");
      const bounds = scroller?.getBoundingClientRect();
      const positiveSize = Boolean(rect && rect.width > 0 && rect.height > 0);
      const horizontalStart = Math.max(0, bounds?.left ?? 0);
      const horizontalEnd = Math.min(window.innerWidth, bounds?.right ?? window.innerWidth);
      const horizontalVisible = Boolean(rect
        && rect.left >= horizontalStart
        && rect.right <= horizontalEnd);
      const targetStartVisible = Boolean(rect && (bounds
        ? rect.top >= bounds.top && rect.top <= bounds.bottom
        : rect.bottom > 0 && rect.top < window.innerHeight));
      const visible = positiveSize && horizontalVisible && targetStartVisible;
      return {
        label: "${label}",
        target: "${id}",
        visible,
        positiveSize,
        horizontalVisible,
        targetStartVisible,
        targetRect: rect ? {
          left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
          width: rect.width, height: rect.height
        } : null,
        scroller: bounds ? {
          left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom,
          width: bounds.width, height: bounds.height
        } : null,
        scrollTop: scroller?.scrollTop ?? null,
        scrollBehavior: getComputedStyle(document.documentElement).scrollBehavior
      };
    })()`));
  }
  interactionProof.navigation = navigationProof;

  await evaluate(window, `document.querySelector('button[aria-label="任务"]')?.click()`);
  await wait(40);
  const reducedNavigation = await evaluate(window, `(() => {
    const scroller = document.querySelector(".action-scroll");
    const target = document.querySelector("#task-panel");
    const scrollerRect = scroller?.getBoundingClientRect();
    const targetRect = target?.getBoundingClientRect();
    return {
      triggered: Boolean(target),
      scrollTop: scroller?.scrollTop ?? null,
      targetVisible: Boolean(scrollerRect && targetRect
        && targetRect.top >= scrollerRect.top
        && targetRect.top < scrollerRect.bottom)
    };
  })()`);

  const reducedMotion = await evaluate(window, `(() => {
    const waveform = document.querySelector(".waveform");
    const conversation = document.querySelector(".conversation-scroll");
    return {
      matches: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      waveformAnimation: waveform ? getComputedStyle(waveform).animationName : null,
      conversationScrollBehavior: conversation ? getComputedStyle(conversation).scrollBehavior : null,
      actionScrollBehavior: document.querySelector(".action-scroll")
        ? getComputedStyle(document.querySelector(".action-scroll")).scrollBehavior
        : null
    };
  })()`);

  const ownedAppPids = app.getAppMetrics()
    .map(metric => metric.pid)
    .filter(pid => Number.isInteger(pid) && pid > 0);

  const observation = {
    initial,
    ipcFailure,
    ipcBridgeProbe,
    ipcRecovery,
    dist: {
      canonical: canonicalDistProof,
      identity: "src/clients/desktop/dist",
      ...distBundleProof
    },
    keyboardPath,
    minimumViewport,
    zoomChecks,
    interactionProof,
    reducedNavigation,
    reducedMotion,
    userData: {
      mode: scenarioUserDataMode,
      ownerOnly: scenarioUserDataMode === 0o700,
      isolated: typeof scenarioUserDataPath === "string"
        && basename(scenarioUserDataPath).startsWith(scenarioUserDataPrefix)
        && dirname(scenarioUserDataPath) === resolve(tmpdir())
    },
    process: {
      ownedPids: ownedAppPids
    },
    consoleErrors
  };
  if (!initial.mounted || !initial.requiredLabelsPresent || !initial.realProjectionPresent
    || !initial.persistedConversationPresent
    || !initial.secretFree
    || !initial.deviceStatus
    || !initial.localAudioAvailable
    || initial.wakeState !== "standby"
    || !ipcFailure.retryable
    || ipcFailure.publicMessage !== "Backend 暂时不可用，请稍后重试。"
    || !ipcFailure.secretFree
    || !ipcRecovery.recovered
    || ipcRecovery.failureAttemptCount !== 3
    || !["connected", "degraded"].includes(realtimeRecoveryPersistence.failure.status)
    || realtimeRecoveryPersistence.failure.persistenceRetryReason !== "event-ingest"
    || realtimeRecoveryPersistence.failure.ingestCalls !== 1
    || realtimeRecoveryPersistence.failure.retryCalls !== 0
    || realtimeRecoveryPersistence.recovered.persistenceRetryReason != null
    || realtimeRecoveryPersistence.recovered.ingestCalls !== 2
    || realtimeRecoveryPersistence.recovered.retryCalls !== 1
    || realtimeRecoveryPersistence.recovered.retryAction?.status !== "succeeded"
    || !realtimeRecoveryPersistence.failureControlsReachable
    || !realtimeRecoveryPersistence.recoveredControlsClear
    || realtimeRecoveryWake.failure.status !== "connected"
    || realtimeRecoveryWake.failure.wakeState !== "error"
    || realtimeRecoveryWake.failure.trackEnabled
    || !realtimeRecoveryWake.failure.transportCreated
    || realtimeRecoveryWake.failure.startCalls !== 1
    || realtimeRecoveryWake.failure.retryCalls !== 0
    || realtimeRecoveryWake.recovered.wakeState !== "standby"
    || realtimeRecoveryWake.recovered.trackEnabled
    || realtimeRecoveryWake.recovered.startCalls !== 2
    || realtimeRecoveryWake.recovered.retryCalls !== 1
    || realtimeRecoveryWake.recovered.retryAction?.status !== "succeeded"
    || !realtimeRecoveryWake.failureControlsReachable
    || !realtimeRecoveryWake.recoveredControlsClear
    || realtimeRecoveryTransport.failure.status !== "degraded"
    || realtimeRecoveryTransport.failure.persistenceRetryReason != null
    || realtimeRecoveryTransport.failure.wakeState !== "standby"
    || realtimeRecoveryTransport.failure.trackEnabled
    || !realtimeRecoveryTransport.failure.transportCreated
    || realtimeRecoveryTransport.failure.markEndedCalls !== 1
    || realtimeRecoveryTransport.recoveryControls.length !== 0
    || realtimeRecoveryTransport.persistenceControls.some(check =>
      check.expectedVisible || check.present || check.controlIds.length !== 0 || !check.noHorizontalOverflow)
    || realtimeRecoveryTransport.wakeControls.some(check =>
      check.expectedVisible || check.present || check.controlIds.length !== 0 || !check.noHorizontalOverflow)
    || !realtimeRecoveryTransport.failureControlsReachable
    || !realtimeRecoveryTransport.reconnectProjection
    || realtimeRecoveryTransport.afterClick.connectCalls !== 1
    || keyboardPath.some(path => !path || !path.focusVisible || path.outlineStyle === "none" || path.outlineWidth === "0px")
    || !interactionProof.connection.label.includes("连接")
    || interactionProof.connection.disabled
    || !interactionProof.voice.focusable
    || interactionProof.voice.wakeState !== "standby"
    || !interactionProof.composer.inputFocusable
    || !interactionProof.composer.microphoneDisabled
    || !interactionProof.composer.sendDisabled
    || !interactionProof.realtimeRetry.healthyProjection
    || !interactionProof.taskInput.reconciled
    || !interactionProof.taskInput.submitted
    || !interactionProof.taskInput.distinctIdempotencyKeys
    || !interactionProof.cancel.submitted
    || !interactionProof.approvals.isolated
    || !interactionProof.notifications.delivered
    || !interactionProof.notifications.acknowledged
    || !interactionProof.notifications.read
    || !interactionProof.notifications.dismissed
    || !interactionProof.notifications.deliveryFeedback?.initialThreeStatesVisible
    || !interactionProof.notifications.deliveryFeedback?.pending?.itemFound
    || interactionProof.notifications.deliveryFeedback?.pending?.className !== "action-feedback is-pending"
    || interactionProof.notifications.deliveryFeedback?.pending?.text !== "通知送达回执：处理中…"
    || interactionProof.notifications.deliveryFeedback?.pending?.userActionFeedbackPresent
    || !interactionProof.notifications.deliveryFeedback?.recovered?.itemFound
    || interactionProof.notifications.deliveryFeedback?.recovered?.className !== "action-feedback is-succeeded"
    || interactionProof.notifications.deliveryFeedback?.recovered?.text !== "通知送达回执：已完成"
    || interactionProof.notifications.deliveryFeedback?.recovered?.userActionFeedbackPresent
    || !interactionProof.notifications.deliveryFeedback?.keyProof?.nonEmpty
    || !interactionProof.notifications.deliveryFeedback?.keyProof?.sameIdempotencyKey
    || !interactionProof.notifications.deliveryFeedback?.keyProof?.containsRetryable
    || !interactionProof.notifications.deliveryFeedback?.keyProof?.containsDeferred
    || !interactionProof.notifications.deliveryFeedback?.readFailureCoexists?.itemFound
    || interactionProof.notifications.deliveryFeedback?.readFailureCoexists?.deliveryClassName !== "action-feedback is-succeeded"
    || interactionProof.notifications.deliveryFeedback?.readFailureCoexists?.deliveryText !== "通知送达回执：已完成"
    || interactionProof.notifications.deliveryFeedback?.readFailureCoexists?.actionClassName !== "action-feedback is-retryable"
    || interactionProof.notifications.deliveryFeedback?.readFailureCoexists?.actionText !== "通知已读：Backend 暂时不可用，请稍后重试。"
    || interactionProof.notifications.deliveryFeedback?.readFailureCoexists?.readButtonText !== "重试已读"
    || interactionProof.notifications.deliveryFeedback?.readFailureCoexists?.readButtonDisabled
    || interactionProof.notifications.deliveryFeedback?.readRetry?.itemFound
    || interactionProof.notifications.deliveryFeedback?.readRetry?.attemptCount !== 2
    || !interactionProof.notifications.deliveryFeedback?.readRetry?.sameIdempotencyKey
    || interactionProof.notifications.deliveryFeedback?.readRetry?.successfulActionCount !== 1
    || !interactionProof.pairing.submitted
    || !interactionProof.pairing.codeVisible
    || interactionProof.navigation.some(item => !item.visible)
    || !minimumViewport.controlsReachable
    || minimumViewport.allRequiredControls !== true
    || minimumViewport.documentWidth > minimumViewport.viewport.width
    || zoomChecks.some(check => !check.controlsReachable
      || check.documentWidth > check.viewport.width
      || check.allRequiredControls !== true)
    || !reducedNavigation.triggered
    || !reducedNavigation.targetVisible
    || !reducedMotion.matches
    || reducedMotion.waveformAnimation !== "none"
    || reducedMotion.conversationScrollBehavior !== "auto"
    || reducedMotion.actionScrollBehavior !== "auto"
    || !observation.userData.ownerOnly
    || !observation.userData.isolated
    || consoleErrors.length > 0) {
    throw new Error(`Desktop renderer scenario failed: ${JSON.stringify(observation)}`);
  }

  if (scenarioOutput) {
    await mkdir(dirname(scenarioOutput), { recursive: true });
    await writeFile(scenarioOutput, `${JSON.stringify(observation, null, 2)}\n`, "utf8");
  }
  console.log(JSON.stringify(observation, null, 2));
}

let finished = false;
let cleanupPromise;

async function cleanup() {
  if (cleanupPromise) {
    return cleanupPromise;
  }
  cleanupPromise = (async () => {
    for (const channel of registeredChannels) {
      ipcMain.removeHandler(channel);
    }
    registeredChannels.clear();
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.destroy();
      }
    }
  })();
  return cleanupPromise;
}

async function finish(exitCode) {
  if (finished) {
    return;
  }
  finished = true;
  clearTimeout(watchdog);
  try {
    await cleanup();
    process.exitCode = exitCode;
    if (app.isReady()) {
      app.quit();
    } else {
      process.exit(exitCode);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
    process.exit(1);
  }
}

const watchdog = setTimeout(() => {
  if (finished) {
    return;
  }
  console.error("Desktop renderer scenario timed out after 25 seconds.");
  void finish(124);
}, 25_000);

runScenario()
  .then(() => finish(0))
  .catch(error => {
    if (finished) {
      return;
    }
    console.error(error instanceof Error ? error.message : error);
    void finish(1);
  });
