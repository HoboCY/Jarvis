import type { components, paths } from "@jarvis/contracts-ts";

export type Phase0HealthResponse =
  paths["/api/v1/phase0/health"]["get"]["responses"][200]["content"]["application/json"];

export function phase0HealthUrl(baseUrl: string): string {
  return new URL("/api/v1/phase0/health", baseUrl).toString();
}

export async function getPhase0Health(baseUrl: string, fetcher: typeof fetch = fetch): Promise<Phase0HealthResponse> {
  const response = await fetcher(phase0HealthUrl(baseUrl));
  if (!response.ok) {
    throw new Error(`Phase 0 health request failed with ${response.status}.`);
  }

  return response.json() as Promise<Phase0HealthResponse>;
}

export type RealtimeClientSecretRequest =
  paths["/api/v1/realtime/client-secrets"]["post"]["requestBody"]["content"]["application/json"];
export type RealtimeClientSecretResponse =
  paths["/api/v1/realtime/client-secrets"]["post"]["responses"][200]["content"]["application/json"];
export type RealtimeSessionConnectedRequest =
  paths["/api/v1/realtime/sessions/{sessionId}/connected"]["post"]["requestBody"]["content"]["application/json"];
export type RealtimeSessionEndedRequest =
  paths["/api/v1/realtime/sessions/{sessionId}/ended"]["post"]["requestBody"]["content"]["application/json"];
export type RealtimeSessionResponse =
  paths["/api/v1/realtime/sessions/{sessionId}/connected"]["post"]["responses"][200]["content"]["application/json"];
export type RealtimeEventsIngestRequest =
  paths["/api/v1/conversations/{conversationId}/realtime-events:ingest"]["post"]["requestBody"]["content"]["application/json"];
export type RealtimeEventsIngestResponse =
  paths["/api/v1/conversations/{conversationId}/realtime-events:ingest"]["post"]["responses"][200]["content"]["application/json"];

export type DesktopDeviceBootstrapResponse =
  paths["/api/v1/realtime/desktop-device"]["post"]["responses"][200]["content"]["application/json"];

export type CreateTaskRequest =
  paths["/api/v1/tasks"]["post"]["requestBody"]["content"]["application/json"];
export type TaskAcceptedResponse =
  paths["/api/v1/tasks"]["post"]["responses"][202]["content"]["application/json"];
export type TaskResponse =
  paths["/api/v1/tasks/{taskId}"]["get"]["responses"][200]["content"]["application/json"];
export type TaskListResponse =
  paths["/api/v1/tasks"]["get"]["responses"][200]["content"]["application/json"];
export type TaskCancelResponse =
  paths["/api/v1/tasks/{taskId}/cancel"]["post"]["responses"][200]["content"]["application/json"];
export type TaskUserInputSubmissionRequest =
  paths["/api/v1/tasks/{taskId}/user-input"]["post"]["requestBody"] extends { content: { "application/json": infer T } }
    ? NonNullable<T>
    : never;
export type TaskUserInputSubmissionResponse =
  paths["/api/v1/tasks/{taskId}/user-input"]["post"]["responses"][200]["content"]["application/json"];
export type NotificationListResponse =
  paths["/api/v1/notifications"]["get"]["responses"][200]["content"]["application/json"];
export type NotificationResponse =
  paths["/api/v1/notifications/{notificationId}/read"]["post"]["responses"][200]["content"]["application/json"];
export type NotificationActionId = "acknowledge";
export type DeviceListResponse =
  paths["/api/v1/devices"]["get"]["responses"][200]["content"]["application/json"];
export type MobilePairingRequest =
  NonNullable<paths["/api/v1/mobile-pairings"]["post"]["requestBody"]>["content"]["application/json"];
export type MobilePairingResponse =
  paths["/api/v1/mobile-pairings"]["post"]["responses"][201]["content"]["application/json"];
export type MobilePairingExchangeRequest =
  NonNullable<paths["/api/v1/mobile-pairings/exchange"]["post"]["requestBody"]>["content"]["application/json"];
export type MobileSessionResponse =
  paths["/api/v1/mobile-pairings/exchange"]["post"]["responses"][200]["content"]["application/json"];
export type MobileSessionRefreshRequest =
  NonNullable<paths["/api/v1/mobile-sessions/refresh"]["post"]["requestBody"]>["content"]["application/json"];
export type MobileSessionRevokeResponse =
  paths["/api/v1/mobile-sessions/revoke"]["post"]["responses"][200]["content"]["application/json"];
export type DeviceSummary =
  components["schemas"]["DeviceSummaryResponse"];
export type ConversationResponse =
  paths["/api/v1/conversations/{conversationId}"]["get"]["responses"][200]["content"]["application/json"];
export type MessagePageResponse =
  paths["/api/v1/conversations/{conversationId}/messages"]["get"]["responses"][200]["content"]["application/json"];
export type TypedMessageRequest =
  paths["/api/v1/conversations/{conversationId}/messages/typed"]["post"]["requestBody"]["content"]["application/json"];
export type TypedMessageResponse =
  paths["/api/v1/conversations/{conversationId}/messages/typed"]["post"]["responses"][200]["content"]["application/json"];
export type ApprovalListResponse =
  paths["/api/v1/approvals"]["get"]["responses"][200]["content"]["application/json"];
export type ApprovalDecisionRequest =
  NonNullable<paths["/api/v1/approvals/{approvalId}/decision"]["post"]["requestBody"]>["content"]["application/json"];
export type ApprovalResponse =
  paths["/api/v1/approvals/{approvalId}/decision"]["post"]["responses"][200]["content"]["application/json"];
export type CreateMemoryFactRequest =
  paths["/api/v1/memory-facts"]["post"]["requestBody"]["content"]["application/json"];
export type MemoryFactSaveResponse =
  paths["/api/v1/memory-facts"]["post"]["responses"][200]["content"]["application/json"];
export type MemoryFactRetractResponse =
  paths["/api/v1/memory-facts/{memoryId}/retract"]["post"]["responses"][200]["content"]["application/json"];

export async function getDesktopDevice(
  baseUrl: string,
  idempotencyKey: string,
  options: ApiRequestOptions = {}
): Promise<DesktopDeviceBootstrapResponse> {
  return requestJson(
    new URL("/api/v1/realtime/desktop-device", baseUrl),
    {},
    idempotencyKey,
    options
  ) as Promise<DesktopDeviceBootstrapResponse>;
}

export async function createTask(
  baseUrl: string,
  request: CreateTaskRequest,
  idempotencyKey: string,
  options: ApiRequestOptions = {}
): Promise<TaskAcceptedResponse> {
  return requestJson(
    new URL("/api/v1/tasks", baseUrl),
    request,
    idempotencyKey,
    options
  ) as Promise<TaskAcceptedResponse>;
}

export async function createConversation(
  baseUrl: string,
  request: NonNullable<paths["/api/v1/conversations"]["post"]["requestBody"]>["content"]["application/json"],
  idempotencyKey: string,
  options: ApiRequestOptions = {}
): Promise<ConversationResponse> {
  return requestJson(new URL("/api/v1/conversations", baseUrl), request, idempotencyKey, options) as Promise<ConversationResponse>;
}

export async function getConversation(
  baseUrl: string,
  conversationId: string,
  options: ApiRequestOptions = {}
): Promise<ConversationResponse> {
  return requestGetJson(
    new URL(`/api/v1/conversations/${encodeURIComponent(conversationId)}`, baseUrl),
    options) as Promise<ConversationResponse>;
}

export async function getConversationMessages(
  baseUrl: string,
  conversationId: string,
  query: { cursor?: string; limit?: number | string } = {},
  options: ApiRequestOptions = {}
): Promise<MessagePageResponse> {
  const url = new URL(`/api/v1/conversations/${encodeURIComponent(conversationId)}/messages`, baseUrl);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }
  return requestGetJson(url, options) as Promise<MessagePageResponse>;
}

export async function addTypedConversationMessage(
  baseUrl: string,
  conversationId: string,
  request: TypedMessageRequest,
  idempotencyKey: string,
  options: ApiRequestOptions = {}
): Promise<TypedMessageResponse> {
  return requestJson(
    new URL(`/api/v1/conversations/${encodeURIComponent(conversationId)}/messages/typed`, baseUrl),
    request,
    idempotencyKey,
    options) as Promise<TypedMessageResponse>;
}

export async function listDevices(
  baseUrl: string,
  deviceType?: "desktop" | "mobile" | "server",
  options: ApiRequestOptions = {}
): Promise<DeviceListResponse> {
  const url = new URL("/api/v1/devices", baseUrl);
  if (deviceType) {
    url.searchParams.set("deviceType", deviceType);
  }
  return requestGetJson(url, options) as Promise<DeviceListResponse>;
}

export async function createMobilePairing(
  baseUrl: string,
  request: MobilePairingRequest,
  idempotencyKey: string,
  options: ApiRequestOptions = {}
): Promise<MobilePairingResponse> {
  return requestJson(new URL("/api/v1/mobile-pairings", baseUrl), request, idempotencyKey, options) as Promise<MobilePairingResponse>;
}

export async function exchangeMobilePairing(
  baseUrl: string,
  request: MobilePairingExchangeRequest,
  options: ApiRequestOptions = {}
): Promise<MobileSessionResponse> {
  return requestJson(new URL("/api/v1/mobile-pairings/exchange", baseUrl), request, undefined, options) as Promise<MobileSessionResponse>;
}

export async function refreshMobileSession(
  baseUrl: string,
  request: MobileSessionRefreshRequest,
  options: ApiRequestOptions = {}
): Promise<MobileSessionResponse> {
  return requestJson(new URL("/api/v1/mobile-sessions/refresh", baseUrl), request, undefined, options) as Promise<MobileSessionResponse>;
}

export async function revokeMobileSession(
  baseUrl: string,
  options: ApiRequestOptions = {}
): Promise<MobileSessionRevokeResponse> {
  return requestJson(new URL("/api/v1/mobile-sessions/revoke", baseUrl), {}, undefined, options) as Promise<MobileSessionRevokeResponse>;
}

export async function listPendingApprovals(
  baseUrl: string,
  options: ApiRequestOptions = {}
): Promise<ApprovalListResponse> {
  const url = new URL("/api/v1/approvals", baseUrl);
  url.searchParams.set("status", "pending");
  return requestGetJson(url, options) as Promise<ApprovalListResponse>;
}

export async function decideApproval(
  baseUrl: string,
  approvalId: string,
  request: ApprovalDecisionRequest,
  idempotencyKey: string,
  options: ApiRequestOptions = {}
): Promise<ApprovalResponse> {
  return requestJson(
    new URL(`/api/v1/approvals/${encodeURIComponent(approvalId)}/decision`, baseUrl),
    request,
    idempotencyKey,
    options) as Promise<ApprovalResponse>;
}

export async function getTask(
  baseUrl: string,
  taskId: string,
  options: ApiRequestOptions = {}
): Promise<TaskResponse> {
  return requestGetJson(
    new URL(`/api/v1/tasks/${encodeURIComponent(taskId)}`, baseUrl),
    options
  ) as Promise<TaskResponse>;
}

export async function listTasks(
  baseUrl: string,
  query: { conversationId?: string; status?: string; cursor?: string; limit?: number | string } = {},
  options: ApiRequestOptions = {}
): Promise<TaskListResponse> {
  const url = new URL("/api/v1/tasks", baseUrl);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }
  return requestGetJson(url, options) as Promise<TaskListResponse>;
}

export async function cancelTask(
  baseUrl: string,
  taskId: string,
  idempotencyKey: string,
  options: ApiRequestOptions = {}
): Promise<TaskCancelResponse> {
  return requestJson(
    new URL(`/api/v1/tasks/${encodeURIComponent(taskId)}/cancel`, baseUrl),
    {},
    idempotencyKey,
    options
  ) as Promise<TaskCancelResponse>;
}

export async function submitTaskUserInput(
  baseUrl: string,
  taskId: string,
  request: TaskUserInputSubmissionRequest,
  idempotencyKey: string,
  options: ApiRequestOptions = {}
): Promise<TaskUserInputSubmissionResponse> {
  return requestJson(
    new URL(`/api/v1/tasks/${encodeURIComponent(taskId)}/user-input`, baseUrl),
    request,
    idempotencyKey,
    options
  ) as Promise<TaskUserInputSubmissionResponse>;
}

export async function listUnreadNotifications(
  baseUrl: string,
  conversationId?: string,
  options: ApiRequestOptions = {}
): Promise<NotificationListResponse> {
  const url = new URL("/api/v1/notifications", baseUrl);
  url.searchParams.set("status", "unread");
  if (conversationId) {
    url.searchParams.set("conversationId", conversationId);
  }
  return requestGetJson(url, options) as Promise<NotificationListResponse>;
}

export async function markNotificationDelivered(
  baseUrl: string,
  notificationId: string,
  idempotencyKey: string,
  options: ApiRequestOptions = {}
): Promise<NotificationResponse> {
  return updateNotification(baseUrl, notificationId, "delivered", idempotencyKey, options);
}

export async function markNotificationRead(
  baseUrl: string,
  notificationId: string,
  idempotencyKey: string,
  options: ApiRequestOptions = {}
): Promise<NotificationResponse> {
  return updateNotification(baseUrl, notificationId, "read", idempotencyKey, options);
}

export async function dismissNotification(
  baseUrl: string,
  notificationId: string,
  idempotencyKey: string,
  options: ApiRequestOptions = {}
): Promise<NotificationResponse> {
  return updateNotification(baseUrl, notificationId, "dismiss", idempotencyKey, options);
}

export async function applyNotificationAction(
  baseUrl: string,
  notificationId: string,
  actionId: NotificationActionId,
  idempotencyKey: string,
  options: ApiRequestOptions = {}
): Promise<NotificationResponse> {
  return requestJson(
    new URL(`/api/v1/notifications/${encodeURIComponent(notificationId)}/actions/${encodeURIComponent(actionId)}`, baseUrl),
    {},
    idempotencyKey,
    options
  ) as Promise<NotificationResponse>;
}

export async function createMemoryFact(
  baseUrl: string,
  request: CreateMemoryFactRequest,
  idempotencyKey: string,
  options: ApiRequestOptions = {}
): Promise<MemoryFactSaveResponse> {
  return requestJson(
    new URL("/api/v1/memory-facts", baseUrl),
    request,
    idempotencyKey,
    options
  ) as Promise<MemoryFactSaveResponse>;
}

export async function retractMemoryFact(
  baseUrl: string,
  memoryId: string,
  idempotencyKey: string,
  options: ApiRequestOptions = {}
): Promise<MemoryFactRetractResponse> {
  return requestJson(
    new URL(`/api/v1/memory-facts/${encodeURIComponent(memoryId)}/retract`, baseUrl),
    {},
    idempotencyKey,
    options
  ) as Promise<MemoryFactRetractResponse>;
}

export interface ApiRequestOptions {
  fetcher?: typeof fetch;
  bearerToken?: string;
}

export async function createRealtimeClientSecret(
  baseUrl: string,
  request: RealtimeClientSecretRequest,
  idempotencyKey: string,
  options: ApiRequestOptions = {}
): Promise<RealtimeClientSecretResponse> {
  return requestJson(
    new URL("/api/v1/realtime/client-secrets", baseUrl),
    request,
    idempotencyKey,
    options
  ) as Promise<RealtimeClientSecretResponse>;
}

export async function markRealtimeSessionConnected(
  baseUrl: string,
  sessionId: string,
  request: RealtimeSessionConnectedRequest,
  idempotencyKey: string,
  options: ApiRequestOptions = {}
): Promise<RealtimeSessionResponse> {
  return requestJson(
    new URL(`/api/v1/realtime/sessions/${encodeURIComponent(sessionId)}/connected`, baseUrl),
    request,
    idempotencyKey,
    options
  ) as Promise<RealtimeSessionResponse>;
}

export async function markRealtimeSessionEnded(
  baseUrl: string,
  sessionId: string,
  request: RealtimeSessionEndedRequest,
  idempotencyKey: string,
  options: ApiRequestOptions = {}
): Promise<RealtimeSessionResponse> {
  return requestJson(
    new URL(`/api/v1/realtime/sessions/${encodeURIComponent(sessionId)}/ended`, baseUrl),
    request,
    idempotencyKey,
    options
  ) as Promise<RealtimeSessionResponse>;
}

export async function ingestRealtimeEvents(
  baseUrl: string,
  conversationId: string,
  request: RealtimeEventsIngestRequest,
  idempotencyKey: string,
  options: ApiRequestOptions = {}
): Promise<RealtimeEventsIngestResponse> {
  return requestJson(
    new URL(`/api/v1/conversations/${encodeURIComponent(conversationId)}/realtime-events:ingest`, baseUrl),
    request,
    idempotencyKey,
    options
  ) as Promise<RealtimeEventsIngestResponse>;
}

async function requestJson(
  url: URL,
  body: unknown,
  idempotencyKey: string | undefined,
  options: ApiRequestOptions
): Promise<unknown> {
  const fetcher = options.fetcher ?? fetch;
  const headers = new Headers({ "Content-Type": "application/json" });
  if (idempotencyKey) {
    headers.set("Idempotency-Key", idempotencyKey);
  }
  if (options.bearerToken) {
    headers.set("Authorization", `Bearer ${options.bearerToken}`);
  }

  const response = await fetcher(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    throw new Error(`Jarvis API request failed with ${response.status}.`);
  }

  return response.json();
}

async function requestGetJson(url: URL, options: ApiRequestOptions): Promise<unknown> {
  const headers = new Headers();
  if (options.bearerToken) {
    headers.set("Authorization", `Bearer ${options.bearerToken}`);
  }

  const response = await (options.fetcher ?? fetch)(url, { method: "GET", headers });
  if (!response.ok) {
    throw new Error(`Jarvis API request failed with ${response.status}.`);
  }

  return response.json();
}

async function updateNotification(
  baseUrl: string,
  notificationId: string,
  action: "delivered" | "read" | "dismiss",
  idempotencyKey: string,
  options: ApiRequestOptions
): Promise<NotificationResponse> {
  return requestJson(
    new URL(`/api/v1/notifications/${encodeURIComponent(notificationId)}/${action}`, baseUrl),
    {},
    idempotencyKey,
    options
  ) as Promise<NotificationResponse>;
}
