const defaultBackendBaseUrl = "http://127.0.0.1:5004";

export function resolveBackendBaseUrl(
  environment: NodeJS.ProcessEnv = process.env
): string {
  return environment.JARVIS_API_BASE_URL ?? defaultBackendBaseUrl;
}
