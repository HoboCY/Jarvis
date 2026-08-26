import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const labelPattern = /^com\.hobocy\.jarvis\.[A-Za-z0-9][A-Za-z0-9.-]{0,80}$/;
const sensitivePattern = /bearer|secret|token|credential|api[_-]?key/i;
const serviceNotFoundPattern = /^(?:Could not find service "[^"]+" in domain for system|Bad request\. Could not find service "[^"]+" in domain for user gui: \d+)$/;

export function assertSafeServiceLabel(label) {
  if (typeof label !== "string" || !labelPattern.test(label) || label.includes("..")) {
    throw new Error("Service label must be a bounded com.hobocy.jarvis.* label.");
  }
  return label;
}

export function buildServicePaths(root, label) {
  assertSafeServiceLabel(label);
  if (typeof root !== "string" || !isAbsolute(root) || resolve(root) === "/") {
    throw new Error("Service root must be an explicit absolute directory other than '/'.");
  }
  const normalizedRoot = resolve(root);
  return {
    root: normalizedRoot,
    plist: join(normalizedRoot, `${label}.plist`),
    data: join(normalizedRoot, "data", label),
    logs: join(normalizedRoot, "logs", label)
  };
}

export function renderLaunchdPlist(template, values) {
  if (typeof (values.apiPort ?? "5000") !== "string" || !/^\d{2,5}$/.test(values.apiPort ?? "5000")) {
    throw new Error("Service API port must be a bounded numeric port.");
  }
  const replacements = {
    LABEL: values.label,
    EXECUTABLE: values.executable,
    WORKING_DIRECTORY: values.workingDirectory,
    DATA_DIRECTORY: values.dataDirectory,
    LOG_DIRECTORY: values.logDirectory,
    API_PORT: values.apiPort ?? "5000"
  };
  for (const [name, value] of Object.entries(replacements)) {
    if (typeof value !== "string" || value.length === 0 || sensitivePattern.test(value)) {
      throw new Error(`Service template contains an unsafe credential or ${name} value.`);
    }
    template = template.replaceAll(`__${name}__`, escapeXml(value));
  }
  if (/__[A-Z0-9_]+__/.test(template)) {
    throw new Error("Service template contains unresolved variables.");
  }
  return template;
}

export function launchdDomain(uid = userInfo().uid) {
  if (!Number.isInteger(uid) || uid < 1) {
    throw new Error("A real user uid is required for launchd service operations.");
  }
  return `gui/${uid}`;
}

export function launchctl(args, { dryRun = false } = {}) {
  if (dryRun) {
    return { status: 0, stdout: `dry-run launchctl ${args.join(" ")}`, stderr: "" };
  }
  if (process.platform !== "darwin") {
    throw new Error("launchd service operations require macOS; use --dry-run on other platforms.");
  }
  const result = spawnSync("launchctl", args, {
    encoding: "utf8",
    timeout: 5_000,
    killSignal: "SIGKILL"
  });
  if (result.status !== 0) {
    const error = new Error(result.stderr || `launchctl exited with ${result.status}.`);
    error.stderr = result.stderr;
    error.status = result.status;
    throw error;
  }
  return result;
}

export function isServiceNotFoundError(error) {
  const value = typeof error?.stderr === "string"
    ? error.stderr
    : typeof error?.message === "string" ? error.message : "";
  return serviceNotFoundPattern.test(value.trim().replace(/\s+/g, " "));
}

export async function installService({
  root,
  label,
  executable,
  workingDirectory,
  templatePath,
  apiPort = "5000",
  dryRun = false,
  launchctlRunner = launchctl
}) {
  const paths = buildServicePaths(root, label);
  assertAbsolutePath(executable, "executable");
  assertAbsolutePath(workingDirectory, "workingDirectory");
  const template = await readFile(templatePath, "utf8");
  const rendered = renderLaunchdPlist(template, {
    label,
    executable,
    workingDirectory,
    dataDirectory: paths.data,
    logDirectory: paths.logs,
    apiPort
  });
  stopExistingService(label, paths.plist, dryRun, launchctlRunner);
  await mkdir(paths.data, { recursive: true, mode: 0o700 });
  await mkdir(paths.logs, { recursive: true, mode: 0o700 });
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  await writeFile(paths.plist, rendered, { mode: 0o600 });
  await chmod(paths.plist, 0o600);
  launchctlRunner(["bootstrap", launchdDomain(), paths.plist], { dryRun });
  return paths;
}

export async function uninstallService({ root, label, dryRun = false, launchctlRunner = launchctl }) {
  const paths = buildServicePaths(root, label);
  stopExistingService(label, paths.plist, dryRun, launchctlRunner);
  if (!dryRun) {
    await rm(paths.plist, { force: true });
  }
  return paths;
}

export function statusService({ root, label, dryRun = false }) {
  buildServicePaths(root, label);
  return launchctl(["print", `${launchdDomain()}/${label}`], { dryRun });
}

export function smokeService({ root, label, dryRun = false }) {
  const paths = buildServicePaths(root, label);
  const result = launchctl(["print", `${launchdDomain()}/${label}`], { dryRun });
  return { paths, result };
}

function assertAbsolutePath(value, name) {
  if (typeof value !== "string" || !isAbsolute(value) || sensitivePattern.test(value)) {
    throw new Error(`${name} must be an explicit absolute path without credentials.`);
  }
}

function stopExistingService(label, plist, dryRun, launchctlRunner) {
  const domain = launchdDomain();
  try {
    launchctlRunner(["print", `${domain}/${label}`], { dryRun });
  } catch (error) {
    if (isServiceNotFoundError(error)) {
      return;
    }
    throw error;
  }

  launchctlRunner(["bootout", domain, plist], { dryRun });
}

function escapeXml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] !== undefined && resolve(process.argv[1]) === currentFile) {
  console.error("Use the explicit publish/install wrapper scripts; launchd-service.mjs is a library entrypoint.");
  process.exitCode = 2;
}
