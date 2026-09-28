import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runLive } from "./live.mjs";

const scriptPath = fileURLToPath(new URL("./validate-live-evidence.mjs", import.meta.url));

test("validate-live-evidence CLI returns bounded JSON for a valid bundle", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-phase9b-validator-"));
  try {
    await mkdir(join(root, "repo"));
    await mkdir(join(root, "home"));
    await mkdir(join(root, "safe"));
    await chmod(join(root, "safe"), 0o700);
    const result = await runLive({
      repositoryRoot: join(root, "repo"),
      homeDirectory: join(root, "home"),
      baseDirectory: join(root, "safe"),
      baselineSha: "5df7533141107585cfbaa90a9c40d78a7b0b959a",
      candidateSha: "1111111111111111111111111111111111111111",
      preflightResult: {
        schemaVersion: 1,
        status: "BLOCKED_CREDENTIALS",
        mode: "offline",
        network: { providerCalls: 0 },
        checks: {
          platform: { status: "PASS", os: "darwin", arch: "arm64", osVersion: "15.6", errors: [] },
          toolchain: { status: "PASS", errors: [], codexSha256Matches: true },
          credentials: { status: "BLOCKED_CREDENTIALS", errors: ["MISSING_OPENAI_API_KEY"], presence: {} },
          provider: { status: "UNVERIFIED" }
        }
      }
    });
    const output = await runCli([join(root, "repo", "artifacts", "live", "phase9b", result.runId)]);
    assert.equal(output.exitCode, 0);
    assert.deepEqual(JSON.parse(output.stdout), {
      schemaVersion: 1,
      status: "PASS",
      runId: result.runId
    });
    assert.equal(output.stdout.includes(root), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function runCli(args) {
  return await new Promise((resolveResult) => {
    const child = spawn(process.execPath, [scriptPath, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.once("close", (exitCode) => resolveResult({ exitCode, stdout }));
  });
}
