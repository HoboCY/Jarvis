import { useEffect, useMemo, useState } from "react";
import { AppState, Button, Platform, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { RealtimeSession, type RealtimeClientMessage } from "@openai/agents-realtime";
import { createRealtimeAgent } from "@jarvis/realtime-agent";
import { MobileApiError, MobileApiSession } from "./src/session/MobileApiSession";
import { KeychainMobileApiBaseUrlStore, KeychainMobileCredentialStore, type MobileApiBaseUrlStore } from "./src/session/keychainCredentialStore";
import { MobileConversationController } from "./src/conversation/MobileConversationController";
import { MobileTaskNotificationFeed, type MobileFeedEntity } from "./src/feed/MobileTaskNotificationFeed";
import { MobileLogoutCoordinator } from "./src/session/MobileLogoutCoordinator";
import { MobileSignalRConnection, createProductionMobileSignalRConnection } from "./src/realtime/MobileSignalRConnection";
import { MobileRealtimeConversationBridge } from "./src/realtime/MobileRealtimeConversationBridge";
import { ReactNativeWebRTCTransport } from "./src/realtime/ReactNativeWebRTCTransport";
import { createReactNativeWebRTCBoundary } from "./src/realtime/reactNativeBoundary";
import { MobileAudioRoute, type AudioRoute } from "./src/audio/MobileAudioRoute";
import { createReactNativeAudioRouteBoundary } from "./src/audio/reactNativeAudioRoute";
import { MobileLifecycleController, type MobileAppStateSource, type MobileLifecycleRuntime } from "./src/lifecycle/MobileLifecycleController";
import { VoiceSessionCoordinator, type VoiceSessionAttempt } from "./src/voice/VoiceSessionCoordinator";
import { buildMobileRealtimeBootstrapRequest, buildMobileTaskRequest } from "./src/app/MobileRequestBuilders";
import { createMobileIdempotencyKey } from "./src/platform/mobileUuid";

const configuredApiBaseUrl = globalThis.__JARVIS_API_BASE_URL__?.trim() ?? "";
const unconfiguredApiBaseUrl = "https://configure.invalid";

type MobileServices = {
  session: MobileApiSession;
  feed: MobileTaskNotificationFeed;
  signalR: MobileSignalRConnection;
  audio: MobileAudioRoute;
  conversation: MobileConversationController;
  voice: VoiceSessionCoordinator;
  lifecycle: MobileLifecycleController;
  endpointStore: MobileApiBaseUrlStore;
  configureBaseUrl: (value: string) => void;
  muteVoice: (muted: boolean) => void;
  interruptVoice: () => void;
  registerVoiceSession: (session: RealtimeSession, realtimeSessionId: string, attempt?: VoiceSessionAttempt) => Promise<void>;
  stopVoice: () => Promise<void>;
  logout: () => Promise<void>;
};

type MobileSafeDevice = { deviceId: string; name?: string; status: string; platform?: string };

function createServices(): MobileServices {
  const session = new MobileApiSession({
    baseUrl: configuredApiBaseUrl || unconfiguredApiBaseUrl,
    credentials: new KeychainMobileCredentialStore()
  });
  const feed = new MobileTaskNotificationFeed({
    listTasks: async query => session.getJson<{ items: MobileFeedEntity[]; nextCursor: string | null }>(
      buildQueryPath("/api/v1/tasks", query)),
    listUnreadNotifications: async () => (await session.getJson<{ items: MobileFeedEntity[] }>("/api/v1/notifications?status=unread")).items,
    listPendingApprovals: async () => (await session.getJson<{ items: MobileFeedEntity[] }>("/api/v1/approvals?status=pending")).items,
    updateNotification: async (notificationId, action, idempotencyKey) => {
      return session.postJson<MobileFeedEntity>(`/api/v1/notifications/${encodeURIComponent(notificationId)}/${action}`, {}, idempotencyKey);
    },
    decideApproval: (approvalId, decision, scope, idempotencyKey) => session.postJson<MobileFeedEntity>(
      `/api/v1/approvals/${encodeURIComponent(approvalId)}/decision`,
      { decision, scope, clientRequestId: idempotencyKey },
      idempotencyKey)
  });
  const signalR = createProductionMobileSignalRConnection(configuredApiBaseUrl || unconfiguredApiBaseUrl, session, feed);
  const audio = new MobileAudioRoute(createReactNativeAudioRouteBoundary());
  const voice = new VoiceSessionCoordinator(AppState.currentState === "active");
  const conversation = new MobileConversationController({
    createConversation: title => session.postJson(`/api/v1/conversations`, { title: title ?? null }, `mobile-conversation-${Date.now()}`),
    getConversation: conversationId => session.getJson(`/api/v1/conversations/${encodeURIComponent(conversationId)}`),
    addTypedMessage: (conversationId, request, idempotencyKey) => session.postJson(
      `/api/v1/conversations/${encodeURIComponent(conversationId)}/messages/typed`, request, idempotencyKey)
  }, () => createMobileIdempotencyKey("mobile-message"));
  const endpointStore = new KeychainMobileApiBaseUrlStore();
  let voiceBinding: { session: RealtimeSession; bridge: MobileRealtimeConversationBridge } | undefined;
  const registerVoiceSession = async (
    voiceSession: RealtimeSession,
    realtimeSessionId: string,
    attempt?: VoiceSessionAttempt
  ): Promise<void> => {
    const bridge = new MobileRealtimeConversationBridge(
      conversation.conversationId ?? "",
      realtimeSessionId,
      {
        markConnected: input => session.postJson(
          `/api/v1/realtime/sessions/${encodeURIComponent(input.sessionId)}/connected`,
          { externalSessionId: input.externalSessionId },
          input.idempotencyKey),
        markEnded: input => session.postJson(
          `/api/v1/realtime/sessions/${encodeURIComponent(input.sessionId)}/ended`,
          { reason: input.reason, status: input.status },
          input.idempotencyKey),
        ingest: input => session.postJson(
          `/api/v1/conversations/${encodeURIComponent(input.conversationId)}/realtime-events:ingest`,
          { version: 1, events: input.events },
          input.idempotencyKey)
      });
    attempt?.adopt(() => bridge.close("mobile-startup-cancelled", "failed"));
    try {
      await bridge.connect(voiceSession);
      voiceBinding = { session: voiceSession, bridge };
      conversation.attachVoiceSession({
        interrupt: () => voiceSession.interrupt(),
        sendEvent: event => voiceSession.transport.sendEvent(event as RealtimeClientMessage)
      });
    } catch (error) {
      await bridge.close("mobile-connect-failed", "failed").catch(() => undefined);
      throw error;
    }
  };
  const stopVoice = async (): Promise<void> => {
    const current = voiceBinding;
    voiceBinding = undefined;
    conversation.attachVoiceSession(undefined);
    await current?.bridge.close();
    await audio.stop();
  };
  const stopAllVoice = async (): Promise<void> => {
    let firstError: unknown;
    try {
      await voice.stop();
    } catch (error) {
      firstError = error;
    }
    try {
      await stopVoice();
    } catch (error) {
      firstError ??= error;
    }
    if (firstError) {
      throw firstError;
    }
  };
  const logout = new MobileLogoutCoordinator({
    revoke: () => session.revoke(),
    stopVoice: stopAllVoice,
    disconnectSignalR: () => signalR.disconnect(),
    clearFeed: () => feed.clear(),
    clearCredentials: () => session.clearCredentials()
  });
  const appStateSource: MobileAppStateSource = {
    get state() {
      return mapAppState(AppState.currentState);
    },
    subscribe: listener => {
      const subscription = AppState.addEventListener("change", state => {
        const mapped = mapAppState(state);
        voice.setForeground(mapped === "active");
        listener(mapped);
      });
      return () => subscription.remove();
    }
  };
  const runtime: MobileLifecycleRuntime = {
    refreshAuth: () => session.refresh(),
    recoverHttpState: () => feed.refresh(),
    connectRealtime: async () => undefined,
    disconnectRealtime: stopAllVoice,
    connectSignalR: () => signalR.connect(),
    disconnectSignalR: () => signalR.disconnect(),
    stopAudio: () => audio.stop()
  };
  return {
    session,
    feed,
    signalR,
    audio,
    conversation,
    voice,
    lifecycle: new MobileLifecycleController(appStateSource, runtime),
    endpointStore,
    configureBaseUrl: value => {
      session.setBaseUrl(value);
      signalR.setBaseUrl(value);
    },
    muteVoice: muted => voiceBinding?.session.mute(muted),
    interruptVoice: () => voiceBinding?.session.interrupt(),
    registerVoiceSession,
    stopVoice,
    logout: () => logout.logout()
  };
}

function mapAppState(state: string | null | undefined): "active" | "inactive" | "background" | "unknown" {
  return state === "active" || state === "inactive" || state === "background" ? state : "unknown";
}

export default function App(): React.JSX.Element {
  const services = useMemo(createServices, []);
  const [pairingCode, setPairingCode] = useState("");
  const [apiBaseUrl, setApiBaseUrl] = useState(configuredApiBaseUrl);
  const [apiBaseUrlInput, setApiBaseUrlInput] = useState(configuredApiBaseUrl);
  const [endpointReady, setEndpointReady] = useState(Boolean(configuredApiBaseUrl));
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState("未配对");
  const [conversationId, setConversationId] = useState<string>();
  const [preferredDeviceId, setPreferredDeviceId] = useState<string>();
  const [desktopDevices, setDesktopDevices] = useState<MobileSafeDevice[]>([]);
  const [mobileDeviceId, setMobileDeviceId] = useState<string>();
  const [taskGoal, setTaskGoal] = useState("");
  const [taskAllowedRoot, setTaskAllowedRoot] = useState("");
  const [taskBusy, setTaskBusy] = useState(false);
  const [taskCount, setTaskCount] = useState(0);
  const [notificationCount, setNotificationCount] = useState(0);
  const [approvalCount, setApprovalCount] = useState(0);
  const [voiceActive, setVoiceActive] = useState(false);
  const [voiceMuted, setVoiceMuted] = useState(false);
  const [audioRoute, setAudioRoute] = useState<AudioRoute>(services.audio.outputRoute);
  const [audioPolicy, setAudioPolicy] = useState<"system" | "speaker">(services.audio.requestedOutputPolicy);
  const [, setFeedRevision] = useState(0);

  function syncFeedState(): void {
    setTaskCount(services.feed.tasks.length);
    setNotificationCount(services.feed.notifications.length);
    setApprovalCount(services.feed.approvals.length);
    setFeedRevision(value => value + 1);
  }

  async function loadDesktopDevices(): Promise<MobileSafeDevice[]> {
    const response = await services.session.getJson<{ items: MobileSafeDevice[] }>("/api/v1/devices?deviceType=desktop");
    const available = response.items.filter(device => device.status !== "disabled");
    setDesktopDevices(available);
    setPreferredDeviceId(current => current && available.some(device => device.deviceId === current)
      ? current
      : available[0]?.deviceId);
    return available;
  }

  useEffect(() => {
    let effectActive = true;
    void (async () => {
      const storedBaseUrl = await services.endpointStore.load();
      const value = storedBaseUrl ?? configuredApiBaseUrl;
      if (!effectActive) {
        return;
      }
      if (!value) {
        setStatus("请先输入 Control Plane HTTPS 地址。");
        return;
      }
      services.configureBaseUrl(value);
      setApiBaseUrl(value);
      setApiBaseUrlInput(value);
      setEndpointReady(true);
      await services.lifecycle.start();
      if (!effectActive) {
        return;
      }
      try {
        const devices = await services.session.getJson<{ items: MobileSafeDevice[] }>("/api/v1/devices?deviceType=mobile");
        setMobileDeviceId(devices.items.find(device => device.status !== "disabled")?.deviceId);
        await loadDesktopDevices();
      } catch {
        // A fresh install has no mobile session yet; pairing will establish it.
      }
      syncFeedState();
    })().catch(error => {
      if (effectActive) {
        setStatus(error instanceof Error ? error.message : "启动失败");
      }
    });
    return () => {
      effectActive = false;
      services.lifecycle.dispose();
    };
  }, [services]);

  useEffect(() => services.feed.subscribe(syncFeedState), [services]);

  useEffect(() => services.audio.onRouteChanged(setAudioRoute), [services]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", state => {
      services.voice.setForeground(state === "active");
      if (state !== "active") {
        void services.stopVoice().catch(() => undefined);
        setVoiceActive(false);
        setVoiceMuted(false);
      }
    });
    return () => subscription.remove();
  }, [services]);

  async function saveApiBaseUrl(): Promise<void> {
    try {
      const normalized = apiBaseUrlInput.trim();
      services.session.setBaseUrl(normalized);
      await services.voice.stop();
      await services.stopVoice().catch(() => undefined);
      await services.signalR.disconnect();
      await services.session.clearCredentials();
      await services.endpointStore.save(normalized);
      services.configureBaseUrl(normalized);
      setApiBaseUrl(normalized.replace(/\/$/, ""));
      setApiBaseUrlInput(normalized.replace(/\/$/, ""));
          setMobileDeviceId(undefined);
      setVoiceActive(false);
      setVoiceMuted(false);
      setEndpointReady(true);
      setStatus("Control Plane 地址已保存，请重新配对。");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Control Plane 地址无效。");
    }
  }

  async function pair(): Promise<void> {
    if (!endpointReady || !apiBaseUrl) {
      setStatus("请先输入 Control Plane HTTPS 地址。");
      return;
    }
    setStatus("配对中…");
    try {
      const mobileSession = await services.session.exchange(pairingCode, {
        deviceName: "Jarvis Mobile",
        platform: Platform.OS,
        capabilities: ["microphone", "notifications"]
      });
      setMobileDeviceId(mobileSession.deviceId);
      await services.feed.refresh();
      await services.lifecycle.recoverForeground();
      setStatus("已配对");
      await loadDesktopDevices();
      syncFeedState();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "配对失败");
    }
  }

  async function createTask(): Promise<void> {
    const goal = taskGoal.trim();
    if (!goal) {
      setStatus("请输入任务目标。");
      return;
    }

    setTaskBusy(true);
    try {
      const currentConversationId = conversationId ?? (await services.conversation.open()).id;
      setConversationId(currentConversationId);
      const allowedRoot = taskAllowedRoot.trim();
      const request = buildMobileTaskRequest({
        conversationId: currentConversationId,
        goal,
        allowedRoot,
        preferredDesktopDeviceId: preferredDeviceId
      });
      await services.session.postJson("/api/v1/tasks", request, createMobileIdempotencyKey("mobile-task"));
      await services.feed.refresh();
      syncFeedState();
      setTaskGoal("");
      setStatus(allowedRoot ? "Codex 任务已提交" : "后台任务已提交");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "任务提交失败");
    } finally {
      setTaskBusy(false);
    }
  }

  async function cancelTask(taskId: string): Promise<void> {
    setTaskBusy(true);
    try {
      await services.session.postJson(
        `/api/v1/tasks/${encodeURIComponent(taskId)}/cancel`,
        {},
        createMobileIdempotencyKey(`mobile-task-cancel-${taskId}`));
      await services.feed.refresh();
      syncFeedState();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "任务取消失败");
    } finally {
      setTaskBusy(false);
    }
  }

  async function updateNotification(notificationId: string, action: "read" | "dismiss"): Promise<void> {
    try {
      await services.feed.markNotification(
        notificationId,
        action,
        createMobileIdempotencyKey(`mobile-notification-${action}-${notificationId}`));
      syncFeedState();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "通知更新失败");
    }
  }

  async function decideApproval(approvalId: string, decision: "approve" | "deny"): Promise<void> {
    try {
      await services.feed.decideApproval(
        approvalId,
        decision,
        "once",
        createMobileIdempotencyKey(`mobile-approval-${decision}-${approvalId}`));
      syncFeedState();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "审批处理失败");
    }
  }

  async function send(): Promise<void> {
    if (!conversationId) {
      const conversation = await services.conversation.open();
      setConversationId(conversation.id);
    }
    await services.conversation.sendTyped(draft);
    setDraft("");
  }

  async function startVoice(): Promise<void> {
    try {
      await services.voice.start(async attempt => {
        let currentConversationId = conversationId;
        if (!currentConversationId) {
          currentConversationId = (await services.conversation.open()).id;
          attempt.checkpoint();
          setConversationId(currentConversationId);
        }

        // Adopt cleanup before awaiting permission/native session setup so a
        // background transition during either operation can still stop audio.
        attempt.adopt(() => services.audio.stop());
        await services.audio.start();
        attempt.checkpoint();

        const currentMobileDeviceId = mobileDeviceId ?? (await services.session.getJson<{ items: MobileSafeDevice[] }>("/api/v1/devices?deviceType=mobile")).items
          .find(device => device.status !== "disabled")?.deviceId;
        attempt.checkpoint();
        if (!currentMobileDeviceId) {
          throw new Error("请先完成 Mobile 配对。");
        }
        setMobileDeviceId(currentMobileDeviceId);
        const secret = await services.session.postJson<{
          realtimeSessionId: string;
          instructions: string;
          clientSecret: string;
          model: string;
          voice: string;
        }>(
          "/api/v1/realtime/client-secrets",
          buildMobileRealtimeBootstrapRequest(currentConversationId, currentMobileDeviceId),
          createMobileIdempotencyKey("mobile-realtime"));
        attempt.checkpoint();

        const transport = new ReactNativeWebRTCTransport({ boundary: createReactNativeWebRTCBoundary() });
        attempt.adopt(() => transport.close());
        const session = new RealtimeSession(createRealtimeAgent(secret.instructions, secret.voice), {
          transport,
          model: secret.model,
          historyStoreAudio: false,
          tracingDisabled: true
        });
        attempt.adopt(() => session.close());
        await session.connect({ apiKey: secret.clientSecret, model: secret.model });
        attempt.checkpoint();
        await services.registerVoiceSession(session, secret.realtimeSessionId, attempt);
        attempt.checkpoint();
        attempt.commit();
      });
      setVoiceActive(true);
      setVoiceMuted(false);
      setStatus("语音已连接");
    } catch (error) {
      await services.voice.stop().catch(() => undefined);
      await services.stopVoice().catch(() => undefined);
      setVoiceActive(false);
      setVoiceMuted(false);
      setStatus(error instanceof Error ? error.message : "语音连接失败");
    }
  }

  async function stopVoice(): Promise<void> {
    await services.voice.stop().catch(() => undefined);
    await services.stopVoice().catch(() => undefined);
    setVoiceActive(false);
    setVoiceMuted(false);
    setStatus("语音已停止");
  }

  async function logout(): Promise<void> {
    try {
      await services.logout();
      setPairingCode("");
      setConversationId(undefined);
      setMobileDeviceId(undefined);
      setDesktopDevices([]);
      setPreferredDeviceId(undefined);
      setVoiceActive(false);
      setVoiceMuted(false);
      syncFeedState();
      setStatus("已注销并撤销会话，请重新配对。");
    } catch (error) {
      setStatus(error instanceof MobileApiError && error.status === 503
        ? "撤销暂不可用，语音和本地订阅已停止；凭据仍保留，请稍后重试注销。"
        : "撤销未完成，语音和本地订阅已停止；请稍后重试注销。");
    }
  }

  async function setAudioOutputRoute(route: "system" | "speaker"): Promise<void> {
    try {
      await services.audio.setOutputRoute(route);
      setAudioPolicy(services.audio.requestedOutputPolicy);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "音频路由设置失败");
    }
  }

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>Jarvis Mobile</Text>
        <Text style={styles.status}>{status}</Text>
        <TextInput
          value={apiBaseUrlInput}
          onChangeText={setApiBaseUrlInput}
          placeholder="https://your-control-plane.example.com"
          style={styles.input}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
        />
        <Button title="保存 Control Plane 地址" onPress={() => void saveApiBaseUrl()} />
        <Text style={styles.hint}>物理手机请填写可达的 HTTPS 地址；127.0.0.1 仅供模拟器/开发机回环测试。</Text>
        <View style={styles.row}>
          <TextInput value={pairingCode} onChangeText={setPairingCode} placeholder="输入 Desktop 配对码" style={styles.input} secureTextEntry />
          <Button title="配对" onPress={() => void pair()} />
        </View>
        <Text>任务 {taskCount} · 通知 {notificationCount} · 待审批 {approvalCount}</Text>
        <Text>首选 Desktop：{preferredDeviceId ?? "未选择"}</Text>
        {desktopDevices.map(device => (
          <View key={device.deviceId} style={styles.taskRow}>
            <Text style={styles.feedText}>{device.name ?? device.deviceId} · {device.platform ?? "desktop"} · {device.status}</Text>
            <Button
              title={device.deviceId === preferredDeviceId ? "已选择" : "选择"}
              onPress={() => setPreferredDeviceId(device.deviceId)}
              disabled={device.deviceId === preferredDeviceId || device.status === "disabled"}
            />
          </View>
        ))}
        <TextInput value={draft} onChangeText={setDraft} placeholder="输入消息" style={styles.messageInput} multiline />
        <View style={styles.row}>
          <Button title="发送文字" onPress={() => void send()} />
          <Button title="开始语音" onPress={() => void startVoice()} />
        </View>
        <Text>
          语音：{voiceActive ? (voiceMuted ? "已静音" : "已连接") : "未连接"} ·
          期望路由：{audioPolicy} · 实际路由：{audioRoute}
        </Text>
        <View style={styles.row}>
          <Button
            title={voiceMuted ? "取消静音" : "静音"}
            onPress={() => {
              const next = !voiceMuted;
              services.muteVoice(next);
              setVoiceMuted(next);
            }}
            disabled={!voiceActive}
          />
          <Button title="打断回答" onPress={() => services.interruptVoice()} disabled={!voiceActive} />
          <Button title="扬声器" onPress={() => void setAudioOutputRoute("speaker")} disabled={!voiceActive} />
          <Button title="系统路由" onPress={() => void setAudioOutputRoute("system")} disabled={!voiceActive} />
          <Button title="停止语音" onPress={() => void stopVoice()} disabled={!voiceActive} />
        </View>
        <Button title="注销并撤销 Mobile 会话" onPress={() => void logout()} />
        <TextInput value={taskGoal} onChangeText={setTaskGoal} placeholder="任务目标（可委派给 Desktop）" style={styles.messageInput} multiline />
        <TextInput value={taskAllowedRoot} onChangeText={setTaskAllowedRoot} placeholder="Codex 读取根目录（可选，例如 /tmp/project）" style={styles.input} autoCapitalize="none" />
        <Button title="提交后台任务" onPress={() => void createTask()} disabled={taskBusy || !taskGoal.trim()} />
        {services.feed.tasks.map(task => (
          <View key={task.id} style={styles.taskRow}>
            <Text>{task.status} · {typeof task.goal === "string" ? task.goal : task.id}</Text>
            <Button title="取消" onPress={() => void cancelTask(task.id)} disabled={taskBusy} />
          </View>
        ))}
        <Text>通知中心</Text>
        {services.feed.notifications
          .filter(notification => notification.status !== "read" && notification.status !== "dismissed")
          .map(notification => (
            <View key={notification.id} style={styles.taskRow}>
              <View style={styles.feedText}>
                <Text>{typeof notification.title === "string" ? notification.title : "通知"}</Text>
                <Text>{typeof notification.body === "string" ? notification.body : ""}</Text>
              </View>
              <View style={styles.row}>
                <Button title="已读" onPress={() => void updateNotification(notification.id, "read")} />
                <Button title="忽略" onPress={() => void updateNotification(notification.id, "dismiss")} />
              </View>
            </View>
          ))}
        <Text>待审批</Text>
        {services.feed.approvals.map(approval => (
          <View key={approval.id} style={styles.taskRow}>
            <Text style={styles.feedText}>{typeof approval.reason === "string" ? approval.reason : approval.id}</Text>
            <View style={styles.row}>
              <Button title="批准本次" onPress={() => void decideApproval(approval.id, "approve")} />
              <Button title="拒绝" onPress={() => void decideApproval(approval.id, "deny")} />
            </View>
          </View>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#f6f7fb" },
  content: { padding: 24, gap: 16 },
  title: { fontSize: 28, fontWeight: "700" },
  status: { color: "#475569" },
  row: { flexDirection: "row", gap: 12, alignItems: "center" },
  input: { flex: 1, borderWidth: 1, borderColor: "#cbd5e1", borderRadius: 8, padding: 12, backgroundColor: "white" },
  messageInput: { minHeight: 96, borderWidth: 1, borderColor: "#cbd5e1", borderRadius: 8, padding: 12, backgroundColor: "white", textAlignVertical: "top" },
  hint: { color: "#64748b", fontSize: 12 },
  taskRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  feedText: { flex: 1 }
});

function buildQueryPath(path: string, query?: { cursor?: string; limit?: number }): string {
  const params = new URLSearchParams();
  params.set("limit", String(query?.limit ?? 100));
  if (query?.cursor) {
    params.set("cursor", query.cursor);
  }
  return `${path}?${params.toString()}`;
}
