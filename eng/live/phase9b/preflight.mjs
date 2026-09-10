import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chmod, lstat, mkdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { loadProviderConfig } from "./credentials.mjs";
import { validateSecurityRemediationStatus } from "./evidence.mjs";
import { createOwnedTempRoot } from "./isolation.mjs";

const EXPECTED_TOOLCHAIN = Object.freeze({
  dotnetSdk: "10.0.100",
  node: "24.19.0",
  pnpm: "10.24.0",
  codex: "0.146.0",
  codexPlatform: "darwin-arm64",
  codexSha256: "ae1d3ffe6d48aec6a4dc3f50e7eb8e0d11962485a6a9406c5a7012139383da02"
});
const SAFE_VERSION_PATTERN = /^\d{1,4}(?:\.\d{1,4}){0,3}(?:[-+][A-Za-z0-9.-]{1,32})?$/;

export async function runPreflight({
  repositoryRoot = process.cwd(),
  homeDirectory = homedir(),
  env = process.env,
  versionsPath = join(repositoryRoot, "eng", "versions.json"),
  userSecretsPath,
  codexPath = env.PHASE9B_CODEX_PATH,
  platform = { platform: process.platform, arch: process.arch, osVersion: "unknown" },
  toolVersions,
  noProviderCall = true,
  providerProbe,
  securityRemediationStatus
} = {}) {
  const securityStatus = securityRemediationStatus === undefined
    ? "UNVERIFIED"
    : validateSecurityRemediationStatus(securityRemediationStatus);
  const securityGateBlocked = !noProviderCall
    && securityStatus !== "RESOLVED_NO_REUSABLE_CREDENTIAL_EXPOSURE";
  const checks = {
    platform: verifyPlatform(platform),
    toolchain: { status: "BLOCKED_TOOLCHAIN", errors: [] },
    credentials: { status: "BLOCKED_CREDENTIALS", errors: [], presence: {} },
    provider: { status: "UNVERIFIED" }
  };
  let versions;
  try {
    versions = parseVersions(await readFile(versionsPath, "utf8"));
  } catch {
    checks.toolchain.errors.push("INVALID_VERSIONS_FILE");
  }

  if (versions !== undefined) {
    checks.toolchain = await verifyToolchain({
      versions,
      codexPath,
      toolVersions,
      env,
      repositoryRoot,
      homeDirectory
    });
  }
  const credentialResult = await loadProviderConfig({
    repositoryRoot,
    homeDirectory,
    env,
    userSecretsPath
  });
  checks.credentials = {
    status: credentialResult.status,
    errors: credentialResult.errors.slice(0, 16),
    presence: { ...credentialResult.presence }
  };

  const network = { providerCalls: 0 };
  if (securityGateBlocked) {
    checks.provider = { status: "BLOCKED_SECURITY_REMEDIATION" };
  } else if (!noProviderCall
      && checks.platform.status === "PASS"
      && checks.toolchain.status === "PASS"
      && credentialResult.status === "PASS"
      && typeof providerProbe === "function") {
    try {
      await providerProbe(credentialResult.config);
      network.providerCalls = 1;
      checks.provider = { status: "PASS" };
    } catch {
      network.providerCalls = 1;
      checks.provider = { status: "BLOCKED_PROVIDER_ACCESS", errors: ["PROVIDER_PROBE_FAILED"] };
    }
  }

  const status = chooseStatus(checks, securityGateBlocked);
  return {
    schemaVersion: 1,
    status,
    mode: noProviderCall ? "offline" : "provider-call-enabled",
    securityRemediation: { status: securityStatus },
    network,
    checks
  };
}

export function parseVersions(text) {
  let versions;
  try {
    versions = JSON.parse(String(text).replace(/^\uFEFF/, ""));
  } catch {
    throw safeError("INVALID_VERSIONS_FILE", "Versions file is invalid.");
  }
  if (versions?.dotnetSdk !== EXPECTED_TOOLCHAIN.dotnetSdk
      || versions?.node !== EXPECTED_TOOLCHAIN.node
      || versions?.pnpm !== EXPECTED_TOOLCHAIN.pnpm
      || versions?.codex?.version !== EXPECTED_TOOLCHAIN.codex
      || versions?.codex?.platform !== EXPECTED_TOOLCHAIN.codexPlatform
      || versions?.codex?.sha256 !== EXPECTED_TOOLCHAIN.codexSha256) {
    throw safeError("INVALID_VERSIONS_FILE", "Versions file is not pinned.");
  }
  return versions;
}

export function verifyPlatform(platform) {
  const operatingSystem = platform?.platform ?? platform?.os;
  const valid = operatingSystem === "darwin" && platform?.arch === "arm64";
  return {
    status: valid ? "PASS" : "BLOCKED_TOOLCHAIN",
    os: valid ? "darwin" : "unsupported",
    arch: valid ? "arm64" : "unsupported",
    osVersion: boundedVersion(platform?.osVersion) ?? "unknown",
    errors: valid ? [] : ["PLATFORM_UNSUPPORTED"]
  };
}

export async function verifyToolchain({
  versions,
  codexPath,
  toolVersions,
  env = process.env,
  repositoryRoot = process.cwd(),
  homeDirectory = homedir()
} = {}) {
  const codexBinary = codexPath === undefined
    ? { valid: false, errorCategory: "CODEX_PATH_REQUIRED" }
    : await verifyCodexBinary(codexPath, versions.codex.sha256);
  const versionsFound = toolVersions ?? {
    node: process.versions.node,
    pnpm: await readCommandVersion("pnpm", ["--version"], env),
    dotnet: await readCommandVersion("dotnet", ["--version"], env),
    codex: codexPath === undefined || !codexBinary.valid
      ? null
      : await readCodexVersionIsolated(codexPath, { env, repositoryRoot, homeDirectory })
  };
  const errors = [];
  if (versionsFound.node !== versions.node) {
    errors.push("NODE_VERSION_MISMATCH");
  }
  if (versionsFound.pnpm !== versions.pnpm) {
    errors.push("PNPM_VERSION_MISMATCH");
  }
  if (versionsFound.dotnet !== versions.dotnetSdk) {
    errors.push("DOTNET_VERSION_MISMATCH");
  }
  if (versionsFound.codex !== versions.codex.version) {
    errors.push("CODEX_VERSION_MISMATCH");
  }
  if (!codexBinary.valid) {
    errors.push(codexBinary.errorCategory);
  }
  return {
    status: errors.length === 0 ? "PASS" : "BLOCKED_TOOLCHAIN",
    errors: [...new Set(errors)].slice(0, 16),
    codexSha256Matches: !errors.includes("CODEX_SHA256_MISMATCH")
  };
}

async function readCodexVersionIsolated(path, { env, repositoryRoot, homeDirectory }) {
  let root;
  try {
    root = await createOwnedTempRoot({ repositoryRoot, homeDirectory });
    const codexHome = join(root, "codex-home");
    await mkdir(codexHome, { mode: 0o700 });
    await chmod(codexHome, 0o700);
    return await readCommandVersion(path, ["--version"], {
      PATH: env?.PATH ?? process.env.PATH ?? "",
      CODEX_HOME: codexHome
    });
  } finally {
    if (root !== undefined) {
      await rm(root, { recursive: true, force: true }).catch(() => {});
    }
  }
}

export async function verifyCodexBinary(path, expectedSha256) {
  if (typeof path !== "string" || !isAbsolute(path)) {
    return { valid: false, errorCategory: "CODEX_PATH_REQUIRED" };
  }
  let metadata;
  try {
    metadata = await lstat(path);
  } catch {
    return { valid: false, errorCategory: "CODEX_BINARY_UNAVAILABLE" };
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o111) === 0) {
    return { valid: false, errorCategory: "CODEX_BINARY_UNSAFE" };
  }
  let bytes;
  try {
    bytes = await readFile(path);
  } catch {
    return { valid: false, errorCategory: "CODEX_BINARY_UNAVAILABLE" };
  }
  const actual = createHash("sha256").update(bytes).digest("hex");
  return actual === expectedSha256
    ? { valid: true, errorCategory: null }
    : { valid: false, errorCategory: "CODEX_SHA256_MISMATCH" };
}

export async function readCommandVersion(command, args, environment = process.env) {
  return await new Promise((resolveVersion) => {
    let output = "";
    let settled = false;
    let timeoutHandle;
    let killGraceHandle;
    const finish = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutHandle);
      clearTimeout(killGraceHandle);
      resolveVersion(value);
    };
    let child;
    try {
      const childEnvironment = {
        PATH: environment?.PATH ?? process.env.PATH ?? "",
        LANG: "C"
      };
      if (typeof environment?.CODEX_HOME === "string" && isAbsolute(environment.CODEX_HOME)) {
        childEnvironment.CODEX_HOME = environment.CODEX_HOME;
      }
      child = spawn(command, args, {
        stdio: ["ignore", "pipe", "ignore"],
        env: childEnvironment
      });
    } catch {
      finish(null);
      return;
    }
    timeoutHandle = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        // The child may have exited before its close event was delivered.
      }
      killGraceHandle = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // The child may have exited while the grace timer was pending.
        }
        finish(null);
      }, 1_000);
    }, 5_000);
    timeoutHandle.unref?.();
    child.stdout?.on("data", (chunk) => {
      if (output.length < 256) {
        output += String(chunk).slice(0, 256 - output.length);
      }
    });
    child.once("error", () => {
      finish(null);
    });
    child.once("close", (code) => {
      if (code !== 0) {
        finish(null);
        return;
      }
      const match = output.match(/\d{1,4}(?:\.\d{1,4}){0,3}(?:[-+][A-Za-z0-9.-]{1,32})?/);
      finish(match !== null && SAFE_VERSION_PATTERN.test(match[0]) ? match[0] : null);
    });
  });
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const result = await runPreflight(options);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result.status === "FAIL" || result.status.startsWith("BLOCKED") ? 1 : 0;
}

function parseArguments(argv) {
  const options = { noProviderCall: true };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") {
      continue;
    } else if (argument === "--no-provider-call") {
      options.noProviderCall = true;
    } else if (argument === "--provider-call") {
      options.noProviderCall = false;
    } else if (argument === "--codex-path" && typeof argv[index + 1] === "string") {
      options.codexPath = argv[++index];
    } else if (argument.startsWith("--codex-path=")) {
      options.codexPath = argument.slice("--codex-path=".length);
    } else {
      throw safeError("INVALID_PREFLIGHT_ARGUMENTS", "Preflight arguments are invalid.");
    }
  }
  return options;
}

function chooseStatus(checks, securityGateBlocked = false) {
  if (securityGateBlocked) {
    return "BLOCKED_SECURITY_REMEDIATION";
  }
  if (checks.credentials.status === "BLOCKED_CREDENTIALS") {
    return "BLOCKED_CREDENTIALS";
  }
  if (checks.platform.status !== "PASS" || checks.toolchain.status !== "PASS") {
    return "BLOCKED_TOOLCHAIN";
  }
  if (checks.credentials.status !== "PASS") {
    return checks.credentials.status;
  }
  if (checks.provider.status === "BLOCKED_PROVIDER_ACCESS") {
    return "BLOCKED_PROVIDER_ACCESS";
  }
  return checks.provider.status === "PASS" ? "PASS" : "UNVERIFIED";
}

function boundedVersion(value) {
  return typeof value === "string" && value.length <= 64 && !hasControlCharacters(value)
    ? value
    : null;
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

function safeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] !== undefined && resolve(process.argv[1]) === currentFile) {
  try {
    process.exitCode = await main();
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, status: "FAIL", errorCategory: error.code ?? "PREFLIGHT_FAILED", network: { providerCalls: 0 } })}\n`);
    process.exitCode = 1;
  }
}
