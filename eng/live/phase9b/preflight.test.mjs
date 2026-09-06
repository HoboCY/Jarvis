import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runPreflight, verifyToolchain } from "./preflight.mjs";

const expectedVersions = {
  dotnetSdk: "10.0.100",
  node: "24.19.0",
  pnpm: "10.24.0",
  codex: {
    version: "0.146.0",
    platform: "darwin-arm64",
    sha256: ""
  }
};

test("offline preflight checks pinned tools and credentials without network access", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-phase9b-preflight-"));
  const repositoryRoot = join(root, "repo");
  const homeDirectory = join(root, "home");
  const codexPath = join(root, "codex");
  const versionsPath = join(root, "versions.json");
  const codexBytes = Buffer.from("pinned codex fixture\n");
  expectedVersions.codex.sha256 = createHash("sha256").update(codexBytes).digest("hex");
  try {
    await mkdir(join(repositoryRoot, "src", "backend", "Jarvis.Api"), { recursive: true });
    await mkdir(homeDirectory);
    await writeFile(
      join(repositoryRoot, "src", "backend", "Jarvis.Api", "Jarvis.Api.csproj"),
      "<Project><PropertyGroup><UserSecretsId>phase9b-test</UserSecretsId></PropertyGroup></Project>"
    );
    await writeFile(codexPath, codexBytes, { mode: 0o700 });
    await writeFile(versionsPath, JSON.stringify(expectedVersions));
    let providerCall = false;
    const result = await runPreflight({
      repositoryRoot,
      homeDirectory,
      versionsPath,
      codexPath,
      platform: { platform: "darwin", arch: "arm64", osVersion: "15.6" },
      toolVersions: { node: "24.19.0", pnpm: "10.24.0", dotnet: "10.0.100", codex: "0.146.0" },
      env: {},
      noProviderCall: true,
      providerProbe: async () => {
        providerCall = true;
      }
    });

    assert.equal(result.status, "BLOCKED_CREDENTIALS");
    assert.equal(result.network.providerCalls, 0);
    assert.equal(providerCall, false);
    assert.equal(result.checks.toolchain.status, "BLOCKED_TOOLCHAIN");
    assert.equal(result.checks.credentials.status, "BLOCKED_CREDENTIALS");
    assert.equal(JSON.stringify(result).includes("phase9b-test"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preflight refuses an unpinned Codex path without revealing its path", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-phase9b-preflight-codex-"));
  try {
    const result = await runPreflight({
      repositoryRoot: process.cwd(),
      homeDirectory: root,
      env: {},
      platform: { platform: "darwin", arch: "arm64", osVersion: "15.6" },
      toolVersions: { node: "24.19.0", pnpm: "10.24.0", dotnet: "10.0.100", codex: "0.146.0" },
      codexPath: join(root, "missing-codex"),
      noProviderCall: true
    });
    assert.equal(result.checks.toolchain.status, "BLOCKED_TOOLCHAIN");
    assert.equal(JSON.stringify(result).includes(root), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("provider probes require every offline gate to pass", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-phase9b-preflight-probe-"));
  const repositoryRoot = join(root, "repo");
  const homeDirectory = join(root, "home");
  const secretsDirectory = join(
    homeDirectory,
    ".microsoft",
    "usersecrets",
    "probe-test"
  );
  try {
    await mkdir(join(repositoryRoot, "src", "backend", "Jarvis.Api"), { recursive: true });
    await mkdir(secretsDirectory, { recursive: true });
    await writeFile(
      join(repositoryRoot, "src", "backend", "Jarvis.Api", "Jarvis.Api.csproj"),
      "<Project><PropertyGroup><UserSecretsId>probe-test</UserSecretsId></PropertyGroup></Project>"
    );
    await writeFile(join(secretsDirectory, "secrets.json"), JSON.stringify({
      "OpenAI:ApiKey": "openai-key",
      "OpenAI:RealtimeModel": "gpt-realtime-2.1-mini",
      "Responses:Provider": "DeepSeek",
      "Responses:Model": "deepseek-v4-flash",
      "Responses:SummarizerModel": "deepseek-v4-flash",
      "DeepSeek:ApiKey": "deepseek-key"
    }));
    let providerCalls = 0;
    const result = await runPreflight({
      repositoryRoot,
      homeDirectory,
      versionsPath: join(process.cwd(), "eng", "versions.json"),
      env: {},
      platform: { platform: "darwin", arch: "arm64", osVersion: "15.6" },
      toolVersions: { node: "24.19.0", pnpm: "10.24.0", dotnet: "10.0.100", codex: "0.146.0" },
      noProviderCall: false,
      providerProbe: async () => {
        providerCalls += 1;
      }
    });
    assert.equal(result.checks.credentials.status, "PASS");
    assert.equal(result.checks.toolchain.status, "BLOCKED_TOOLCHAIN");
    assert.equal(result.checks.provider.status, "UNVERIFIED");
    assert.equal(providerCalls, 0);
    assert.equal(result.network.providerCalls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex version probing uses a disposable CODEX_HOME", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-phase9b-preflight-home-"));
  const bin = join(root, "bin");
  const homeDirectory = join(root, "home");
  const sentinel = join(root, "observed-codex-home.txt");
  await mkdir(bin);
  await mkdir(homeDirectory);
  const writeProbe = async (name, body) => {
    const text = `#!/bin/sh\n${body}\n`;
    await writeFile(join(bin, name), text, { mode: 0o700 });
    return text;
  };
  await writeProbe("pnpm", "printf '%s\\n' '10.24.0'");
  await writeProbe("dotnet", "printf '%s\\n' '10.0.100'");
  const codexText = await writeProbe(
    "codex",
    `printf '%s' "$CODEX_HOME" > '${sentinel}'\nprintf '%s\\n' '0.146.0'`
  );
  try {
    const result = await verifyToolchain({
      versions: {
        node: process.versions.node,
        pnpm: "10.24.0",
        dotnetSdk: "10.0.100",
        codex: {
          version: "0.146.0",
          sha256: createHash("sha256").update(codexText).digest("hex")
        }
      },
      codexPath: join(bin, "codex"),
      env: { PATH: bin },
      repositoryRoot: join(root, "repo"),
      homeDirectory
    });
    assert.equal(result.status, "PASS");
    const observed = await readFile(sentinel, "utf8");
    assert.notEqual(observed, homeDirectory);
    assert.equal(observed.startsWith(root), false);
    await assert.rejects(() => stat(observed), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an unpinned Codex binary is hashed before version execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-phase9b-preflight-hash-order-"));
  const bin = join(root, "bin");
  const sentinel = join(root, "executed");
  await mkdir(bin);
  try {
    const codexPath = join(bin, "codex");
    const untrusted = "#!/bin/sh\nprintf '%s' executed > '" + sentinel + "'\nprintf '%s\\n' 0.146.0\n";
    await writeFile(codexPath, untrusted, { mode: 0o700 });
    await writeFile(join(bin, "pnpm"), "#!/bin/sh\nprintf '%s\\n' 10.24.0\n", { mode: 0o700 });
    await writeFile(join(bin, "dotnet"), "#!/bin/sh\nprintf '%s\\n' 10.0.100\n", { mode: 0o700 });
    const result = await verifyToolchain({
      versions: {
        node: process.versions.node,
        pnpm: "10.24.0",
        dotnetSdk: "10.0.100",
        codex: { version: "0.146.0", sha256: createHash("sha256").update("pinned").digest("hex") }
      },
      codexPath,
      env: { PATH: bin },
      repositoryRoot: join(root, "repo"),
      homeDirectory: join(root, "home")
    });
    assert.equal(result.status, "BLOCKED_TOOLCHAIN");
    assert.equal(result.errors.includes("CODEX_SHA256_MISMATCH"), true);
    await assert.rejects(() => stat(sentinel), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
