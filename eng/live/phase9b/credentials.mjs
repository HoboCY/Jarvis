import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  canonicalEndpoint,
  DEFAULT_DEEPSEEK_BASE_URL,
  DEFAULT_OPENAI_BASE_URL,
  DEFAULT_REALTIME_VOICE,
  isAllowedDeepSeekEndpoint,
  isAllowedOpenAiEndpoint,
  isAzureHost,
  validateModelId
} from "./provider-policy.mjs";

const USER_SECRETS_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PROVIDER_FIELDS = Object.freeze({
  OpenAI: [
    "ApiKey",
    "AuthenticationMode",
    "BaseUrl",
    "RealtimeModel",
    "RealtimeVoice",
    "SafetyIdentifierSalt"
  ],
  Responses: ["Provider", "Model", "SummarizerModel"],
  DeepSeek: ["ApiKey", "BaseUrl"]
});

/**
 * Load only the provider portion of ASP.NET configuration.
 *
 * `config` is deliberately non-enumerable so a safe result can be logged or
 * serialized without accidentally copying a key. Callers that need to use a
 * credential must retain the returned object in trusted memory.
 */
export async function loadProviderConfig({
  repositoryRoot = process.cwd(),
  homeDirectory = homedir(),
  env = process.env,
  userSecretsPath
} = {}) {
  const result = {
    status: "PASS",
    errors: [],
    presence: {
      userSecretsFound: false,
      openAiApiKey: false,
      deepSeekApiKey: false
    }
  };

  let values = {};
  const sourceErrors = [];
  let userSecretsId;
  let secretsPath;
  try {
    const projectPath = join(resolve(repositoryRoot), "src", "backend", "Jarvis.Api", "Jarvis.Api.csproj");
    userSecretsId = parseUserSecretsId(await readFile(projectPath, "utf8"));
    secretsPath = userSecretsPath
      ? resolve(userSecretsPath)
      : join(resolve(homeDirectory), ".microsoft", "usersecrets", userSecretsId, "secrets.json");
    const text = await readFile(secretsPath, "utf8");
    values = parseProviderSecrets(text);
    result.presence.userSecretsFound = true;
  } catch (error) {
    if (!isMissingFile(error) || secretsPath === undefined) {
      sourceErrors.push("INVALID_PROVIDER_CONFIG");
    }
  }

  const merged = mergeProviderValues(values, env);
  const config = buildProviderConfig(merged);
  const errors = [...new Set([...sourceErrors, ...validateProviderConfig(config)])];
  result.errors.push(...errors);
  result.status = sourceErrors.length > 0
    ? "BLOCKED_PROVIDER_CONFIG"
    : errors.length > 0
      ? errors.some((error) => error.startsWith("MISSING_"))
        ? "BLOCKED_CREDENTIALS"
        : "BLOCKED_PROVIDER_CONFIG"
      : "PASS";
  result.presence.openAiApiKey = typeof config.openAi.apiKey === "string" && config.openAi.apiKey.length > 0;
  result.presence.deepSeekApiKey = typeof config.deepSeek.apiKey === "string" && config.deepSeek.apiKey.length > 0;
  if (userSecretsId !== undefined) {
    result.presence.userSecretsIdPresent = true;
  }

  Object.defineProperty(result, "config", {
    value: config,
    enumerable: false,
    writable: false
  });
  return result;
}

export function parseUserSecretsId(csprojText) {
  if (typeof csprojText !== "string") {
    throw new Error("INVALID_PROVIDER_CONFIG");
  }

  const match = csprojText.match(/<UserSecretsId>\s*([^<\s]+)\s*<\/UserSecretsId>/i);
  if (!match || !USER_SECRETS_ID_PATTERN.test(match[1])) {
    throw new Error("INVALID_PROVIDER_CONFIG");
  }

  return match[1];
}

export function parseProviderSecrets(text) {
  if (typeof text !== "string" || text.length > 256 * 1024) {
    throw new Error("INVALID_PROVIDER_CONFIG");
  }

  let parsed;
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    throw new Error("INVALID_PROVIDER_CONFIG");
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("INVALID_PROVIDER_CONFIG");
  }

  const values = {};
  for (const [section, fields] of Object.entries(PROVIDER_FIELDS)) {
    for (const field of fields) {
      const key = `${section}:${field}`;
      const value = lookupConfigValue(parsed, key);
      if (typeof value === "string" && value.trim().length > 0) {
        values[key] = value.trim();
      }
    }
  }
  return values;
}

export function mergeProviderValues(userSecrets, env) {
  const merged = { ...userSecrets };
  for (const [key, value] of Object.entries(env ?? {})) {
    const normalizedKey = normalizeEnvironmentKey(key);
    const canonicalKey = canonicalProviderKey(normalizedKey);
    if (canonicalKey === undefined || typeof value !== "string" || value.trim().length === 0) {
      continue;
    }
    merged[canonicalKey] = value.trim();
  }
  return merged;
}

export function buildProviderConfig(values) {
  const provider = values["Responses:Provider"];
  const openAiBaseUrl = values["OpenAI:BaseUrl"] ?? DEFAULT_OPENAI_BASE_URL;
  const deepSeekBaseUrl = values["DeepSeek:BaseUrl"] ?? DEFAULT_DEEPSEEK_BASE_URL;
  const openAiHost = safeHostname(openAiBaseUrl);
  const authenticationMode = values["OpenAI:AuthenticationMode"]
    ?? (openAiHost !== null && isAzureHost(openAiHost) ? "ApiKey" : "Bearer");

  return {
    openAi: {
      apiKey: values["OpenAI:ApiKey"],
      authenticationMode,
      baseUrl: canonicalEndpoint(openAiBaseUrl) ?? openAiBaseUrl,
      realtimeModel: values["OpenAI:RealtimeModel"],
      realtimeVoice: values["OpenAI:RealtimeVoice"] ?? DEFAULT_REALTIME_VOICE,
      safetyIdentifierSalt: values["OpenAI:SafetyIdentifierSalt"]
    },
    responses: {
      provider,
      model: values["Responses:Model"],
      summarizerModel: values["Responses:SummarizerModel"]
    },
    deepSeek: {
      apiKey: values["DeepSeek:ApiKey"],
      baseUrl: canonicalEndpoint(deepSeekBaseUrl) ?? deepSeekBaseUrl
    }
  };
}

export function validateProviderConfig(config) {
  const errors = [];
  const openAi = config?.openAi;
  const responses = config?.responses;
  const deepSeek = config?.deepSeek;

  if (!hasSecret(openAi?.apiKey)) {
    errors.push("MISSING_OPENAI_API_KEY");
  }
  if (!isAllowedOpenAiEndpoint(openAi?.baseUrl)) {
    errors.push("INVALID_OPENAI_ENDPOINT");
  }
  if (openAi?.authenticationMode !== "ApiKey" && openAi?.authenticationMode !== "Bearer") {
    errors.push("INVALID_OPENAI_AUTH_MODE");
  }
  if (isAzureHost(safeHostname(openAi?.baseUrl)) && openAi?.authenticationMode !== "ApiKey") {
    errors.push("AZURE_REQUIRES_API_KEY_AUTH");
  }
  if (!hasSecret(openAi?.realtimeModel)) {
    errors.push("MISSING_REALTIME_MODEL");
  } else if (!validateModelId(openAi?.realtimeModel, "OpenAI")) {
    errors.push("INVALID_REALTIME_MODEL");
  }
  if (!isBoundedText(openAi?.realtimeVoice, 64)) {
    errors.push("INVALID_REALTIME_VOICE");
  }

  if (!hasSecret(responses?.provider)) {
    errors.push("MISSING_RESPONSES_PROVIDER");
  } else if (responses?.provider !== "DeepSeek" && responses?.provider !== "OpenAI") {
    errors.push("UNSUPPORTED_RESPONSES_PROVIDER");
  }
  if (!hasSecret(responses?.model)) {
    errors.push("MISSING_RESPONSES_MODEL");
  } else if (!validateModelId(responses?.model, responses?.provider)) {
    errors.push("INVALID_RESPONSES_MODEL");
  }
  if (!hasSecret(responses?.summarizerModel)) {
    errors.push("MISSING_SUMMARIZER_MODEL");
  } else if (!validateModelId(responses?.summarizerModel, responses?.provider)) {
    errors.push("INVALID_SUMMARIZER_MODEL");
  }

  if (responses?.provider === "DeepSeek") {
    if (!hasSecret(deepSeek?.apiKey)) {
      errors.push("MISSING_DEEPSEEK_API_KEY");
    }
    if (!isAllowedDeepSeekEndpoint(deepSeek?.baseUrl)) {
      errors.push("INVALID_DEEPSEEK_ENDPOINT");
    }
  } else if (responses?.provider === "OpenAI" && !hasSecret(openAi?.apiKey)) {
    errors.push("MISSING_RESPONSES_API_KEY");
  }

  return [...new Set(errors)];
}

function lookupConfigValue(value, key) {
  const flat = Object.entries(value).find(([candidate]) => candidate.toLowerCase() === key.toLowerCase());
  if (flat !== undefined) {
    return flat[1];
  }

  const segments = key.split(":");
  let current = value;
  for (const segment of segments) {
    if (current === null || typeof current !== "object") {
      return undefined;
    }
    const entry = Object.entries(current).find(([candidate]) => candidate.toLowerCase() === segment.toLowerCase());
    if (entry === undefined) {
      return undefined;
    }
    current = entry[1];
  }
  return current;
}

function normalizeEnvironmentKey(key) {
  return String(key).replaceAll("__", ":");
}

function canonicalProviderKey(key) {
  for (const [section, fields] of Object.entries(PROVIDER_FIELDS)) {
    const match = fields.find((field) => `${section}:${field}`.toLowerCase() === key.toLowerCase());
    if (match !== undefined) {
      return `${section}:${match}`;
    }
  }
  return undefined;
}

function hasSecret(value) {
  return typeof value === "string"
    && value.trim().length > 0
    && value.length <= 4096
    && !hasControlCharacters(value);
}

function isBoundedText(value, maxLength) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maxLength
    && !hasControlCharacters(value);
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

function safeHostname(value) {
  if (typeof value !== "string") {
    return null;
  }
  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
}

function isMissingFile(error) {
  return error?.code === "ENOENT";
}
