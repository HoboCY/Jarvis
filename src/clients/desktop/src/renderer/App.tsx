import { useEffect, useRef, useState, type ReactNode } from "react";
import { decodeSignalREventEnvelope } from "@jarvis/contracts-ts";
import "./app.css";
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
  ensureActiveDesktopApprovalFeed,
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

type IconName =
  | "approvals"
  | "assistant"
  | "bell"
  | "chevron"
  | "close"
  | "conversation"
  | "diagnostics"
  | "link"
  | "microphone"
  | "new"
  | "send"
  | "settings"
  | "tasks";

const waveformHeights = [3, 5, 8, 4, 12, 7, 18, 8, 5, 13, 22, 9, 5, 15, 8, 4, 10, 17, 7, 5, 11, 6, 3];

function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, ReactNode> = {
    approvals: <><path d="M12 3 4.5 6v5.2c0 4.6 3.1 8.8 7.5 9.8 4.4-1 7.5-5.2 7.5-9.8V6L12 3Z" /><path d="m8.8 12 2.1 2.1 4.4-4.5" /></>,
    assistant: <><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="3.5" /><path d="M12 1.5v2M12 20.5v2M1.5 12h2M20.5 12h2" /></>,
    bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" /><path d="M10 21h4" /></>,
    chevron: <path d="m9 18 6-6-6-6" />,
    close: <><path d="m6 6 12 12M18 6 6 18" /></>,
    conversation: <><path d="M21 13a7 7 0 0 1-7 7H7l-4 2 1.3-4A8.8 8.8 0 0 1 3 13a9 9 0 0 1 18 0Z" /><path d="M8 12h.01M12 12h.01M16 12h.01" /></>,
    diagnostics: <><path d="M3 12h4l2-6 4 12 2-6h6" /><path d="M4 4h16v16H4z" /></>,
    link: <><path d="M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1.2 1.2" /><path d="M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1.2-1.2" /></>,
    microphone: <><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6" /></>,
    new: <><path d="M12 5v14M5 12h14" /><circle cx="12" cy="12" r="9" /></>,
    send: <><path d="m22 2-7 20-4-9-9-4 20-7Z" /><path d="M22 2 11 13" /></>,
    settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6 1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" /></>,
    tasks: <><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M8 8h8M8 12h8M8 16h5" /></>
  };

  return (
    <svg
      aria-hidden="true"
      className="icon"
      fill="none"
      height={size}
      viewBox="0 0 24 24"
      width={size}
    >
      <g stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6">
        {paths[name]}
      </g>
    </svg>
  );
}

function realtimeStatusLabel(status: DesktopRealtimeStatus): string {
  switch (status) {
    case "connected": return "语音在线";
    case "connecting": return "正在连接";
    case "degraded": return "需要处理";
    default: return "连接语音";
  }
}

function taskStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    assigned: "已分配",
    cancellationRequested: "正在取消",
    queued: "等待中",
    recovering: "恢复中",
    running: "执行中",
    waitingForApproval: "等待审批",
    waitingForUserInput: "需要输入"
  };
  return labels[status] ?? status;
}

function approvalKindLabel(kind: DesktopApproval["kind"]): string {
  const labels: Record<DesktopApproval["kind"], string> = {
    command: "执行命令",
    externalWrite: "写入外部系统",
    fileWrite: "写入文件",
    permission: "请求权限"
  };
  return labels[kind];
}

function scrollToPanel(id: string): void {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

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
    <form className="task-input-form" onSubmit={event => {
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
  approvalFeed.current = ensureActiveDesktopApprovalFeed(approvalFeed.current, createApprovalFeed);

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
    approvalFeed.current = ensureActiveDesktopApprovalFeed(approvalFeed.current, createApprovalFeed);
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
  const currentDate = new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
    weekday: "long"
  }).format(new Date());
  const wakeLabel = status !== "connected"
    ? "连接后可使用语音"
    : wakeState === "awake"
      ? muted ? "麦克风已暂停" : "正在聆听"
      : "等待“贾维斯”唤醒";

  const toggleMicrophone = (): void => {
    const activeController = controller.current;
    if (!activeController) {
      void requestConnect();
      return;
    }
    if (muted && wakeState === "standby") {
      setError("请先说“贾维斯”唤醒本轮语音输入；文字输入始终可用。");
      return;
    }
    activeController.setMicrophoneMuted(!muted);
  };

  return (
    <main className="jarvis-shell">
      <aside className="side-rail" aria-label="主要导航">
        <div className="brand-mark" aria-label="Jarvis">J</div>
        <nav className="primary-nav">
          <button className="nav-item is-active" type="button" onClick={() => scrollToPanel("assistant-panel")}>
            <Icon name="assistant" />
            <span>助手</span>
          </button>
          <button className="nav-item" type="button" onClick={() => scrollToPanel("conversation-panel")}>
            <Icon name="conversation" />
            <span>会话</span>
          </button>
          <button className="nav-item" type="button" onClick={() => scrollToPanel("task-panel")}>
            <Icon name="tasks" />
            <span>任务</span>
            {tasks.length > 0 ? <small>{tasks.length}</small> : null}
          </button>
          <button className="nav-item" type="button" onClick={() => scrollToPanel("approval-panel")}>
            <Icon name="approvals" />
            <span>审批</span>
            {approvals.length > 0 ? <small className="is-alert">{approvals.length}</small> : null}
          </button>
          <button className="nav-item" type="button" onClick={() => scrollToPanel("system-panel")}>
            <Icon name="settings" />
            <span>设置</span>
          </button>
        </nav>
        <div className="side-footer">
          <div className="avatar" aria-hidden="true">H</div>
          <span className={`presence-dot is-${backendConnectionState}`} />
        </div>
      </aside>

      <section className="workspace" id="assistant-panel">
        <header className="workspace-header">
          <div>
            <p className="eyebrow">JARVIS / PERSONAL ASSISTANT</p>
            <p className="workspace-context">{conversation?.title ?? "新的对话"}</p>
          </div>
          <div className="header-actions">
            <button
              className="icon-button notification-button"
              type="button"
              aria-label={`通知 ${notifications.length}`}
              onClick={() => scrollToPanel("notification-panel")}
            >
              <Icon name="bell" />
              {notifications.length > 0 ? <span>{notifications.length}</span> : null}
            </button>
            {status === "degraded" && controller.current ? (
              <button className="quiet-button" type="button" onClick={() => void retryPersistence()}>
                重试保存
              </button>
            ) : null}
            <button
              className={`connection-button is-${status}`}
              type="button"
              disabled={status === "connecting"}
              onClick={() => void (status === "connected" ? disconnect() : requestConnect())}
            >
              <span className="status-dot" />
              {status === "connected" ? "断开语音" : realtimeStatusLabel(status)}
            </button>
            <details className="session-menu">
              <summary aria-label="会话选项"><Icon name="chevron" /></summary>
              <div className="session-popover">
                <div className="session-popover-heading">
                  <strong>会话</strong>
                  <button type="button" onClick={() => void createConversation()}>
                    <Icon name="new" size={17} /> 新建
                  </button>
                </div>
                <label htmlFor="conversation-id">加载已有会话</label>
                <div className="session-input-row">
                  <input
                    id="conversation-id"
                    aria-label="Conversation ID"
                    value={conversationIdInput}
                    onChange={event => setConversationIdInput(event.target.value)}
                    placeholder="Conversation ID"
                  />
                  <button type="button" onClick={() => void loadConversation()}>加载</button>
                </div>
                {conversation ? <small>{conversation.id}</small> : null}
              </div>
            </details>
          </div>
        </header>

        <div className="conversation-scroll">
          <section
            className={`assistant-presence ${conversation ? "has-conversation" : ""}`}
            aria-labelledby="assistant-heading"
          >
            <p className="date-line">{currentDate}</p>
            <p className="greeting">晚上好，Hobo</p>
            <h1 id="assistant-heading">有什么需要我处理？</h1>
            <button
              className={`voice-presence is-${status} is-${wakeState}`}
              type="button"
              onClick={toggleMicrophone}
              aria-label={status === "connected" ? wakeLabel : "连接 Realtime"}
            >
              <span className="waveform" aria-hidden="true">
                {waveformHeights.map((height, index) => (
                  <span key={`${height}-${index}`} style={{ height }} />
                ))}
              </span>
              <span className="voice-orb"><Icon name="microphone" size={24} /></span>
              <span className="waveform is-mirrored" aria-hidden="true">
                {waveformHeights.map((height, index) => (
                  <span key={`${height}-${index}`} style={{ height }} />
                ))}
              </span>
            </button>
            <p className="voice-label" aria-live="polite">{wakeLabel}</p>
            {device ? <p className="device-label">音频在 {device.name} 本机处理</p> : null}
          </section>

          {error ? (
            <div className="error-banner" role="alert">
              <span>{error}</span>
              <button type="button" onClick={() => setError(undefined)} aria-label="关闭错误提示">
                <Icon name="close" size={17} />
              </button>
            </div>
          ) : null}

          <section className="messages" id="conversation-panel" aria-label="Conversation messages">
            <div className="section-title-row">
              <div>
                <p className="section-kicker">当前会话</p>
                <h2>{conversation?.title ?? "还没有开始对话"}</h2>
              </div>
              {conversation ? <span>{conversation.messageCount} 条消息</span> : null}
            </div>
            {conversation?.messages.length ? (
              <ol className="message-list">
                {conversation.messages.map(message => {
                  const fromAssistant = message.role.toLowerCase() === "assistant";
                  return (
                    <li className={fromAssistant ? "is-assistant" : "is-user"} key={message.id}>
                      <div className="message-meta">
                        <span>{fromAssistant ? "JARVIS" : "你"}</span>
                        <small>{message.status}</small>
                      </div>
                      <p>{message.text ?? "（无文字内容）"}</p>
                    </li>
                  );
                })}
              </ol>
            ) : (
              <div className="empty-conversation">
                <p>从一个问题开始，或说“贾维斯”唤醒语音。</p>
                <button type="button" onClick={() => void createConversation()}>
                  <Icon name="new" size={17} /> 创建会话
                </button>
              </div>
            )}
          </section>
        </div>

        <footer className="composer-wrap">
          <form className="composer" onSubmit={event => { event.preventDefault(); void sendTyped(); }}>
            <input
              aria-label="Typed message"
              value={draft}
              onChange={event => setDraft(event.target.value)}
              placeholder="输入消息或按住说话…"
            />
            <button
              className={`composer-mic ${!muted ? "is-listening" : ""}`}
              type="button"
              onClick={toggleMicrophone}
              disabled={status !== "connected"}
              aria-label={muted ? "唤醒麦克风" : "关闭麦克风"}
            >
              <Icon name="microphone" size={21} />
            </button>
            <button
              className="composer-send"
              type="submit"
              disabled={!conversation || !canSendRealtimeText(status, connectGate.current?.isRunning ?? false) || !draft.trim()}
              aria-label="发送文字"
            >
              <Icon name="send" size={20} />
            </button>
          </form>
          <div className="composer-note">
            <span>Realtime 与文字共用当前会话</span>
            <button type="button" onClick={() => controller.current?.interrupt()} disabled={status !== "connected"}>
              停止回答
            </button>
          </div>
        </footer>
      </section>

      <aside className="action-center" aria-label="行动中心">
        <header className="action-header">
          <div>
            <p className="section-kicker">CONTROL PANEL</p>
            <h2>行动中心</h2>
          </div>
          <span className={`control-status is-${backendConnectionState}`}>
            <i /> {backendConnectionState === "connected" ? "已连接" : backendConnectionState}
          </span>
        </header>

        <div className="action-scroll">
          <section className="action-section" id="task-panel" aria-label="Task Center">
            <div className="action-section-title">
              <h3>进行中的任务</h3>
              <span>{tasks.length}</span>
            </div>
            {tasks.length > 0 ? (
              <div className="task-list">
                {tasks.map(task => (
                  <article className={`task-item is-${task.status}`} key={task.id}>
                    <div className="task-heading">
                      <span className="task-icon"><Icon name="tasks" size={18} /></span>
                      <div>
                        <strong>{task.goal ?? task.id}</strong>
                        <small>{taskStatusLabel(task.status)}</small>
                      </div>
                      <Icon name="chevron" size={16} />
                    </div>
                    {task.status === "running" ? <div className="activity-line" aria-hidden="true"><span /></div> : null}
                    {task.progressSummary || task.resultSummary ? (
                      <p className="task-summary">{task.progressSummary ?? task.resultSummary}</p>
                    ) : null}
                    {task.pendingUserInput ? (
                      <TaskUserInputForm
                        task={task}
                        onSubmitted={() => refreshFeed(conversation?.id)}
                        onError={reason => setError(reason instanceof Error ? reason.message : "Task user-input submission failed.")}
                      />
                    ) : null}
                    {task.status !== "succeeded" && task.status !== "failed" && task.status !== "cancelled" ? (
                      <button
                        className="text-action"
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
                  </article>
                ))}
              </div>
            ) : <p className="empty-state">没有正在执行的任务</p>}
          </section>

          <section className="action-section approvals-section" id="approval-panel" aria-label="Approval Requests">
            <div className="action-section-title">
              <h3>待审批</h3>
              <span className={approvals.length > 0 ? "is-alert" : ""}>{approvals.length}</span>
            </div>
            {approvals.length > 0 ? (
              <div className="approval-list">
                {approvals.map(approval => (
                  <article className="approval-item" key={approval.id}>
                    <div className="approval-heading">
                      <span><Icon name="approvals" size={19} /></span>
                      <div>
                        <strong>{approvalKindLabel(approval.kind)}</strong>
                        <small>需要你的明确决定</small>
                      </div>
                    </div>
                    <p>{approval.reason}</p>
                    <small className="approval-context">Task {approval.taskId} · Device {approval.deviceId}</small>
                    <div className="approval-actions">
                      <button
                        className="approve-button"
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
                        拒绝
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            ) : <p className="empty-state">当前没有待审批操作</p>}
          </section>

          <section className="action-section" id="notification-panel" aria-label="Notifications">
            <div className="action-section-title">
              <h3>通知</h3>
              <span>{notifications.length}</span>
            </div>
            {notifications.length > 0 ? (
              <div className="notification-list">
                {notifications.map(notification => (
                  <article className="notification-item" key={notification.id}>
                    <strong>{notification.title}</strong>
                    <p>{notification.body}</p>
                    <div className="notification-actions">
                      {notification.actions?.includes("acknowledge") ? (
                        <button
                          type="button"
                          onClick={() => void feed.current?.acknowledge(notification.id).then(() => {
                            setNotifications(feed.current?.notifications ?? []);
                          }).catch(reason => setError(reason instanceof Error ? reason.message : "Notification action failed."))}
                        >
                          确认处理
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
                    </div>
                  </article>
                ))}
              </div>
            ) : <p className="empty-state">没有未读通知</p>}
          </section>

          <section className="action-section system-section" id="system-panel" aria-label="系统状态">
            <div className="action-section-title">
              <h3>系统</h3>
              <button className="diagnostics-button" type="button" onClick={() => void loadDiagnostics()}>
                <Icon name="diagnostics" size={16} /> 运行诊断
              </button>
            </div>
            <div className="system-list">
              <div><span><i className={`is-${backendConnectionState}`} />Backend</span><small>{backendConnectionState}</small></div>
              <div><span><i className={`is-${status}`} />Realtime</span><small>{realtimeStatusLabel(status)}</small></div>
              <div><span><i className={wakeState === "awake" ? "is-connected" : ""} />麦克风</span><small>{wakeLabel}</small></div>
            </div>
            {diagnostics ? (
              <div className="diagnostics-panel" aria-label="运行诊断">
                <div><span>Backend</span><strong>{diagnostics.version}</strong></div>
                <div><span>Database</span><strong>{diagnostics.databaseAvailable ? "正常" : "不可用"}</strong></div>
                <div><span>Uptime</span><strong>{diagnostics.uptimeSeconds}s</strong></div>
                <div><span>Outbox</span><strong>{diagnostics.pendingOutbox}</strong></div>
                <div><span>Devices</span><strong>{diagnostics.onlineDevices}</strong></div>
                <p>Workers {Object.entries(diagnostics.workers).map(([name, state]) => `${name}:${state}`).join(" · ") || "none"}</p>
                <p>Circuits {Object.entries(diagnostics.circuits).map(([name, state]) => `${name}:${state}`).join(" · ") || "none"}</p>
              </div>
            ) : null}
          </section>

          <section className="action-section pairing-section" aria-label="Mobile Pairing">
            <div className="action-section-title">
              <h3>移动端配对</h3>
              <Icon name="link" size={17} />
            </div>
            <p>生成一次性配对码，连接你的手机。</p>
            <button type="button" onClick={() => void createMobilePairing()} disabled={creatingMobilePairing}>
              {creatingMobilePairing ? "生成中…" : "生成配对码"}
            </button>
            {mobilePairing ? (
              <div className="pairing-code">
                <code>{mobilePairing.code}</code>
                <small>{new Date(mobilePairing.expiresAtMs).toLocaleTimeString()} 前有效</small>
              </div>
            ) : null}
          </section>
        </div>
        <footer className="version-line">Desktop {version}</footer>
      </aside>

      {popupNotification ? (
        <aside className="notification-toast" role="dialog" aria-label="Notification popup" aria-live="polite">
          <div>
            <p className="section-kicker">新通知</p>
            <h2>{popupNotification.title}</h2>
            <p>{popupNotification.body}</p>
          </div>
          <div className="toast-actions">
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
              忽略
            </button>
          </div>
        </aside>
      ) : null}
    </main>
  );
}
