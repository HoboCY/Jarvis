import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  buildProviderConfig,
  mergeProviderValues,
  validateProviderConfig
} from "./credentials.mjs";
import {
  isAllowedDeepSeekEndpoint,
  isAllowedOpenAiEndpoint
} from "./provider-policy.mjs";

test("provider endpoint policy accepts official HTTPS hosts only", () => {
  assert.equal(isAllowedOpenAiEndpoint("https://api.openai.com/"), true);
  assert.equal(isAllowedOpenAiEndpoint("https://westus.openai.azure.com/openai/v1"), true);
  assert.equal(isAllowedOpenAiEndpoint("https://resource.cognitiveservices.azure.com/openai/v1"), true);
  assert.equal(isAllowedOpenAiEndpoint("https://westus.openai.azure.com.evil.example/"), false);
  assert.equal(isAllowedOpenAiEndpoint("http://westus.openai.azure.com/openai/v1"), false);
  assert.equal(isAllowedOpenAiEndpoint("https://api.openai.test/"), false);
  assert.equal(isAllowedDeepSeekEndpoint("https://api.deepseek.com/"), true);
  assert.equal(isAllowedDeepSeekEndpoint("https://api.deepseek.com/v1"), false);
  assert.equal(isAllowedDeepSeekEndpoint("https://api.deepseek.com.evil.example/"), false);
});

test("ASP.NET double underscore environment keys override secrets without reading unrelated values", () => {
  const merged = mergeProviderValues(
    {
      "OpenAI:ApiKey": "secret-openai",
      "DeepSeek:ApiKey": "secret-deepseek",
      "Responses:Provider": "DeepSeek"
    },
    {
      OPENAI__APIKEY: "env-openai",
      Responses__Provider: "DeepSeek",
      OPENAI_API_KEY: "must-be-ignored",
      ConnectionStrings__Jarvis: "Data Source=private.db",
      JARVIS_LOCAL_BEARER: "private-bearer"
    }
  );

  assert.equal(merged["OpenAI:ApiKey"], "env-openai");
  assert.equal(merged["ConnectionStrings:Jarvis"], undefined);
  assert.equal(merged["JARVIS_LOCAL_BEARER"], undefined);
  assert.equal(merged["OPENAI_API_KEY"], undefined);
});

test("invalid provider endpoint is blocked without substitution", () => {
  const config = buildProviderConfig({
    "OpenAI:ApiKey": "openai-key",
    "OpenAI:BaseUrl": "https://attacker.example/",
    "OpenAI:AuthenticationMode": "ApiKey",
    "OpenAI:RealtimeModel": "gpt-realtime-2.1-mini",
    "OpenAI:RealtimeVoice": "alloy",
    "Responses:Provider": "DeepSeek",
    "Responses:Model": "deepseek-v4-flash",
    "Responses:SummarizerModel": "deepseek-v4-flash",
    "DeepSeek:ApiKey": "deepseek-key",
    "DeepSeek:BaseUrl": "https://api.deepseek.com/"
  });

  assert.equal(config.openAi.baseUrl, "https://attacker.example/");
  assert.ok(validateProviderConfig(config).includes("INVALID_OPENAI_ENDPOINT"));
});

test("provider authentication mode is explicit and bounded", () => {
  const config = buildProviderConfig({
    "OpenAI:ApiKey": "openai-key",
    "OpenAI:AuthenticationMode": "Basic",
    "OpenAI:RealtimeModel": "gpt-realtime-2.1-mini",
    "OpenAI:RealtimeVoice": "alloy",
    "Responses:Provider": "DeepSeek",
    "Responses:Model": "deepseek-v4-flash",
    "Responses:SummarizerModel": "deepseek-v4-flash",
    "DeepSeek:ApiKey": "deepseek-key"
  });

  assert.ok(validateProviderConfig(config).includes("INVALID_OPENAI_AUTH_MODE"));
});
