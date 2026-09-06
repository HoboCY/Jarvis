import { strict as assert } from "node:assert";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createRunIsolation } from "./isolation.mjs";
import { LaunchdSupervisor, renderOwnedLaunchdPlist } from "./launchd-supervisor.mjs";

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "jarvis-phase9b-launchd-"));
  const repositoryRoot = join(root, "repo");
  const homeDirectory = join(root, "home");
  const baseDirectory = join(root, "safe");
  await Promise.all([mkdir(repositoryRoot), mkdir(homeDirectory), mkdir(baseDirectory)]);
  await chmod(baseDirectory, 0o700);
  const isolation = await createRunIsolation({ repositoryRoot, homeDirectory, baseDirectory });
  const apiWorkingDirectory = join(isolation.root, "runtime", "api");
  const deviceWorkingDirectory = join(isolation.root, "runtime", "device-node");
  await mkdir(apiWorkingDirectory, { recursive: true, mode: 0o700 });
  await mkdir(deviceWorkingDirectory, { recursive: true, mode: 0o700 });
  await chmod(apiWorkingDirectory, 0o700);
  await chmod(deviceWorkingDirectory, 0o700);
  const apiExecutable = join(root, "Jarvis.Api");
  const deviceExecutable = join(root, "Jarvis.DeviceNode");
  await writeFile(apiExecutable, "api", { mode: 0o700 });
  await writeFile(deviceExecutable, "device", { mode: 0o700 });
  return {
    root,
    isolation,
    apiExecutable,
    deviceExecutable,
    apiWorkingDirectory,
    deviceWorkingDirectory
  };
}

function createLaunchctlFixture({ existing = new Map(), failBootstrap = false, labels = {} } = {}) {
  const loaded = new Map(existing);
  const calls = [];
  const runner = (args) => {
    calls.push([...args]);
    const action = args[0];
    let label = args[1]?.split("/").at(-1);
    if (action === "print") {
      const plist = loaded.get(label);
      if (plist === undefined) {
        const error = new Error("service not found");
        error.stderr = `Could not find service "${args[1]}" in domain for system`;
        throw error;
      }
      return {
        status: 0,
        stdout: `${args[1]} = {\n\tpath = ${plist}\n\tstate = running\n}`
      };
    }
    if (action === "bootstrap") {
      const kind = args[2]?.endsWith("/api.plist") ? "api" : "device";
      label = labels[kind] ?? label;
      if (failBootstrap) {
        loaded.set(label, args[2]);
        throw Object.assign(new Error("bootstrap failed"), { stderr: "bootstrap failed" });
      }
      loaded.set(label, args[2]);
      return { status: 0, stdout: "" };
    }
    if (action === "bootout") {
      label = Object.entries(labels).find(([, plist]) => plist === args[2])?.[0]
        ?? [...loaded.entries()].find(([, plist]) => plist === args[2])?.[0]
        ?? label;
      loaded.delete(label);
      return { status: 0, stdout: "" };
    }
    throw new Error("unexpected launchctl action");
  };
  return { loaded, calls, runner };
}

async function createSupervisor(fixture, runner, secretValues = []) {
  return new LaunchdSupervisor({
    root: fixture.isolation.root,
    runId: fixture.isolation.runId,
    apiExecutable: fixture.apiExecutable,
    apiWorkingDirectory: fixture.apiWorkingDirectory,
    deviceExecutable: fixture.deviceExecutable,
    deviceWorkingDirectory: fixture.deviceWorkingDirectory,
    apiPort: fixture.isolation.port,
    uid: 501,
    launchctlRunner: runner,
    secretValues
  });
}

test("launchd lifecycle uses unique owned labels and removes only its services", async () => {
  const fixture = await createFixture();
  try {
    const first = new LaunchdSupervisor({
      root: fixture.isolation.root,
      runId: fixture.isolation.runId,
      apiExecutable: fixture.apiExecutable,
      apiWorkingDirectory: fixture.apiWorkingDirectory,
      deviceExecutable: fixture.deviceExecutable,
      deviceWorkingDirectory: fixture.deviceWorkingDirectory,
      apiPort: fixture.isolation.port,
      uid: 501,
      launchctlRunner: () => ({ status: 0, stdout: "" })
    });
    assert.match(first.labels.api, new RegExp(`^com\\.hobocy\\.jarvis\\.phase9b\\.${fixture.isolation.runId}\\.api$`));
    assert.notEqual(first.labels.api, first.labels.device);

    const launchctl = createLaunchctlFixture({ labels: first.labels });
    const supervisor = await createSupervisor(fixture, launchctl.runner);
    await supervisor.startService("api");
    await supervisor.startService("device");
    assert.equal(supervisor.isInstalled("api"), true);
    assert.equal(supervisor.isInstalled("device"), true);
    assert.equal((await supervisor.serviceState("api")).running, true);
    assert.equal((await supervisor.serviceState("device")).running, true);
    assert.equal((await stat(supervisor.plistPaths.api)).mode & 0o777, 0o600);
    assert.equal((await stat(supervisor.logPaths.api)).mode & 0o777, 0o700);
    assert.equal((await stat(join(supervisor.logPaths.api, "stdout.log"))).mode & 0o777, 0o600);
    assert.equal((await stat(join(supervisor.logPaths.api, "stderr.log"))).mode & 0o777, 0o600);
    const apiPlist = await readFile(supervisor.plistPaths.api, "utf8");
    assert.match(apiPlist, /<key>WorkingDirectory<\/key>/);
    assert.match(apiPlist, /<key>KeepAlive<\/key>\n\s*<false\/>/);
    assert.match(apiPlist, /<key>Umask<\/key>\n\s*<integer>63<\/integer>/);
    assert.equal(apiPlist.includes("Bearer"), false);
    assert.equal(apiPlist.includes("phase9b-fake-secret"), false);

    await supervisor.stopAll();
    await supervisor.stopAll();
    assert.equal(launchctl.loaded.size, 0);
    assert.equal(await lstat(supervisor.plistPaths.api).then(() => true).catch(() => false), false);
    assert.equal(launchctl.calls.filter((args) => args[0] === "bootout").length, 2);
  } finally {
    await fixture.isolation.cleanup().catch(() => {});
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("launchd refuses an already loaded label without proving this run owns it", async () => {
  const fixture = await createFixture();
  try {
    const placeholder = new LaunchdSupervisor({
      root: fixture.isolation.root,
      runId: fixture.isolation.runId,
      apiExecutable: fixture.apiExecutable,
      apiWorkingDirectory: fixture.apiWorkingDirectory,
      deviceExecutable: fixture.deviceExecutable,
      deviceWorkingDirectory: fixture.deviceWorkingDirectory,
      apiPort: fixture.isolation.port,
      uid: 501,
      launchctlRunner: () => ({ status: 0, stdout: "" })
    });
    const foreignLabel = placeholder.labels.api;
    const launchctl = createLaunchctlFixture({
      existing: new Map([[foreignLabel, "/private/foreign/unrelated.plist"]]),
      labels: placeholder.labels
    });
    const supervisor = await createSupervisor(fixture, launchctl.runner);
    await assert.rejects(
      () => supervisor.startService("api"),
      (error) => error.code === "LAUNCHD_OWNERSHIP_INVALID"
    );
    assert.equal(launchctl.calls.some((args) => args[0] === "bootout"), false);
    assert.equal(await lstat(supervisor.plistPaths.api).then(() => true).catch(() => false), false);
  } finally {
    await fixture.isolation.cleanup().catch(() => {});
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("launchd bootstrap failure remains bounded and cleanup bootouts a partially loaded owned service", async () => {
  const fixture = await createFixture();
  try {
    const expected = await createSupervisor(fixture, () => ({ status: 0, stdout: "" }));
    const launchctl = createLaunchctlFixture({ failBootstrap: true, labels: expected.labels });
    const supervisor = await createSupervisor(fixture, launchctl.runner);
    await assert.rejects(
      () => supervisor.startService("api"),
      (error) => error.code === "LAUNCHD_BOOTSTRAP_FAILED"
    );
    await supervisor.stopAll();
    assert.equal(launchctl.loaded.size, 0);
  } finally {
    await fixture.isolation.cleanup().catch(() => {});
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("launchd plist contains only non-secret runtime inputs", () => {
  const plist = renderOwnedLaunchdPlist({
    kind: "api",
    label: "com.hobocy.jarvis.phase9b.example.api",
    executable: "/tmp/Jarvis.Api",
    workingDirectory: "/tmp/runtime/api",
    plistPath: "/tmp/example.plist",
    logDirectory: "/tmp/runtime/logs",
    apiPort: "42000"
  });
  assert.match(plist, /<key>ProgramArguments<\/key>/);
  assert.match(plist, /<key>Umask<\/key>\n\s*<integer>63<\/integer>/);
  assert.equal(plist.includes("ConnectionStrings__Jarvis"), false);
  assert.equal(plist.includes("Bearer"), false);
  assert.throws(
    () => renderOwnedLaunchdPlist({
      kind: "api",
      label: "com.hobocy.jarvis.phase9b.example.api",
      executable: "/tmp/secret-token/Jarvis.Api",
      workingDirectory: "/tmp/runtime/api",
      plistPath: "/tmp/example.plist",
      logDirectory: "/tmp/runtime/logs",
      apiPort: "42000"
    }),
    (error) => error.code === "LAUNCHD_PLIST_INVALID"
  );
});
