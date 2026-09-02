import { spawn } from "node:child_process";
import { chmod, mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
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

let userDataPath;
let child;
let childPromise;
let childExited = false;
let timedOut = false;
let signalExitCode;
let stdout = "";
let stderr = "";

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

function parseObservation() {
  const value = stdout.trim();
  if (!value) {
    return undefined;
  }

  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function wait(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
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
      JARVIS_DESKTOP_SCENARIO_USER_DATA: userDataPath
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => {
    stderr += chunk;
    process.stderr.write(chunk);
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

  const observation = parseObservation();
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
  const stderrClean = stderr.trim().length === 0;
  const childExitCode = result?.code ?? (timedOut ? 124 : 1);
  const finalObservation = observation && typeof observation === "object"
    ? {
        ...observation,
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
    : undefined;

  if (finalObservation) {
    const serialized = `${JSON.stringify(finalObservation, null, 2)}\n`;
    if (scenarioOutput) {
      await mkdir(dirname(scenarioOutput), { recursive: true });
      await writeFile(scenarioOutput, serialized, "utf8");
    }
    process.stdout.write(serialized);
  }

  if (!removed) {
    console.error("Renderer scenario userData cleanup failed.");
  }
  if (!stderrClean) {
    console.error("Renderer scenario Electron stderr was not clean.");
  }
  if (!finalObservation) {
    console.error("Renderer scenario did not return a JSON observation.");
    if (stdout.trim()) {
      console.error(stdout.trim().slice(-2_000));
    }
  }

  const success = !timedOut
    && childExitCode === 0
    && removed
    && stderrClean
    && finalObservation !== undefined;
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
    console.error(result.error instanceof Error ? result.error.message : result.error);
  }
  await finish(result);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  try {
    terminateElectron("SIGKILL");
    if (childPromise) {
      await Promise.race([childPromise, wait(forceKillGraceMs)]);
    }
    await wait(shutdownGraceMs);
    const ownedProcessGroupGone = await waitForOwnedProcessGroupExit();
    const removed = ownedProcessGroupGone && await removeScenarioUserData();
    if (!removed) {
      console.error("Renderer scenario userData cleanup failed.");
    }
  } catch (cleanupError) {
    console.error(cleanupError instanceof Error ? cleanupError.message : cleanupError);
  }
  process.exitCode = 1;
}
