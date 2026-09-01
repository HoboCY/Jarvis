import { useEffect, useRef, useState } from "react";
import { decodeSignalREventEnvelope } from "@jarvis/contracts-ts";
import { ensureConversation } from "./conversation-flow.js";
import { canSendRealtimeText, RealtimeConnectGate } from "./realtime-connect-flow.js";
import {
  DesktopRealtimeController,
  mapRealtimeCancelResponse,
  mapRealtimeTaskStatusResponse,
  type DesktopRealtimeStatus,
  type DesktopRealtimeWakeState
} from "./realtime.js";
import { builtInWakeWord, createSherpaWakeWordDetector } from "./wake-word.js";
import {
  DesktopTaskNotificationFeed,
  ensureActiveDesktopTaskNotificationFeed,
  refreshFeedIfCurrent,
  refreshOnBackendConnectionState,
  type DesktopNotification,
  type DesktopTask,
  desktopTaskFrom,
  notificationActionsFrom
} from "./task-feed.js";
import {
  DesktopApprovalFeed,
  type DesktopApproval
} from "./approval-feed.js";
import { parseDiagnostics, type DesktopDiagnostics } from "./diagnostics.js";
import { buildDesktopMobilePairingInput, mobilePairingFrom, type MobilePairing } from "./mobile-pairing.js";
import {
  applyBackendConnectionState,
  initialBackendConnectionState
} from "./backend-connection-state.js";

type Message = {
  id: string;
  role: string;
  text: string | null;
  status: string;
  inputModality?: string | null;
  outputModality?: string | null;
};

type Conversation = {
  id: string;
  title: string;
  messages: Message[];
  messageCount: number;
};

type ClientSecret = {
  realtimeSessionId: string;
  clientSecret: string;
  webRtcUrl: string;
  model: string;
  voice: string;
  instructions: string;
  wakeWord: {
    enabled: boolean;
    keyword: typeof builtInWakeWord;
  };
};

type Device = { deviceId: string; name: string; platform: string };

function taskFrom(value: unknown): DesktopTask {
  const task = desktopTaskFrom(value);
  if (!task) {
    throw new Error("Backend returned an invalid task.");
  }

  return task;
}

function TaskUserInputForm({
  task,
  onSubmitted,
  onError
}: {
  task: DesktopTask;
  onSubmitted: () => Promise<void>;
  onError: (error: unknown) => void;
}) {
  const pending = task.pendingUserInput;
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  if (!pending) {
    return null;
  }

  const submit = async (): Promise<void> => {
    if (pending.questions.some(question => !(answers[question.id] ?? "").trim())) {
      onError(new Error("请回答所有问题。"));
      return;
    }

    setSubmitting(true);
    try {
      const fixedAnswers: Record<string, { answers: string[] }> = {};
      for (const question of pending.questions) {
        fixedAnswers[question.id] = { answers: [answers[question.id]!.trim()] };
      }
      await window.jarvis.submitTaskUserInput({
        taskId: task.id,
        requestId: pending.requestId,
        executionId: task.executionId,
        requestIdIsString: pending.requestIdIsString,
        answers: fixedAnswers,
        idempotencyKey: crypto.randomUUID()
      });
      await onSubmitted();
    } catch (error) {
      onError(error);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={event => {
      event.preventDefault();
      void submit();
    }}>
      <fieldset disabled={submitting}>
        <legend>需要你的输入</legend>
        {pending.questions.map(question => (
          <div key={question.id}>
            <label htmlFor={`task-${task.id}-${question.id}`}>{question.header}</label>
            <p>{question.question}</p>
            {question.options && question.options.length > 0 && !question.isOther ? (
              <select
                id={`task-${task.id}-${question.id}`}
                value={answers[question.id] ?? ""}
                onChange={event => setAnswers(current => ({ ...current, [question.id]: event.target.value }))}
              >
                <option value="">请选择</option>
                {question.options.map(option => (
                  <option key={option.label} value={option.label}>{option.label} — {option.description}</option>
                ))}
              </select>
            ) : (
              <>
                {question.options && question.options.length > 0 ? (
                  <ul>
                    {question.options.map(option => <li key={option.label}>{option.label}: {option.description}</li>)}
                  </ul>
                ) : null}
                <input
                  id={`task-${task.id}-${question.id}`}
                  value={answers[question.id] ?? ""}
                  onChange={event => setAnswers(current => ({ ...current, [question.id]: event.target.value }))}
                  maxLength={4_000}
                  placeholder="请输入答案"
                />
              </>
            )}
          </div>
        ))}
        <button type="submit">{submitting ? "提交中…" : "提交答案"}</button>
      </fieldset>
    </form>
  );
}

function notificationFrom(value: unknown): DesktopNotification {
  const item = asRecord(value);
  return {
    ...item,
    id: String(item.id),
    status: String(item.status),
    title: String(item.title),
    body: String(item.body),
    actions: notificationActionsFrom(item.actionsJson)
  };
}

function approvalFrom(value: unknown): DesktopApproval {
  const item = asRecord(value);
  const kind = String(item.kind);
  const status = String(item.status);
  if (!["command", "fileWrite", "permission", "externalWrite"].includes(kind)
    || !["pending", "approved", "denied", "expired", "cancelled"].includes(status)) {
    throw new Error("Backend returned an invalid approval.");
  }
  return {
    id: String(item.id),
    taskId: String(item.taskId),
    executionId: item.executionId === null || item.executionId === undefined ? null : String(item.executionId),
    deviceId: String(item.deviceId),
    kind: kind as DesktopApproval["kind"],
    reason: String(item.reason),
    status: status as DesktopApproval["status"],
    scope: item.scope === "once" || item.scope === "taskSession" ? item.scope : null,
    expiresAtMs: typeof item.expiresAtMs === "number" ? item.expiresAtMs : null
  };
}

function listItems(value: unknown): unknown[] {
  const item = asRecord(value);
  return Array.isArray(item.items) ? item.items : [];
}

function createTaskFeed(): DesktopTaskNotificationFeed {
  return new DesktopTaskNotificationFeed({
    getTasks: async (conversationId, cursor, status) => {
      const page = asRecord(await window.jarvis.getTasks({ conversationId, cursor, status }));
      const nextCursor = page.nextCursor;
      if (nextCursor !== undefined && nextCursor !== null && typeof nextCursor !== "string") {
        throw new Error("Backend returned an invalid task cursor.");
      }
      return {
        items: listItems(page).map(taskFrom),
        nextCursor: typeof nextCursor === "string" ? nextCursor : null
      };
    },
    getUnreadNotifications: async () =>
      listItems(await window.jarvis.getNotifications()).map(notificationFrom),
    markDelivered: (notificationId, idempotencyKey) => window.jarvis.markNotificationDelivered({
      notificationId,
      idempotencyKey
    }),
    markRead: (notificationId, idempotencyKey) => window.jarvis.markNotificationRead({
      notificationId,
      idempotencyKey
    }),
    dismiss: (notificationId, idempotencyKey) => window.jarvis.dismissNotification({
      notificationId,
      idempotencyKey
    }),
    applyAction: (notificationId, actionId, idempotencyKey) => window.jarvis.applyNotificationAction({
      notificationId,
      actionId,
      idempotencyKey
    })
  });
}

function createApprovalFeed(): DesktopApprovalFeed {
  return new DesktopApprovalFeed({
    getPendingApprovals: async () =>
      listItems(await window.jarvis.getApprovals()).map(approvalFrom),
    decideApproval: async input => approvalFrom(await window.jarvis.decideApproval(input))
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Backend returned an invalid response.");
  }
  return value as Record<string, unknown>;
}

function conversationFrom(value: unknown): Conversation {
  const item = asRecord(value);
  return {
    id: String(item.id),
    title: String(item.title),
    messages: Array.isArray(item.messages) ? item.messages.map(messageFrom) : [],
    messageCount: Number(item.messageCount ?? 0)
  };
}

function messageFrom(value: unknown): Message {
  const item = asRecord(value);
  return {
    id: String(item.id),
    role: String(item.role),
    text: typeof item.text === "string" ? item.text : null,
    status: String(item.status),
    inputModality: typeof item.inputModality === "string" ? item.inputModality : null,
    outputModality: typeof item.outputModality === "string" ? item.outputModality : null
  };
}

function clientSecretFrom(value: unknown): ClientSecret {
  const item = asRecord(value);
  if (typeof item.clientSecret !== "string"
    || typeof item.realtimeSessionId !== "string"
    || typeof item.webRtcUrl !== "string"
    || typeof item.instructions !== "string"
    || !item.instructions.trim()) {
    throw new Error("Backend returned an invalid ephemeral realtime secret.");
  }
  if (typeof item.wakeWord !== "object" || item.wakeWord === null || Array.isArray(item.wakeWord)) {
    throw new Error("本地中文唤醒词未配置，请检查 WakeWord 设置。");
  }
  const wakeWord = item.wakeWord as Record<string, unknown>;
  if (wakeWord.enabled !== true
    || wakeWord.keyword !== builtInWakeWord) {
    throw new Error("本地中文唤醒词未配置，请检查 WakeWord 设置。");
  }
  const webRtcUrl = new URL(item.webRtcUrl);
  if (webRtcUrl.protocol !== "https:") {
    throw new Error("Backend returned an invalid Realtime WebRTC URL.");
  }
  return {
    realtimeSessionId: item.realtimeSessionId,
    clientSecret: item.clientSecret,
    webRtcUrl: webRtcUrl.toString(),
    model: String(item.model),
    voice: String(item.voice),
    instructions: item.instructions,
    wakeWord: {
      enabled: true,
      keyword: builtInWakeWord
    }
  };
}

async function requestApplicationAudioStream(): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("当前环境不支持麦克风，请使用已打包的桌面应用。");
  }
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (error) {
    const detail = error instanceof Error ? ` ${error.message}` : "";
    throw new Error(`无法访问麦克风；请在系统设置中授予 Jarvis 麦克风权限后重试。${detail}`);
  }
}

function playWakeTone(): void {
  try {
    if (typeof AudioContext === "undefined") {
      return;
    }
    const context = new AudioContext();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.frequency.value = 880;
    gain.gain.setValueAtTime(0.03, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.08);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.08);
    oscillator.addEventListener("ended", () => void context.close());
  } catch {
    // A prompt tone is best effort; it must not affect the realtime turn.
  }
}

function deviceFrom(value: unknown): Device {
  const item = asRecord(value);
  return { deviceId: String(item.deviceId), name: String(item.name), platform: String(item.platform) };
}

export function App() {
  const [version, setVersion] = useState("loading");
  const [conversation, setConversation] = useState<Conversation | undefined>();
  const [device, setDevice] = useState<Device | undefined>();
  const [status, setStatus] = useState<DesktopRealtimeStatus>("disconnected");
  const [error, setError] = useState<string | undefined>();
  const [draft, setDraft] = useState("");
  const [muted, setMuted] = useState(true);
  const [wakeState, setWakeState] = useState<DesktopRealtimeWakeState>("standby");
  const [conversationIdInput, setConversationIdInput] = useState("");
  const [tasks, setTasks] = useState<readonly DesktopTask[]>([]);
  const [notifications, setNotifications] = useState<readonly DesktopNotification[]>([]);
  const [approvals, setApprovals] = useState<readonly DesktopApproval[]>([]);
  const [resolvingApprovalId, setResolvingApprovalId] = useState<string | undefined>();
  const [backendConnectionState, setBackendConnectionState] = useState("connecting");
  const backendConnection = useRef(initialBackendConnectionState);
  const [diagnostics, setDiagnostics] = useState<DesktopDiagnostics | undefined>();
  const [mobilePairing, setMobilePairing] = useState<MobilePairing | undefined>();
  const [creatingMobilePairing, setCreatingMobilePairing] = useState(false);
  const controller = useRef<DesktopRealtimeController | undefined>(undefined);
  const connectGate = useRef<RealtimeConnectGate | undefined>(undefined);
  const feed = useRef<DesktopTaskNotificationFeed | undefined>(undefined);
  const approvalFeed = useRef<DesktopApprovalFeed | undefined>(undefined);
  const activeConversationId = useRef<string | undefined>(undefined);
  activeConversationId.current = conversation?.id;
  connectGate.current ??= new RealtimeConnectGate();

  feed.current = ensureActiveDesktopTaskNotificationFeed(feed.current, createTaskFeed);
  approvalFeed.current ??= createApprovalFeed();

  async function refreshFeed(conversationId?: string): Promise<void> {
    const currentFeed = feed.current;
    if (!currentFeed) {
      return;
    }

    await refreshFeedIfCurrent(
      currentFeed,
      () => feed.current,
      (nextTasks, nextNotifications) => {
        setTasks(nextTasks);
        setNotifications(nextNotifications);
      },
      conversationId);
  }

  async function refreshApprovals(): Promise<void> {
    const current = approvalFeed.current;
    if (!current) {
      return;
    }
    await current.refresh();
    if (approvalFeed.current === current) {
      setApprovals(current.approvals);
    }
  }

  async function loadDiagnostics(): Promise<void> {
    setError(undefined);
    try {
      setDiagnostics(parseDiagnostics(await window.jarvis.getDiagnostics()));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Diagnostics request failed.");
    }
  }

  async function createMobilePairing(): Promise<void> {
    setCreatingMobilePairing(true);
    setError(undefined);
    try {
      setMobilePairing(mobilePairingFrom(await window.jarvis.createMobilePairing(
        buildDesktopMobilePairingInput(crypto.randomUUID()))));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Mobile pairing creation failed.");
    } finally {
      setCreatingMobilePairing(false);
    }
  }

  useEffect(() => {
    feed.current = ensureActiveDesktopTaskNotificationFeed(feed.current, createTaskFeed);
    let effectActive = true;
    void window.jarvis.getAppVersion().then(setVersion);
    void window.jarvis.getDesktopDevice()
      .then(value => setDevice(deviceFrom(value)))
      .catch(reason => setError(reason instanceof Error ? reason.message : "Desktop bootstrap failed."));

    const removeEventListener = window.jarvis.onBackendEvent(value => {
      try {
        const currentFeed = feed.current;
        if (!currentFeed) {
          return;
        }

        const decoded = decodeSignalREventEnvelope(value);
        void Promise.all([
          currentFeed.applyEvent(decoded),
          approvalFeed.current?.applyEvent({ eventId: decoded.eventId, type: decoded.type })
        ])
          .then(() => {
            if (!effectActive) {
              return;
            }
            setTasks(currentFeed.tasks);
            setNotifications(currentFeed.notifications);
            setApprovals(approvalFeed.current?.approvals ?? []);
          })
          .catch(reason => {
            if (effectActive) {
              setError(reason instanceof Error ? reason.message : "Task feed refresh failed.");
            }
          });
      } catch (reason) {
        if (effectActive) {
          setError(reason instanceof Error ? reason.message : "Invalid backend event.");
        }
      }
    });
    const applyConnectionState = (value: unknown): void => {
      const next = applyBackendConnectionState(backendConnection.current, value);
      if (next === backendConnection.current) {
        return;
      }
      backendConnection.current = next;
      const state = next.state;
      setBackendConnectionState(state);
      void refreshOnBackendConnectionState(state, refreshFeed, activeConversationId.current).catch(reason => {
        if (effectActive) {
          setError(reason instanceof Error ? reason.message : "Task feed refresh failed.");
        }
      });
      if (state === "connected") {
        void refreshApprovals().catch(reason => {
          if (effectActive) {
            setError(reason instanceof Error ? reason.message : "Approval refresh failed.");
          }
        });
      }
    };
    const removeConnectionListener = window.jarvis.onBackendConnectionState(value => {
      try {
        applyConnectionState(value);
      } catch (reason) {
        if (effectActive) {
          setError(reason instanceof Error ? reason.message : "Invalid backend connection state.");
        }
      }
    });
    void window.jarvis.getBackendConnectionState()
      .then(applyConnectionState)
      .catch(reason => {
        if (effectActive) {
          setError(reason instanceof Error ? reason.message : "Backend connection state request failed.");
        }
      });
    return () => {
      effectActive = false;
      removeEventListener();
      removeConnectionListener();
      feed.current?.dispose();
      approvalFeed.current?.dispose();
    };
  }, []);

  useEffect(() => {
    void refreshFeed(conversation?.id).catch(reason =>
      setError(reason instanceof Error ? reason.message : "Task feed refresh failed."));
    void refreshApprovals().catch(reason =>
      setError(reason instanceof Error ? reason.message : "Approval refresh failed."));
  }, [conversation?.id]);

  useEffect(() => () => {
    void controller.current?.disconnect("desktop-closed");
  }, []);

  async function createConversation(): Promise<Conversation | undefined> {
    setError(undefined);
    try {
      const value = await window.jarvis.createConversation({
        title: "Desktop Realtime",
        idempotencyKey: crypto.randomUUID()
      });
      const next = conversationFrom(value);
      setConversation(next);
      setConversationIdInput(next.id);
      return next;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Conversation creation failed.");
      return undefined;
    }
  }

  async function loadConversation(): Promise<void> {
    setError(undefined);
    try {
      const value = await window.jarvis.getConversation(conversationIdInput.trim());
      setConversation(conversationFrom(value));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Conversation load failed.");
    }
  }

  async function connect(): Promise<void> {
    setStatus("connecting");
    setError(undefined);
    setWakeState("standby");
    setMuted(true);
    let ownedMediaStream: MediaStream | undefined;
    try {
      const activeConversation = await ensureConversation(conversation, createConversation);
      if (!activeConversation) {
        setStatus("degraded");
        return;
      }
      const activeDevice = device ?? deviceFrom(await window.jarvis.getDesktopDevice());
      setDevice(activeDevice);
      if (controller.current) {
        if (!await controller.current.disconnect("reconnect")) {
          setStatus(controller.current.status);
          setError("旧 Realtime Session 的消息尚未保存，请先重试保存。");
          return;
        }
        controller.current = undefined;
      }
      const secret = clientSecretFrom(await window.jarvis.createRealtimeClientSecret({
        conversationId: activeConversation.id,
        deviceId: activeDevice.deviceId,
        preferredVoice: null,
        idempotencyKey: crypto.randomUUID()
      }));
      ownedMediaStream = await requestApplicationAudioStream();
      const wakeWordDetector = createSherpaWakeWordDetector(window.jarvis, secret.wakeWord.keyword);
      const voice = secret.voice;
      const nextController = new DesktopRealtimeController(
        activeConversation.id,
        {
          markConnected: input => window.jarvis.realtimeConnected(input),
          markEnded: input => window.jarvis.realtimeEnded(input),
          ingest: async input => {
            const result = await window.jarvis.ingestRealtimeEvents(input);
            const refreshed = await window.jarvis.getConversation(activeConversation.id);
            setConversation(conversationFrom(refreshed));
            return result;
          },
          delegateTask: async (input, idempotencyKey) => {
            const result = await window.jarvis.delegateTask({
              ...input,
              conversationId: activeConversation.id,
              idempotencyKey
            });
            await refreshFeed(activeConversation.id);
            return result;
          },
          getTaskStatus: async input => mapRealtimeTaskStatusResponse(
            await window.jarvis.getTaskStatus(input.taskId)),
          cancelTask: async (input, idempotencyKey) => mapRealtimeCancelResponse(
            await window.jarvis.cancelTask({
              taskId: input.taskId,
              idempotencyKey
            })),
          rememberFact: async (input, idempotencyKey) => window.jarvis.rememberFact({
            ...input,
            idempotencyKey
          })
        },
        (nextStatus, nextError) => {
          setStatus(nextStatus);
          if (nextError) {
            setError(nextError);
          }
        }
      );
      nextController.setWakeWordDetector(wakeWordDetector, nextWakeState => {
        setWakeState(nextWakeState);
        setMuted(nextWakeState === "standby");
        if (nextWakeState === "awake") {
          playWakeTone();
        }
      });
      nextController.setRotationProvider(async () => clientSecretFrom(await window.jarvis.createRealtimeClientSecret({
        conversationId: activeConversation.id,
        deviceId: activeDevice.deviceId,
        preferredVoice: voice,
        idempotencyKey: crypto.randomUUID()
      })));
      controller.current = nextController;
      await nextController.connect({ ...secret, mediaStream: ownedMediaStream });
      ownedMediaStream = undefined;
    } catch (reason) {
      for (const track of ownedMediaStream?.getTracks() ?? []) {
        track.stop();
      }
      setStatus("degraded");
      setError(reason instanceof Error ? reason.message : "Realtime connection failed.");
    }
  }

  function requestConnect(): Promise<void> {
    return connectGate.current!.run(connect);
  }

  async function disconnect(): Promise<void> {
    const activeController = controller.current;
    if (!activeController) {
      return;
    }

    try {
      if (await activeController.disconnect()) {
        controller.current = undefined;
        setWakeState("standby");
        setMuted(true);
      } else {
        setError("消息尚未保存，Realtime Session 仍可重试。");
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Realtime disconnect failed.");
    }
  }

  async function retryPersistence(): Promise<void> {
    const activeController = controller.current;
    if (!activeController) {
      return;
    }

    try {
      if (await activeController.retryPersistence()) {
        setError(undefined);
        if (activeController.status === "disconnected") {
          controller.current = undefined;
        }
      } else {
        setError("消息仍未保存，请稍后重试。");
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Message persistence retry failed.");
    }
  }

  async function sendTyped(): Promise<void> {
    const text = draft.trim();
    if (!text || !conversation) {
      return;
    }

    const activeController = controller.current;
    if (!canSendRealtimeText(status, connectGate.current?.isRunning ?? false) || !activeController) {
      setError("请等待 Realtime 连接成功后再发送文字。");
      return;
    }

    setDraft("");

    const persistTyped = async (persistedText: string): Promise<void> => {
      await window.jarvis.addTypedMessage({
        conversationId: conversation.id,
        clientRequestId: crypto.randomUUID(),
        text: persistedText,
        realtimeSessionId: activeController.realtimeSessionId,
        idempotencyKey: crypto.randomUUID()
      });
      const refreshed = await window.jarvis.getConversation(conversation.id);
      setConversation(conversationFrom(refreshed));
    };

    try {
      await activeController.sendTyped(text, persistTyped);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Typed message failed.");
    }
  }

  async function resolveApproval(approvalId: string, decision: "approve" | "deny"): Promise<void> {
    const current = approvalFeed.current;
    if (!current || resolvingApprovalId) {
      return;
    }
    setResolvingApprovalId(approvalId);
    setError(undefined);
    try {
      if (decision === "approve") {
        await current.approveOnce(approvalId);
      } else {
        await current.deny(approvalId);
      }
      setApprovals(current.approvals);
      await refreshFeed(conversation?.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Approval decision failed.");
    } finally {
      setResolvingApprovalId(undefined);
    }
  }

  const popupNotification = notifications[0];

  return (
    <main>
      <h1>Jarvis</h1>
      <p>Desktop voice and typed input share one persisted Conversation.</p>
      <p aria-live="polite">状态：{status}{device ? ` · ${device.name}` : ""}</p>
      <p aria-live="polite">
        麦克风：{status === "connected"
          ? wakeState === "awake" ? "已唤醒" : "等待唤醒词“贾维斯”（音频仅在本机检测）"
          : "未连接"}
      </p>
      <button type="button" onClick={() => void loadDiagnostics()}>运行诊断</button>
      {diagnostics ? (
        <section aria-label="运行诊断">
          <h2>运行诊断</h2>
          <p>Backend {diagnostics.version} · uptime {diagnostics.uptimeSeconds}s · database {diagnostics.databaseAvailable ? "ok" : "unavailable"}</p>
          <p>Tasks {Object.entries(diagnostics.tasksByStatus).map(([name, count]) => `${name}:${count}`).join(" · ") || "none"}</p>
          <p>Approvals {diagnostics.pendingApprovals} · Notifications {diagnostics.unreadNotifications} · Outbox {diagnostics.pendingOutbox} · Devices {diagnostics.onlineDevices}</p>
          <p>Workers {Object.entries(diagnostics.workers).map(([name, state]) => `${name}:${state}`).join(" · ") || "none"}</p>
          <p>Circuits {Object.entries(diagnostics.circuits).map(([name, state]) => `${name}:${state}`).join(" · ") || "none"}</p>
        </section>
      ) : null}
      <section aria-label="Mobile Pairing">
        <h2>Mobile 配对</h2>
        <p>在手机端输入一次性配对码以建立 Mobile Session。</p>
        <button type="button" onClick={() => void createMobilePairing()} disabled={creatingMobilePairing}>
          {creatingMobilePairing ? "生成中…" : "生成手机配对码"}
        </button>
        {mobilePairing ? (
          <p>
            配对码：<code>{mobilePairing.code}</code>（{new Date(mobilePairing.expiresAtMs).toLocaleTimeString()} 前有效）
          </p>
        ) : null}
      </section>
      <div>
        <button type="button" onClick={() => void createConversation()}>新建会话</button>
        <input
          aria-label="Conversation ID"
          value={conversationIdInput}
          onChange={event => setConversationIdInput(event.target.value)}
          placeholder="Conversation ID"
        />
        <button type="button" onClick={() => void loadConversation()}>加载会话</button>
      </div>
      <div>
        <button type="button" onClick={() => void requestConnect()} disabled={status === "connecting" || status === "connected"}>
          连接 Realtime
        </button>
        <button type="button" onClick={() => void disconnect()} disabled={status === "disconnected"}>
          断开
        </button>
        {status === "degraded" && controller.current ? (
          <button type="button" onClick={() => void retryPersistence()}>
            重试保存
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => {
            const activeController = controller.current;
            if (!activeController) {
              return;
            }
            if (muted && wakeState === "standby") {
              setError("请先说“贾维斯”唤醒本轮语音输入；文字输入始终可用。");
              return;
            }
            activeController.setMicrophoneMuted(!muted);
          }}
          disabled={status !== "connected"}
        >
          {muted ? "等待“贾维斯”唤醒" : "关闭麦克风"}
        </button>
        <button type="button" onClick={() => controller.current?.interrupt()} disabled={status !== "connected"}>
          停止助手回答
        </button>
      </div>
      <form onSubmit={event => { event.preventDefault(); void sendTyped(); }}>
        <input
          aria-label="Typed message"
          value={draft}
          onChange={event => setDraft(event.target.value)}
          placeholder="输入文字，发送到当前 Realtime Session"
        />
        <button
          type="submit"
          disabled={!conversation || !canSendRealtimeText(status, connectGate.current?.isRunning ?? false) || !draft.trim()}
        >
          发送文字
        </button>
      </form>
      {error ? <p role="alert">{error}</p> : null}
      {popupNotification ? (
        <aside role="dialog" aria-label="Notification popup" aria-live="polite">
          <h2>{popupNotification.title}</h2>
          <p>{popupNotification.body}</p>
          {popupNotification.actions?.includes("acknowledge") ? (
            <button
              type="button"
              onClick={() => void feed.current?.acknowledge(popupNotification.id).then(() => {
                setNotifications(feed.current?.notifications ?? []);
              }).catch(reason => setError(reason instanceof Error ? reason.message : "Notification action failed."))}
            >
              确认已处理
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => void feed.current?.read(popupNotification.id).then(() => {
              setNotifications(feed.current?.notifications ?? []);
            }).catch(reason => setError(reason instanceof Error ? reason.message : "Notification read failed."))}
          >
            已读并关闭
          </button>
          <button
            type="button"
            onClick={() => void feed.current?.dismiss(popupNotification.id).then(() => {
              setNotifications(feed.current?.notifications ?? []);
            }).catch(reason => setError(reason instanceof Error ? reason.message : "Notification dismiss failed."))}
          >
            忽略并关闭
          </button>
        </aside>
      ) : null}
      {conversation ? (
        <section aria-label="Conversation messages">
          <h2>{conversation.title}</h2>
          <p>{conversation.id} · {conversation.messageCount} 条消息</p>
          <ol>
            {conversation.messages.map(message => (
              <li key={message.id}>
                <strong>{message.role}</strong> <small>{message.status}</small>
                <p>{message.text ?? "（无文字内容）"}</p>
              </li>
            ))}
          </ol>
        </section>
      ) : <p>尚未选择 Conversation。</p>}
      <section aria-label="Approval Requests">
        <h2>待审批 ({approvals.length})</h2>
        {approvals.length > 0 ? (
          <ul>
            {approvals.map(approval => (
              <li key={approval.id}>
                <strong>{approval.kind}</strong>
                <p>{approval.reason}</p>
                <p><small>Task {approval.taskId} · Device {approval.deviceId}</small></p>
                <button
                  type="button"
                  disabled={resolvingApprovalId !== undefined}
                  onClick={() => void resolveApproval(approval.id, "approve")}
                >
                  仅批准本次
                </button>
                <button
                  type="button"
                  disabled={resolvingApprovalId !== undefined}
                  onClick={() => void resolveApproval(approval.id, "deny")}
                >
                  拒绝并停止
                </button>
              </li>
            ))}
          </ul>
        ) : <p>当前没有待审批操作。</p>}
      </section>
      <section aria-label="Task Center">
        <h2>Task Center</h2>
        <p>Control Plane：{backendConnectionState} · {tasks.length} 个任务</p>
        {tasks.length > 0 ? (
          <ul>
            {tasks.map(task => (
              <li key={task.id}>
                <strong>{task.status}</strong> {task.goal ?? task.id}
                {task.resultSummary ? <p>{task.resultSummary}</p> : null}
                {task.pendingUserInput ? (
                  <TaskUserInputForm
                    task={task}
                    onSubmitted={() => refreshFeed(conversation?.id)}
                    onError={reason => setError(reason instanceof Error ? reason.message : "Task user-input submission failed.")}
                  />
                ) : null}
                {task.status !== "succeeded"
                  && task.status !== "failed"
                  && task.status !== "cancelled" ? (
                    <button
                      type="button"
                      onClick={() => void window.jarvis.cancelTask({
                        taskId: task.id,
                        idempotencyKey: crypto.randomUUID()
                      }).then(() => refreshFeed(conversation?.id)).catch(reason =>
                        setError(reason instanceof Error ? reason.message : "Task cancellation failed."))}
                    >
                      取消任务
                    </button>
                  ) : null}
              </li>
            ))}
          </ul>
        ) : <p>当前没有非终态任务。</p>}
      </section>
      <section aria-label="Notifications">
        <h2>通知 ({notifications.length})</h2>
        {notifications.length > 0 ? (
          <ul>
            {notifications.map(notification => (
              <li key={notification.id}>
                <strong>{notification.title}</strong>
                <p>{notification.body}</p>
                {notification.actions?.includes("acknowledge") ? (
                  <button
                    type="button"
                    onClick={() => void feed.current?.acknowledge(notification.id).then(() => {
                      setNotifications(feed.current?.notifications ?? []);
                    }).catch(reason => setError(reason instanceof Error ? reason.message : "Notification action failed."))}
                  >
                    确认已处理
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => void feed.current?.read(notification.id).then(() => {
                    setNotifications(feed.current?.notifications ?? []);
                  }).catch(reason => setError(reason instanceof Error ? reason.message : "Notification read failed."))}
                >
                  已读
                </button>
                <button
                  type="button"
                  onClick={() => void feed.current?.dismiss(notification.id).then(() => {
                    setNotifications(feed.current?.notifications ?? []);
                  }).catch(reason => setError(reason instanceof Error ? reason.message : "Notification dismiss failed."))}
                >
                  忽略
                </button>
              </li>
            ))}
          </ul>
        ) : <p>没有未读通知。</p>}
      </section>
      <small>Desktop version: {version}</small>
    </main>
  );
}
