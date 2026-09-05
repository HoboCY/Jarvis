import { spawn } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const desktopRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));
const repositoryRoot = resolve(desktopRoot, "../../..");
const canonicalDistRoot = resolve(desktopRoot, "dist");
const scenarioScript = fileURLToPath(new URL("./renderer-scenario.mjs", import.meta.url));
const temporaryRoot = resolve(tmpdir());
const userDataPrefix = "jarvis-desktop-scenario-";
const electronBinary = join(
  repositoryRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "electron.cmd" : "electron");
const scenarioOutput = process.env.JARVIS_DESKTOP_SCENARIO_OUTPUT
  ? resolve(process.env.JARVIS_DESKTOP_SCENARIO_OUTPUT)
  : undefined;
const watchdogMs = 28_000;
const forceKillGraceMs = 1_500;
const shutdownGraceMs = 500;
const processGroupDrainMs = 3_000;
const maxCapturedStderrBytes = 32 * 1024;
const maxObservationBytes = 512 * 1024;

let userDataPath;
let scenarioHandoffPath;
let child;
let childPromise;
let childExited = false;
let timedOut = false;
let signalExitCode;
let stdout = Buffer.alloc(0);
let stderr = Buffer.alloc(0);

function assertOwnedScenarioPath(path) {
  const resolvedPath = resolve(path);
  const relativePath = relative(temporaryRoot, resolvedPath);
  if (dirname(resolvedPath) !== temporaryRoot
    || !basename(resolvedPath).startsWith(userDataPrefix)
    || relativePath.length === 0
    || relativePath.startsWith("..")
    || relativePath.includes("..")) {
    throw new Error("Refusing to operate on a non-scenario userData path.");
  }
  return resolvedPath;
}

async function createScenarioUserData() {
  userDataPath = assertOwnedScenarioPath(await mkdtemp(join(temporaryRoot, userDataPrefix)));
  scenarioHandoffPath = join(userDataPath, "scenario-observation.json");
  await chmod(userDataPath, 0o700);
  const mode = (await stat(userDataPath)).mode & 0o777;
  if (mode !== 0o700) {
    throw new Error(`Scenario userData must be owner-only; received mode ${mode.toString(8)}.`);
  }
  await mkdir(join(userDataPath, "Cache"), { recursive: true, mode: 0o700 });
  await chmod(join(userDataPath, "Cache"), 0o700);
}

async function removeScenarioUserData() {
  if (typeof userDataPath !== "string") {
    return false;
  }

  const ownedPath = assertOwnedScenarioPath(userDataPath);
  await rm(ownedPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  return !existsSync(ownedPath);
}

function ownedProcessGroupExists() {
  if (!child?.pid) {
    return false;
  }

  if (process.platform === "win32") {
    return !childExited;
  }

  try {
    process.kill(-child.pid, 0);
    return true;
  } catch {
    return false;
  }
}

function terminateElectron(signal) {
  if (!child || !child.pid || (childExited && !ownedProcessGroupExists())) {
    return;
  }

  try {
    if (process.platform !== "win32") {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The child may have exited between the checks and the signal.
    }
  }
}

async function waitForOwnedProcessGroupExit() {
  if (!child?.pid) {
    return true;
  }

  const deadline = Date.now() + processGroupDrainMs;
  while (ownedProcessGroupExists() && Date.now() < deadline) {
    await wait(50);
  }

  if (ownedProcessGroupExists()) {
    terminateElectron("SIGKILL");
    const killDeadline = Date.now() + forceKillGraceMs;
    while (ownedProcessGroupExists() && Date.now() < killDeadline) {
      await wait(50);
    }
  }

  return !ownedProcessGroupExists();
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForOwnedAppProcessesExit(pids) {
  const ownedPids = [...new Set(pids.filter(pid => Number.isInteger(pid) && pid > 0))];
  const deadline = Date.now() + processGroupDrainMs;
  while (ownedPids.some(processExists) && Date.now() < deadline) {
    await wait(50);
  }

  return !ownedPids.some(processExists);
}

function parseObservation(serialized = stdout) {
  const valueBuffer = Buffer.isBuffer(serialized) ? serialized : Buffer.from(serialized, "utf8");
  if (valueBuffer.length === 0 || valueBuffer.length > maxObservationBytes) {
    return undefined;
  }
  const value = valueBuffer.toString("utf8").trim();

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

async function readHandoffObservation() {
  if (typeof scenarioHandoffPath !== "string") {
    return undefined;
  }

  try {
    return parseObservation(await readFile(scenarioHandoffPath));
  } catch {
    return undefined;
  }
}

function wait(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function writeAtomicScenarioEvidence(serialized) {
  if (!scenarioOutput) {
    return;
  }

  const temporaryPath = `${scenarioOutput}.tmp-${process.pid}`;
  await mkdir(dirname(scenarioOutput), { recursive: true });
  try {
    await writeFile(temporaryPath, serialized, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, scenarioOutput);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function runElectron() {
  const scenarioCachePath = join(userDataPath, "Cache");
  child = spawn(electronBinary, [
    `--user-data-dir=${userDataPath}`,
    `--disk-cache-dir=${scenarioCachePath}`,
    scenarioScript
  ], {
    cwd: desktopRoot,
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      // A caller may keep a stale path from an older local experiment. The
      // built gate always exercises the package's canonical, freshly-built
      // renderer output.
      JARVIS_DESKTOP_SCENARIO_DIST: canonicalDistRoot,
      // The child writes its complete observation into the runner-owned
      // profile. The parent can therefore recover it even when Electron
      // closes stdout before the pipe receives its final chunk.
      JARVIS_DESKTOP_SCENARIO_OUTPUT: scenarioHandoffPath,
      JARVIS_DESKTOP_SCENARIO_USER_DATA: userDataPath
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  child.stdout.on("data", chunk => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (stdout.length < maxObservationBytes) {
      stdout = Buffer.concat([
        stdout,
        bytes.subarray(0, maxObservationBytes - stdout.length)
      ]);
    }
  });
  child.stderr.on("data", chunk => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (stderr.length < maxCapturedStderrBytes) {
      stderr = Buffer.concat([
        stderr,
        bytes.subarray(0, maxCapturedStderrBytes - stderr.length)
      ]);
    }
  });

  childPromise = new Promise(resolveChild => {
    child.once("error", error => resolveChild({ error }));
    child.once("close", (code, signal) => {
      childExited = true;
      resolveChild({ code, signal });
    });
  });

  const watchdog = setTimeout(() => {
    timedOut = true;
    terminateElectron("SIGTERM");
    setTimeout(() => terminateElectron("SIGKILL"), forceKillGraceMs);
  }, watchdogMs);

  const result = await childPromise;
  clearTimeout(watchdog);
  if (timedOut && !childExited) {
    terminateElectron("SIGKILL");
  }
  return result;
}

async function finish(result) {
  if (!childExited) {
    terminateElectron("SIGTERM");
    await childPromise;
  }

  const observation = parseObservation() ?? await readHandoffObservation();
  const processObservation = observation?.process && typeof observation.process === "object"
    ? observation.process
    : {};
  const ownedAppPids = Array.isArray(processObservation.ownedPids)
    ? processObservation.ownedPids
    : [];

  // Electron may close its launcher before Chromium helpers finish their
  // final profile writes. Keep the owned profile in place for this bounded
  // shutdown grace before checking and draining the app's exact PIDs and
  // detached process group.
  await wait(shutdownGraceMs);
  const ownedAppProcessesGone = await waitForOwnedAppProcessesExit(ownedAppPids);
  // Electron's close event only covers the launcher. Drain its detached,
  // runner-owned process group before removing the profile Chromium may use.
  const ownedProcessGroupGone = await waitForOwnedProcessGroupExit();
  const removed = ownedAppProcessesGone
    && ownedProcessGroupGone
    && await removeScenarioUserData();
  const stderrClean = stderr.toString("utf8").trim().length === 0;
  const childExitCode = result?.code ?? (timedOut ? 124 : 1);
  const finalObservation = observation
      ? {
        ...observation,
        observationAvailable: true,
        userData: {
          ...(observation.userData && typeof observation.userData === "object"
            ? observation.userData
            : {}),
          removed
        },
        process: {
          ...Object.fromEntries(Object.entries(processObservation).filter(([key]) => key !== "ownedPids")),
          childExitCode,
          stderrClean,
          ownedAppProcessesGone,
          ownedProcessGroupGone
        }
      }
    : {
        status: "failed",
        observationAvailable: false,
        failureReason: timedOut
          ? "timeout"
          : result?.error
            ? "spawn-error"
            : "missing-observation",
        userData: { removed },
        process: {
          childExitCode,
          stderrClean,
          ownedAppProcessesGone,
          ownedProcessGroupGone
        }
      };

  if (finalObservation) {
    const serialized = `${JSON.stringify(finalObservation, null, 2)}\n`;
    await writeAtomicScenarioEvidence(serialized);
    process.stdout.write(serialized);
  }

  if (!removed) {
    console.error("Renderer scenario userData cleanup failed.");
  }
  if (!stderrClean) {
    console.error("Renderer scenario Electron stderr was not clean.");
  }
  if (!observation) {
    console.error("Renderer scenario did not return a JSON observation.");
  }

  const success = !timedOut
    && childExitCode === 0
    && removed
    && stderrClean
    && observation !== undefined;
  process.exitCode = success ? 0 : timedOut ? 124 : signalExitCode ?? 1;
}

process.once("SIGINT", () => {
  signalExitCode = 130;
  terminateElectron("SIGTERM");
});
process.once("SIGTERM", () => {
  signalExitCode = 143;
  terminateElectron("SIGTERM");
});

try {
  await createScenarioUserData();
  const result = await runElectron();
  if (result.error) {
    console.error("Renderer scenario Electron process could not start.");
  }
  await finish(result);
} catch {
  console.error("Renderer scenario failed before producing its observation.");
  let cleanupRemoved = false;
  try {
    terminateElectron("SIGKILL");
    if (childPromise) {
      await Promise.race([childPromise, wait(forceKillGraceMs)]);
    }
    await wait(shutdownGraceMs);
    const ownedProcessGroupGone = await waitForOwnedProcessGroupExit();
    cleanupRemoved = ownedProcessGroupGone && await removeScenarioUserData();
    if (!cleanupRemoved) {
      console.error("Renderer scenario userData cleanup failed.");
    }
  } catch {
    console.error("Renderer scenario cleanup failed.");
  }
  if (scenarioOutput) {
    const failureObservation = {
      status: "failed",
      observationAvailable: false,
      failureReason: "runner-error",
      userData: { removed: cleanupRemoved },
      process: { childExitCode: 1, stderrClean: stderr.toString("utf8").trim().length === 0 }
    };
    try {
      const serialized = `${JSON.stringify(failureObservation, null, 2)}\n`;
      await writeAtomicScenarioEvidence(serialized);
      process.stdout.write(serialized);
    } catch {
      console.error("Renderer scenario evidence could not be written.");
    }
  }
  process.exitCode = 1;
}
