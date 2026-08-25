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
