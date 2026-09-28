const OPENAI_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DEEPSEEK_MODEL_PATTERN = /^deepseek-[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/i;

export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/";
export const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com/";
export const DEFAULT_REALTIME_MODEL = "gpt-4o-realtime-preview";
export const DEFAULT_REALTIME_VOICE = "alloy";
export const DEFAULT_RESPONSES_PROVIDER = "DeepSeek";
export const DEFAULT_DEEPSEEK_MODEL = "deepseek-v4-flash";

export function isAllowedOpenAiEndpoint(value) {
  const url = parseHttpsEndpoint(value);
  if (url === null || url.port !== "" && url.port !== "443") {
    return false;
  }

  const hostname = url.hostname.toLowerCase();
  return hostname === "api.openai.com"
    || isAzureHost(hostname);
}

export function isAzureHost(hostname) {
  const normalized = String(hostname).toLowerCase();
  return isSubdomainOf(normalized, "openai.azure.com")
    || isSubdomainOf(normalized, "cognitiveservices.azure.com")
    || isSubdomainOf(normalized, "services.ai.azure.com");
}

export function isAllowedDeepSeekEndpoint(value) {
  const url = parseHttpsEndpoint(value);
  return url !== null
    && url.hostname.toLowerCase() === "api.deepseek.com"
    && (url.port === "" || url.port === "443")
    && url.pathname === "/";
}

export function validateModelId(value, provider = "OpenAI") {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    return false;
  }

  return provider === "DeepSeek"
    ? DEEPSEEK_MODEL_PATTERN.test(value)
    : OPENAI_MODEL_PATTERN.test(value);
}

export function validateProviderEndpoint(provider, value) {
  return provider === "DeepSeek"
    ? isAllowedDeepSeekEndpoint(value)
    : isAllowedOpenAiEndpoint(value);
}

export function canonicalEndpoint(value) {
  const url = parseHttpsEndpoint(value);
  return url === null ? null : url.toString();
}

function parseHttpsEndpoint(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 300) {
    return null;
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if (url.protocol !== "https:" || url.username !== "" || url.password !== ""
      || url.search !== "" || url.hash !== "") {
    return null;
  }

  const path = url.pathname;
  if (path.includes("..") || hasControlCharacters(path)) {
    return null;
  }

  return url;
}

function hasControlCharacters(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function isSubdomainOf(hostname, suffix) {
  return hostname.endsWith(`.${suffix}`)
    && hostname.length > suffix.length + 1
    && !hostname.includes("..");
}
