import type { paths } from "@jarvis/contracts-ts";

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
  idempotencyKey: string,
  options: ApiRequestOptions
): Promise<unknown> {
  const fetcher = options.fetcher ?? fetch;
  const headers = new Headers({
    "Content-Type": "application/json",
    "Idempotency-Key": idempotencyKey
  });
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
