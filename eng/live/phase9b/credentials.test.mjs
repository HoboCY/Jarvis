import { strict as assert } from "node:assert";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadProviderConfig } from "./credentials.mjs";

test("missing provider credentials are blocked without a provider call", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-phase9b-credentials-"));
  const secretsHome = join(root, "home");
  const secretsDirectory = join(
    secretsHome,
    ".microsoft",
    "usersecrets",
    "Jarvis.Api-e06d4bd7-6d95-4129-9f28-cc7520010f9f"
  );
  try {
    await mkdir(secretsDirectory, { recursive: true });
    await writeFile(
      join(secretsDirectory, "secrets.json"),
      "\ufeff{\"OpenAI:RealtimeModel\":\"gpt-realtime-2.1-mini\",\"Responses:Provider\":\"DeepSeek\",\"Responses:Model\":\"deepseek-v4-flash\",\"Responses:SummarizerModel\":\"deepseek-v4-flash\"}\n",
      { mode: 0o600 }
    );

    const result = await loadProviderConfig({
      repositoryRoot: process.cwd(),
      homeDirectory: secretsHome,
      env: {},
      fetchImpl: async () => {
        throw new Error("network must not be called");
      }
    });

    assert.equal(result.status, "BLOCKED_CREDENTIALS");
    assert.deepEqual(result.errors, ["MISSING_OPENAI_API_KEY", "MISSING_DEEPSEEK_API_KEY"]);
    assert.equal(Object.hasOwn(result, "database"), false);
    assert.equal(Object.hasOwn(result, "localBearer"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid User Secrets source remains blocked even when environment values are present", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-phase9b-credentials-invalid-"));
  const secretsHome = join(root, "home");
  const secretsDirectory = join(
    secretsHome,
    ".microsoft",
    "usersecrets",
    "Jarvis.Api-e06d4bd7-6d95-4129-9f28-cc7520010f9f"
  );
  try {
    await mkdir(secretsDirectory, { recursive: true });
    await writeFile(join(secretsDirectory, "secrets.json"), "{invalid", { mode: 0o600 });
    const result = await loadProviderConfig({
      repositoryRoot: process.cwd(),
      homeDirectory: secretsHome,
      env: {
        OpenAI__ApiKey: "openai-key",
        OpenAI__RealtimeModel: "gpt-realtime-2.1-mini",
        Responses__Provider: "DeepSeek",
        Responses__Model: "deepseek-v4-flash",
        Responses__SummarizerModel: "deepseek-v4-flash",
        DeepSeek__ApiKey: "deepseek-key"
      }
    });
    assert.equal(result.status, "BLOCKED_PROVIDER_CONFIG");
    assert.ok(result.errors.includes("INVALID_PROVIDER_CONFIG"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("provider environment values do not bypass a missing API project identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-phase9b-credentials-project-"));
  try {
    const result = await loadProviderConfig({
      repositoryRoot: join(root, "missing-repo"),
      homeDirectory: join(root, "home"),
      env: {
        OpenAI__ApiKey: "openai-key",
        OpenAI__RealtimeModel: "gpt-realtime-2.1-mini",
        Responses__Provider: "DeepSeek",
        Responses__Model: "deepseek-v4-flash",
        Responses__SummarizerModel: "deepseek-v4-flash",
        DeepSeek__ApiKey: "deepseek-key"
      }
    });
    assert.equal(result.status, "BLOCKED_PROVIDER_CONFIG");
    assert.deepEqual(result.errors, ["INVALID_PROVIDER_CONFIG"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
