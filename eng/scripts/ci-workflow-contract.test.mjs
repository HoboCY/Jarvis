import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { test } from "node:test";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { tmpdir } from "node:os";

const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const execFileAsync = promisify(execFile);

async function read(relativePath) {
  return readFile(join(repositoryRoot, relativePath), "utf8");
}

async function readAbsolute(path) {
  return readFile(path, "utf8");
}

const productionExtensions = new Set([
  ".c", ".cjs", ".cts", ".js", ".json", ".jsx", ".mjs", ".mts", ".sh", ".ts",
  ".tsx", ".yaml", ".yml"
]);

async function collectProductionSurface() {
  const files = [
    ".github/workflows/ci.yml",
    "package.json",
    "src/clients/desktop/package.json"
  ].map(path => join(repositoryRoot, path));
  const roots = [
    join(repositoryRoot, "src/clients/desktop/src"),
    join(repositoryRoot, "src/clients/desktop/scripts"),
    join(repositoryRoot, "eng/scripts")
  ];
  const excludedDirectories = new Set([
    ".git", "artifacts", "coverage", "dist", "node_modules", "out", "tmp"
  ]);

  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!excludedDirectories.has(entry.name)
          && !/(^|[-_.])tests?([-_.]|$)|__fixtures?__|fixtures/i.test(entry.name)) {
          await visit(path);
        }
        continue;
      }
      if (!entry.isFile() || !productionExtensions.has(extname(entry.name).toLowerCase())) {
        continue;
      }
      if (/(?:\.test|\.spec)\.[^.]+$/i.test(entry.name)
        || /(^|[-_.])tests?([-_.]|$)|__fixtures?__|fixtures/i.test(entry.name)) {
        continue;
      }
      files.push(path);
    }
  }

  for (const root of roots) {
    await visit(root);
  }
  return files.sort();
}

const sandboxBypassPatterns = [
  /--\s*no\s*-\s*sandbox/i,
  /--\s*disable\s*-\s*sandbox/i,
  /ELECTRON\s*_\s*DISABLE\s*_\s*SANDBOX/i,
  /app\s*\.\s*commandLine\s*\.\s*appendSwitch\s*\(\s*["'`](?:no|disable)\s*-\s*sandbox["'`]\s*\)/i,
  /app\s*\.\s*commandLine\s*\.\s*appendArgument\s*\(\s*["'`]--\s*(?:no|disable)\s*-\s*sandbox["'`]\s*\)/i,
  /["'`]?sandbox["'`]?\s*:\s*false\b/i
];

function jobSection(workflow, jobId) {
  const start = workflow.indexOf(`  ${jobId}:`);
  assert.notEqual(start, -1, `CI workflow is missing ${jobId}.`);
  const rest = workflow.slice(start + 1);
  const next = rest.search(/^ {2}[a-z0-9-]+:/m);
  return workflow.slice(start, next === -1 ? workflow.length : start + 1 + next);
}

test("Linux Electron sandbox preparation is an explicit, bounded CI seam", async () => {
  const script = await read("eng/scripts/prepare-electron-linux-sandbox.sh");
  const helper = await read("eng/scripts/prepare-electron-linux-sandbox.mjs");
  assert.match(script, /uname -s/);
  assert.match(script, /Linux/);
  assert.match(script, /accepts no arguments/);
  assert.match(script, /prepare-electron-linux-sandbox\.mjs/);
  assert.match(script, /prepare-electron-linux-sandbox-pin\.mjs/);
  assert.match(script, /--resolve/);
  assert.match(script, /--pin/);
  assert.match(script, /pin_dev=/);
  assert.match(script, /pin_ino=/);
  assert.match(script, /pin_nlink=/);
  assert.match(script, /mutator_code=/);
  assert.match(script, /foreign_fd_path = "\/proc\/{\}\/fd\/{\}"\.format/);
  assert.match(script, /os\.open\(/);
  assert.match(script, /os\.fstat\(/);
  assert.match(script, /os\.fchown\(/);
  assert.match(script, /os\.fchmod\(/);
  assert.match(script, /sudo -n \/usr\/bin\/python3 -I -S -c "\$mutator_code"/);
  assert.doesNotMatch(script, /sudo -n (?:chown|chmod)/);
  assert.match(script, /after_identity/);
  assert.match(script, /0o4755/);
  assert.match(script, /kill -USR1/);
  assert.match(script, /resolved_sandbox_path=/);
  assert.match(script, /resolved_sandbox_path.*--resolve/);
  assert.match(script, /resolved_sandbox_path.*!=.*sandbox_path/);
  assert.match(script, /stat -c '%u:%g:%a'/);
  assert.doesNotMatch(script, /%F/);
  assert.ok(
    script.lastIndexOf('resolved_sandbox_path=') > script.indexOf('sudo -n /usr/bin/python3'),
    "sandbox must be resolved again after mutation.");
  assert.match(helper, /electron\/package\.json/);
  assert.match(helper, /path\.txt/);
  assert.match(helper, /chrome-sandbox/);
  assert.match(helper, /isSymbolicLink\(\)/);
  assert.match(helper, /isFile\(\)/);
  assert.match(helper, /Electron sandbox preparation failed\./);
  assert.ok(script.indexOf('uname -s') < script.indexOf('sudo -n /usr/bin/python3'));

  const pinHelper = await read("eng/scripts/prepare-electron-linux-sandbox-pin.mjs");
  assert.match(pinHelper, /O_NOFOLLOW/);
  assert.match(pinHelper, /fstat/);
  assert.match(pinHelper, /lstat/);
  assert.match(pinHelper, /dev/);
  assert.match(pinHelper, /ino/);
  assert.match(pinHelper, /nlink/);
  assert.match(pinHelper, /--dry-run/);
  assert.match(pinHelper, /--pin/);
  assert.match(pinHelper, /DEV=\$\{dev\}/);
  assert.match(pinHelper, /INO=\$\{ino\}/);
  assert.match(pinHelper, /NLINK=\$\{nlink\}/);
  assert.doesNotMatch(pinHelper, /child_process|execFile|spawn|system\(/);
});

test("Desktop scripts expose complete headless and renderer test contracts", async () => {
  const rootPackage = JSON.parse(await read("package.json"));
  const desktopPackage = JSON.parse(await read("src/clients/desktop/package.json"));
  const scripts = desktopPackage.scripts;

  assert.equal(
    desktopPackage.devDependencies?.electron ?? desktopPackage.dependencies?.electron,
    "44.0.0");
  const rootHeadless = rootPackage.scripts["test:headless"];
  for (const packageName of ["@jarvis/contracts-ts", "@jarvis/realtime-agent", "@jarvis/api-client-ts"]) {
    assert.match(rootHeadless, new RegExp(`--filter ${packageName.replace("@", "\\@")} test`));
  }
  assert.match(rootHeadless, /--filter @jarvis\/desktop test:headless/);
  assert.doesNotMatch(rootHeadless, /@jarvis\/mobile|renderer-scenario/);
  assert.match(scripts["test:unit"], /tsx --test/);
  assert.match(scripts["test:wake-word"], /wake-word-acceptance\.test\.mjs/);
  assert.match(scripts["test:wake-word"], /wake-word-cpu-probe\.test\.mjs/);
  assert.match(scripts["test:package"], /check:package/);
  assert.match(scripts["test:headless"], /test:unit/);
  assert.match(scripts["test:headless"], /test:wake-word/);
  assert.match(scripts["test:headless"], /test:package/);
  assert.doesNotMatch(scripts["test:headless"], /renderer-scenario/);
  assert.match(scripts.test, /test:headless/);
  assert.match(scripts.test, /test:renderer-scenario:built/);
  assert.match(scripts["check:package"], /build-desktop\.test\.mjs/);
  assert.match(scripts["check:package"], /wake-word-acceptance\.mjs/);
  assert.match(scripts["check:package"], /wake-word-cpu-probe\.mjs/);
});

test("CI keeps quality gates independent and full matrix dispatchable", async () => {
  const workflow = await read(".github/workflows/ci.yml");
  const requiredJobs = [
    "backend-quality",
    "workspace-quality",
    "contracts-security",
    "desktop-renderer-linux",
    "mobile-static",
    "e2e",
    "android-native",
    "ios-native",
    "macos-release-smoke"
  ];
  const jobs = Object.fromEntries(requiredJobs.map(id => [id, jobSection(workflow, id)]));

  assert.match(workflow, /^ {2}pull_request:$/m);
  assert.match(workflow, /^ {2}push:\n {4}branches: \[main\]$/m);
  assert.match(workflow, /^ {2}workflow_dispatch:$/m);
  assert.match(workflow, /^concurrency:$/m);
  assert.match(workflow, /cancel-in-progress: true/);
  assert.doesNotMatch(workflow, /^ {2}phase-0:/m);
  for (const version of ["10.0.100", "24.19.0", "10.24.0"]) {
    assert.match(workflow, new RegExp(version.replaceAll(".", "\\.")));
  }

  for (const [id, job] of Object.entries(jobs)) {
    assert.match(job, /timeout-minutes:/, `${id} must have a timeout.`);
    assert.doesNotMatch(job, /continue-on-error\s*:/, `${id} must not ignore gate failures.`);
  }
  assert.match(jobs["backend-quality"], /dotnet restore Jarvis\.sln --locked-mode/);
  assert.match(jobs["backend-quality"], /dotnet test Jarvis\.sln/);
  assert.match(jobs["backend-quality"], /dotnet format Jarvis\.sln/);
  assert.match(jobs["workspace-quality"], /pnpm install --frozen-lockfile/);
  assert.match(jobs["workspace-quality"], /name: Run headless workspace tests/);
  assert.match(jobs["workspace-quality"], /pnpm test:headless/);
  assert.match(jobs["contracts-security"], /check:openapi/);
  assert.match(jobs["contracts-security"], /check:secrets/);
  assert.match(jobs["desktop-renderer-linux"], /name: Install pinned Electron runtime/);
  assert.match(jobs["desktop-renderer-linux"], /pnpm --filter @jarvis\/desktop exec install-electron/);
  assert.ok(
    jobs["desktop-renderer-linux"].indexOf("Install pinned Electron runtime")
      < jobs["desktop-renderer-linux"].indexOf("Prepare Electron Chromium sandbox"),
    "Electron runtime must be installed before sandbox preparation.");
  const initializerStart = jobs["desktop-renderer-linux"].indexOf(
    "      - name: Initialize renderer scenario evidence");
  const initializerEnd = jobs["desktop-renderer-linux"].indexOf(
    "      - name:", initializerStart + 1);
  assert.notEqual(initializerStart, -1, "Renderer evidence initializer is missing.");
  const initializer = jobs["desktop-renderer-linux"].slice(
    initializerStart,
    initializerEnd === -1 ? jobs["desktop-renderer-linux"].length : initializerEnd);
  assert.match(initializer, /if: always\(\)/);
  assert.match(initializer, /failureReason.*renderer-scenario-not-started/);
  assert.match(initializer, /observationAvailable.*false/);
  assert.match(initializer, /status.*not-run/);
  assert.doesNotMatch(initializer, /printenv|toJSON|env >|env >>/);
  assert.ok(
    initializerStart > jobs["desktop-renderer-linux"].indexOf("- name: Checkout")
      && initializerStart < jobs["desktop-renderer-linux"].indexOf("- name: Setup pnpm"),
    "Renderer evidence must be initialized after checkout and before setup.");
  assert.match(jobs["desktop-renderer-linux"], /prepare-electron-linux-sandbox\.sh/);
  assert.match(jobs["desktop-renderer-linux"], /name: Prepare D-Bus for Electron renderer/);
  assert.match(jobs["desktop-renderer-linux"], /system_bus_socket/);
  assert.match(jobs["desktop-renderer-linux"], /sudo -n install -d -m 0755 \/run\/dbus/);
  assert.match(jobs["desktop-renderer-linux"], /sudo -n dbus-daemon --system --fork/);
  assert.match(jobs["desktop-renderer-linux"], /test -S .*system_bus_socket/);
  assert.match(jobs["desktop-renderer-linux"], /command -v dbus-run-session/);
  assert.ok(
    jobs["desktop-renderer-linux"].indexOf("sudo -n install -d -m 0755 /run/dbus")
      < jobs["desktop-renderer-linux"].indexOf("sudo -n dbus-daemon --system --fork"),
    "D-Bus runtime directory must be prepared before starting the daemon.");
  assert.match(jobs["desktop-renderer-linux"], /dbus-run-session -- xvfb-run -a/);
  assert.ok(
    jobs["desktop-renderer-linux"].indexOf("Prepare D-Bus for Electron renderer")
      < jobs["desktop-renderer-linux"].indexOf("Run built renderer scenario in Xvfb"),
    "D-Bus must be prepared before the renderer scenario.");
  assert.match(jobs["desktop-renderer-linux"], /xvfb-run -a/);
  assert.match(jobs["desktop-renderer-linux"], /test:renderer-scenario:built/);
  assert.match(jobs["desktop-renderer-linux"], /if: always\(\)/);
  assert.match(jobs["desktop-renderer-linux"], /upload-artifact@v4/);
  assert.match(jobs["mobile-static"], /bundle:android/);
  assert.match(jobs["mobile-static"], /bundle:ios/);
  assert.match(jobs.e2e, /needs: backend-quality/);
  assert.match(jobs.e2e, /name: Setup Node 24\.19\.0/);
  assert.match(jobs.e2e, /node-version: 24\.19\.0/);
  assert.match(jobs["android-native"], /needs: mobile-static/);
  assert.match(jobs["ios-native"], /needs: mobile-static/);
  assert.match(jobs["macos-release-smoke"], /needs:/);
  assert.match(jobs["macos-release-smoke"], /name: Install pinned Electron runtime/);
  assert.match(jobs["macos-release-smoke"], /pnpm --filter @jarvis\/desktop exec install-electron/);
  assert.ok(
    jobs["macos-release-smoke"].indexOf("Install pinned Electron runtime")
      < jobs["macos-release-smoke"].indexOf("Build and package unsigned arm64 Desktop artifact"),
    "Electron runtime must be installed before macOS packaging.");
  assert.match(jobs["macos-release-smoke"], /package-desktop-macos\.sh/);
  assert.match(jobs["macos-release-smoke"], /launchd-smoke-macos\.sh/);
  assert.match(jobs.e2e, /workflow_dispatch/);
  assert.match(jobs["android-native"], /workflow_dispatch/);
  assert.match(jobs["ios-native"], /workflow_dispatch/);
  assert.match(jobs["macos-release-smoke"], /workflow_dispatch/);

  const coreJobs = [jobs["backend-quality"], jobs["workspace-quality"], jobs["contracts-security"], jobs["desktop-renderer-linux"], jobs["mobile-static"]];
  for (const job of coreJobs) {
    assert.doesNotMatch(job, /needs:/);
  }
});

function workflowStepSection(job, stepName) {
  const start = job.indexOf(`      - name: ${stepName}`);
  assert.notEqual(start, -1, `CI workflow is missing step ${stepName}.`);
  const rest = job.slice(start + 1);
  const next = rest.search(/^ {6}- name:/m);
  return job.slice(start, next === -1 ? job.length : start + 1 + next);
}

function workflowRunScript(step) {
  const lines = step.split("\n");
  const runMarker = lines.indexOf("        run: |");
  assert.notEqual(runMarker, -1, "workflow step is missing a run script.");
  const scriptLines = [];
  for (const line of lines.slice(runMarker + 1)) {
    if (line.startsWith("          ")) {
      scriptLines.push(line.slice(10));
      continue;
    }
    if (line === "") {
      scriptLines.push("");
      continue;
    }
    break;
  }
  return scriptLines.join("\n");
}

test("CI pre-merge Full Matrix is label-gated, emits bounded evidence, and preserves summary semantics", async () => {
  const workflow = await read(".github/workflows/ci.yml");
  const fullMatrixJobs = ["e2e", "android-native", "ios-native", "macos-release-smoke"];
  const requiredJobs = [
    "backend-quality",
    "workspace-quality",
    "contracts-security",
    "desktop-renderer-linux",
    "mobile-static",
    ...fullMatrixJobs
  ];

  assert.match(
    workflow,
    /^\x20{2}pull_request:\n\x20{4}types: \[opened, synchronize, reopened, labeled\]$/m,
    "pre-merge CI must rerun after labeling and subsequent branch updates.");
  assert.match(workflow, /^\x20{2}push:\n\x20{4}branches: \[main\]$/m);
  assert.match(workflow, /^\x20{2}workflow_dispatch:$/m);

  for (const id of fullMatrixJobs) {
    const job = jobSection(workflow, id);
    assert.match(job, /if: \$\{\{\s*success\(\)\s*&&/,
      `${id} must retain successful needs as a prerequisite.`);
    assert.match(job, /github\.event_name == 'push'/);
    assert.match(job, /github\.ref == 'refs\/heads\/main'/);
    assert.match(job, /github\.event_name == 'workflow_dispatch'/);
    assert.match(job, /github\.event_name == 'pull_request'/);
    assert.match(
      job,
      /contains\(github\.event\.pull_request\.labels\.\*\.name, 'full-matrix'\)/,
      `${id} must be runnable from a labeled PR.`);
    assert.doesNotMatch(job, /codex\/phase9a-ci-recovery/);
    assert.doesNotMatch(job, /continue-on-error\s*:/);
  }

  assert.match(jobSection(workflow, "e2e"), /needs: backend-quality/);
  assert.match(jobSection(workflow, "android-native"), /needs: mobile-static/);
  assert.match(jobSection(workflow, "ios-native"), /needs: mobile-static/);
  assert.match(
    jobSection(workflow, "macos-release-smoke"),
    /needs: \[backend-quality, workspace-quality, contracts-security, desktop-renderer-linux, mobile-static, e2e\]/);

  const summary = jobSection(workflow, "phase9a-verification-summary");
  assert.match(
    summary,
    /needs: \[backend-quality, workspace-quality, contracts-security, desktop-renderer-linux, mobile-static, e2e, android-native, ios-native, macos-release-smoke\]/);
  assert.match(summary, /if: \$\{\{\s*always\(\)\s*\}\}/);
  assert.match(summary, /FULL_MATRIX_REQUESTED/);
  assert.match(
    summary,
    /HEAD_SHA: \$\{\{ github\.event_name == 'pull_request' && github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/,
    "remote evidence must bind PRs to the candidate branch SHA.");
  assert.match(summary, /not-requested/);
  assert.match(summary, /fullMatrixRequested/);
  assert.match(summary, /jobResults/);
  for (const field of [
    "workflowName",
    "runId",
    "runAttempt",
    "eventName",
    "ref",
    "headSha",
    "repository",
    "overallStatus",
    "generatedAtUtc",
    "remote-verification.json",
    "jarvis-phase9a-remote-verification"
  ]) {
    assert.match(summary, new RegExp(field.replace(/[.-]/g, "\\$&")));
  }
  for (const id of requiredJobs) {
    assert.match(summary, new RegExp(id.replace("-", "\\-")),
      `remote evidence must record ${id}.`);
  }
  assert.match(summary, /if \[\[ "\$FULL_MATRIX_REQUESTED" != "true" \]\]/);
  for (const result of ["e2e_result", "android_result", "ios_result", "macos_result"]) {
    assert.match(summary, new RegExp(`${result}="not-requested"`),
      `unrequested Full Matrix results must be normalized for ${result}.`);
  }
  assert.match(summary, /!=\s*success/);
  assert.match(summary, /phase9a-summary-status/);
  const uploadIndex = summary.indexOf("Upload remote verification evidence");
  const gateIndex = summary.indexOf("Enforce verification summary status");
  assert.ok(uploadIndex >= 0 && uploadIndex < gateIndex,
    "summary evidence must upload before the non-zero status gate.");
  assert.doesNotMatch(summary, /continue-on-error\s*:/);
  assert.doesNotMatch(summary, /toJSON\s*\(|printenv|env\s*[>]{1,2}/i);

  const artifactSteps = [
    ["desktop-renderer-linux", "Upload bounded renderer scenario evidence"],
    ["mobile-static", "Upload mobile static bundles"],
    ["e2e", "Upload E2E reports"],
    ["android-native", "Upload Android debug application"],
    ["ios-native", "Upload iOS Simulator application"],
    ["macos-release-smoke", "Upload macOS release-test artifacts"],
    ["phase9a-verification-summary", "Upload remote verification evidence"]
  ];
  for (const [jobId, stepName] of artifactSteps) {
    const step = workflowStepSection(jobSection(workflow, jobId), stepName);
    assert.match(step, /if: always\(\)/, `${jobId} artifact must upload after failures.`);
    assert.match(step, /uses: actions\/upload-artifact@v4/);
    assert.match(step, /if-no-files-found: error/,
      `${jobId} artifact must be required when the matrix is requested.`);
  }
  await assertRemoteVerificationSummaryShell(workflow);
});

async function assertRemoteVerificationSummaryShell(workflow) {
  const fullMatrixJobs = ["e2e", "android-native", "ios-native", "macos-release-smoke"];
  const coreJobs = [
    "backend-quality",
    "workspace-quality",
    "contracts-security",
    "desktop-renderer-linux",
    "mobile-static"
  ];
  const summary = jobSection(workflow, "phase9a-verification-summary");
  const fullMatrixPredicates = fullMatrixJobs.map(id => {
    const match = jobSection(workflow, id).match(
      /^\x20{4}if: \$\{\{\s*success\(\)\s*&&\s*(.+?)\s*\}\}$/m);
    assert.ok(match, `${id} is missing its Full Matrix predicate.`);
    return match[1];
  });
  assert.equal(new Set(fullMatrixPredicates).size, 1,
    "Full Matrix jobs must share one trigger predicate.");
  const summaryPredicate = summary.match(
    /^\x20{6}FULL_MATRIX_REQUESTED: \$\{\{\s*(.+?)\s*\}\}$/m);
  assert.ok(summaryPredicate, "summary is missing its Full Matrix predicate.");
  assert.equal(summaryPredicate[1], fullMatrixPredicates[0],
    "summary and Full Matrix jobs must use the same trigger predicate.");

  const generateScript = workflowRunScript(
    workflowStepSection(summary, "Generate bounded remote verification evidence"));
  const enforceScript = workflowRunScript(
    workflowStepSection(summary, "Enforce verification summary status"));
  const jobEnvironmentNames = {
    "backend-quality": "BACKEND_RESULT",
    "workspace-quality": "WORKSPACE_RESULT",
    "contracts-security": "CONTRACTS_RESULT",
    "desktop-renderer-linux": "DESKTOP_RENDERER_RESULT",
    "mobile-static": "MOBILE_STATIC_RESULT",
    e2e: "E2E_RESULT",
    "android-native": "ANDROID_RESULT",
    "ios-native": "IOS_RESULT",
    "macos-release-smoke": "MACOS_RESULT"
  };
  const successResults = Object.fromEntries(
    [...coreJobs, ...fullMatrixJobs].map(id => [id, "success"]));
  const scenarios = [
    {
      name: "ordinary-pr",
      requested: "false",
      matrixResults: Object.fromEntries(fullMatrixJobs.map(id => [id, "skipped"])),
      expectedOverallStatus: "success",
      enforceSucceeds: true
    },
    {
      name: "requested-success",
      requested: "true",
      matrixResults: Object.fromEntries(fullMatrixJobs.map(id => [id, "success"])),
      expectedOverallStatus: "success",
      enforceSucceeds: true
    },
    {
      name: "requested-skipped",
      requested: "true",
      matrixResults: { ...Object.fromEntries(fullMatrixJobs.map(id => [id, "success"])), e2e: "skipped" },
      expectedOverallStatus: "failure",
      enforceSucceeds: false
    }
  ];
  const temporaryRoot = await mkdtemp(join(tmpdir(), "jarvis-ci-summary-"));
  try {
    for (const scenario of scenarios) {
      const scenarioDirectory = join(temporaryRoot, scenario.name);
      const runnerTemp = join(scenarioDirectory, "runner-temp");
      await mkdir(runnerTemp, { recursive: true });
      const results = { ...successResults, ...scenario.matrixResults };
      const environment = {
        ...process.env,
        GITHUB_WORKFLOW: "CI",
        GITHUB_RUN_ID: "12345",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_REF: "refs/pull/42/merge",
        GITHUB_SHA: "merge-sha",
        HEAD_SHA: "candidate-sha",
        GITHUB_REPOSITORY: "HoboCY/Jarvis",
        RUNNER_TEMP: runnerTemp,
        FULL_MATRIX_REQUESTED: scenario.requested,
        ...Object.fromEntries(
          Object.entries(jobEnvironmentNames).map(([id, variable]) => [variable, results[id]]))
      };
      const shellOptions = {
        cwd: scenarioDirectory,
        env: environment,
        maxBuffer: 256 * 1024
      };
      await execFileAsync(
        "bash",
        ["-e", "-u", "-o", "pipefail", "-c", generateScript],
        shellOptions);

      const evidence = JSON.parse(await readFile(
        join(scenarioDirectory, "artifacts/test-reports/phase9a/remote-verification.json"),
        "utf8"));
      assert.equal(evidence.fullMatrixRequested, scenario.requested === "true");
      assert.equal(
        evidence.fullMatrix.status,
        scenario.requested === "true" ? "requested" : "not-requested");
      assert.equal(evidence.headSha, "candidate-sha");
      assert.equal(evidence.overallStatus, scenario.expectedOverallStatus);
      for (const id of coreJobs) {
        assert.equal(evidence.jobResults[id], "success");
      }
      for (const id of fullMatrixJobs) {
        assert.equal(
          evidence.jobResults[id],
          scenario.requested === "true" ? results[id] : "not-requested");
      }

      const enforce = execFileAsync(
        "bash",
        ["-e", "-u", "-o", "pipefail", "-c", enforceScript],
        shellOptions);
      if (scenario.enforceSucceeds) {
        await enforce;
      } else {
        await assert.rejects(enforce, error => error?.code !== 0,
          `${scenario.name} must fail the summary enforcement step.`);
      }
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

test("Renderer handoff and startup observation preserve the strict scenario", async () => {
  const runner = await read("src/clients/desktop/scripts/renderer-scenario-runner.mjs");
  const scenario = await read("src/clients/desktop/scripts/renderer-scenario.mjs");
  assert.match(runner, /writeAtomicScenarioEvidence/);
  assert.match(runner, /rename/);
  assert.equal(
    runner.match(/await writeAtomicScenarioEvidence\(serialized\)/g)?.length,
    2,
    "successful and failed runner paths must overwrite evidence atomically.");
  assert.match(runner, /scenarioHandoffPath/);
  assert.match(runner, /JARVIS_DESKTOP_SCENARIO_OUTPUT:\s*scenarioHandoffPath/);
  assert.match(runner, /readFile/);
  assert.match(runner, /observationAvailable/);
  assert.doesNotMatch(runner, /console\.error\(stdout/);
  assert.match(scenario, /writeAtomicJson/);
  assert.match(scenario, /rename/);
  const handoffWrite = scenario.indexOf("await writeAtomicJson(scenarioOutput, observation)");
  const assertionFailure = scenario.indexOf("throw new Error(\"Desktop renderer scenario assertion failed.\")");
  assert.ok(handoffWrite > 0 && handoffWrite < assertionFailure,
    "Renderer observation must be handed off before assertion failure.");
  assert.match(
    scenario,
    /if \(scenarioOutput\) \{[\s\S]*await writeAtomicJson\(scenarioOutput, observation\);[\s\S]*\} else \{[\s\S]*console\.log\(JSON\.stringify\(observation, null, 2\)\)/);
  assert.doesNotMatch(scenario, /Desktop renderer scenario failed: \$\{JSON\.stringify\(observation\)\}/);
  assert.match(runner, /Buffer\.concat/);
  assert.doesNotMatch(runner, /chunk\.slice\(0, remainingBytes\)/);
  assert.match(scenario, /waitForStableStartupConnection/);
  assert.doesNotMatch(scenario, /await wait\(250\)/);
  assert.match(runner, /childExitCode/);
});

test("the repository keeps Chromium sandbox enabled without bypass markers", async () => {
  const paths = await collectProductionSurface();
  const contents = await Promise.all(paths.map(readAbsolute));
  for (const content of contents) {
    for (const pattern of sandboxBypassPatterns) {
      assert.equal(pattern.test(content), false);
    }
  }
  for (const sample of [
    "--no-sandbox",
    "-- disable - sandbox",
    "ELECTRON_DISABLE_SANDBOX",
    "app.commandLine . appendSwitch ( 'no-sandbox' )",
    "app.commandLine.appendSwitch(\"no-sandbox\")",
    "app.commandLine.appendSwitch('disable-sandbox')",
    "app.commandLine . appendSwitch ( \"disable-sandbox\" )",
    "app.commandLine.appendArgument( '--no-sandbox' )",
    "app.commandLine.appendArgument(\"--no-sandbox\")",
    "app.commandLine.appendArgument('--disable-sandbox')",
    "app.commandLine . appendArgument ( \"--disable-sandbox\" )",
    "sandbox\n : \t false"
  ]) {
    assert.equal(sandboxBypassPatterns.some(pattern => pattern.test(sample)), true);
  }
  const scenarioPath = join(repositoryRoot, "src/clients/desktop/scripts/renderer-scenario.mjs");
  assert.match(await readAbsolute(scenarioPath), /sandbox: true/);
  assert.ok(paths.some(path => path.endsWith(`${sep}src${sep}main${sep}index.ts`)
    || path.endsWith(`${sep}src${sep}main${sep}app.ts`)
    || path.includes(`${sep}src${sep}main${sep}`)),
  "sandbox scan must include Desktop runtime sources.");
});
