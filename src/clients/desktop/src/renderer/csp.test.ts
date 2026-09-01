import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");

test("Desktop CSP allows Realtime WebRTC calls to Azure OpenAI resource origins", () => {
  const policy = html.match(/content="([^"]*connect-src[^"]*)"/)?.[1];

  assert.ok(policy, "Renderer Content-Security-Policy is missing.");
  assert.match(policy, /connect-src[^;]*https:\/\/\*\.openai\.azure\.com(?:\s|;)/);
});
