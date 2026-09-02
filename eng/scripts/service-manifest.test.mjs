import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  assertSafeServiceLabel,
  buildServicePaths,
  installService,
  isServiceNotFoundError,
  renderLaunchdPlist,
  uninstallService
} from "./launchd-service.mjs";
import { run as runInstallLaunchdService } from "./install-launchd-service.mjs";
import { getServiceBundleArtifacts } from "./create-service-manifest.mjs";
import { buildReleaseManifest, sha256File } from "./release-manifest.mjs";

test("launchd labels and paths are explicit and isolated", () => {
  assert.equal(assertSafeServiceLabel("com.hobocy.jarvis.api.phase6"), "com.hobocy.jarvis.api.phase6");
  assert.throws(() => assertSafeServiceLabel("com.hobocy.jarvis.api/../../launch"), /label/);
  assert.throws(() => assertSafeServiceLabel("jarvis api"), /label/);

  const paths = buildServicePaths("/tmp/jarvis-phase6", "com.hobocy.jarvis.api.phase6");
  assert.equal(paths.plist, "/tmp/jarvis-phase6/com.hobocy.jarvis.api.phase6.plist");
  assert.equal(paths.logs, "/tmp/jarvis-phase6/logs/com.hobocy.jarvis.api.phase6");
  assert.equal(paths.data, "/tmp/jarvis-phase6/data/com.hobocy.jarvis.api.phase6");
});

test("launchd plist rendering refuses unresolved variables and credentials", () => {
  const template = `<plist><label>__LABEL__</label><program>__EXECUTABLE__</program><log>__LOG_DIRECTORY__</log></plist>`;
  const rendered = renderLaunchdPlist(template, {
    label: "com.hobocy.jarvis.api.phase6",
    executable: "/tmp/jarvis/api/Jarvis.Api",
    workingDirectory: "/tmp/jarvis/api",
    dataDirectory: "/tmp/jarvis/data",
    logDirectory: "/tmp/jarvis/logs"
  });
  assert.match(rendered, /com\.hobocy\.jarvis\.api\.phase6/);
  assert.doesNotMatch(rendered, /__\w+__/);
  assert.throws(() => renderLaunchdPlist(template, {
    label: "com.hobocy.jarvis.api.phase6",
    executable: "Bearer test-token",
    workingDirectory: "/tmp/jarvis/api",
    dataDirectory: "/tmp/jarvis/data",
    logDirectory: "/tmp/jarvis/logs"
  }), /credential|secret|token/i);
});

test("launchd plist rendering defaults to port 5004 and preserves an explicit port", () => {
  const template = "<plist>http://127.0.0.1:__API_PORT__</plist>";
  const values = {
    label: "com.hobocy.jarvis.api.phase6",
    executable: "/tmp/jarvis/api/Jarvis.Api",
    workingDirectory: "/tmp/jarvis/api",
    dataDirectory: "/tmp/jarvis/data",
    logDirectory: "/tmp/jarvis/logs"
  };

  assert.match(renderLaunchdPlist(template, values), /http:\/\/127\.0\.0\.1:5004/);
  assert.match(renderLaunchdPlist(template, { ...values, apiPort: "43123" }), /http:\/\/127\.0\.0\.1:43123/);
});

test("launchd install defaults to port 5004 when no port is supplied", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-launchd-default-port-"));
  const label = "com.hobocy.jarvis.api.default-port";
  const templatePath = join(root, "jarvis-api.plist.template");
  const template = await readFile(join(process.cwd(), "eng/services/templates/jarvis-api.plist.template"), "utf8");

  try {
    await writeFile(templatePath, template);
    await installService({
      root,
      label,
      executable: "/tmp/Jarvis.Api",
      workingDirectory: "/tmp/jarvis",
      templatePath,
      launchctlRunner: () => ({ status: 0, stdout: "", stderr: "" })
    });

    const rendered = await readFile(join(root, `${label}.plist`), "utf8");
    assert.match(rendered, /http:\/\/127\.0\.0\.1:5004/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("launchd installer CLI defaults to port 5004 and preserves --api-port", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-launchd-cli-port-"));
  const label = "com.hobocy.jarvis.api.cli-port";
  const args = [
    "install",
    "--root", root,
    "--label", label,
    "--kind", "api",
    "--executable", "/tmp/Jarvis.Api",
    "--working-directory", "/tmp/jarvis",
    "--dry-run"
  ];

  try {
    await runInstallLaunchdService(args);
    const defaultRendered = await readFile(join(root, `${label}.plist`), "utf8");
    assert.match(defaultRendered, /http:\/\/127\.0\.0\.1:5004/);

    await runInstallLaunchdService([...args, "--api-port", "43123"]);
    const explicitRendered = await readFile(join(root, `${label}.plist`), "utf8");
    assert.match(explicitRendered, /http:\/\/127\.0\.0\.1:43123/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release manifest records SHA-256 and explicit unsigned status", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-release-manifest-"));
  const artifact = join(root, "Jarvis-test.zip");
  try {
    await writeFile(artifact, "phase6 artifact");
    const hash = await sha256File(artifact);
    const manifest = await buildReleaseManifest({
      version: "0.1.0-phase6",
      platform: "darwin",
      arch: "arm64",
      artifacts: [{ path: artifact, kind: "test-package" }],
      signatureStatus: "unsigned-test",
      notarizationStatus: "not-run"
    });
    assert.equal(manifest.artifacts[0].sha256, hash);
    assert.equal(manifest.signatureStatus, "unsigned-test");
    assert.equal(manifest.notarizationStatus, "not-run");
    assert.equal((await readFile(artifact)).toString(), "phase6 artifact");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("service manifest addresses complete API and Device Node bundles", () => {
  const artifacts = getServiceBundleArtifacts("/tmp/jarvis-phase6-services");
  assert.deepEqual(artifacts.map(artifact => artifact.kind), [
    "jarvis-api-darwin-arm64-bundle",
    "jarvis-device-node-darwin-arm64-bundle"
  ]);
  assert.match(artifacts[0].path, /Jarvis\.Api-darwin-arm64\.tar\.gz$/);
  assert.match(artifacts[1].path, /Jarvis\.DeviceNode-darwin-arm64\.tar\.gz$/);
});

test("macOS service publish is self-contained and lockfile-repeatable", async () => {
  const script = await readFile(join(process.cwd(), "eng/scripts/publish-macos-arm64.sh"), "utf8");
  assert.match(script, /--self-contained true/);
  assert.match(script, /--no-restore/);
  assert.match(script, /--locked-mode/);
  assert.match(script, /publish_parent=.*jarvis-phase6-publish/);
  assert.match(script, /publish_root=.*publish_parent/);
  assert.match(script, /packages\.lock\.json/);
  assert.match(script, /lock_snapshot_before/);
  assert.match(script, /deterministic-archive\.mjs/);
  const desktopScript = await readFile(join(process.cwd(), "eng/scripts/package-desktop-macos.sh"), "utf8");
  assert.match(desktopScript, /deterministic-archive\.mjs/);
  assert.match(desktopScript, /node "\$desktop_root\/scripts\/assert-package\.mjs" "\$app_source\/Contents\/Resources\/app\.asar"/);
  assert.match(desktopScript, /marker_wake_bridge=/);
  assert.match(desktopScript, /marker_wake_state=/);
  assert.match(desktopScript, /\$marker_wake_bridge.*true/);
  assert.match(desktopScript, /\$marker_wake_state.*standby/);
  assert.match(desktopScript, /persisted_marker_wake_bridge=/);
  assert.match(desktopScript, /persisted_marker_wake_state=/);
  const userDataAssignment = desktopScript.indexOf('user_data_root="$install_root/user-data"');
  const userDataMkdir = desktopScript.indexOf('mkdir -m 700 "$user_data_root"');
  const userDataArgument = desktopScript.indexOf('--user-data-dir="$user_data_root"');
  assert.ok(userDataAssignment >= 0, "Smoke userData must be rooted in its temporary install directory.");
  assert.ok(userDataMkdir > userDataAssignment, "Smoke userData must be created after install_root.");
  assert.ok(userDataArgument > userDataMkdir, "Smoke must pass the owner-only userData to the installed app.");
  assert.doesNotMatch(desktopScript, /--user-data-dir="\$install_root(?:"|[^/])/);
});

test("Desktop bearer smoke checks encryption, permissions, restart reuse, and redaction", async () => {
  const desktopScript = await readFile(join(process.cwd(), "eng/scripts/package-desktop-macos.sh"), "utf8");
  assert.match(desktopScript, /smoke_bearer="desktop-smoke-not-a-real-secret-0001"/);
  assert.match(desktopScript, /assert_secure_smoke_credential/);
  assert.match(desktopScript, /credential_directory=.*credentials/);
  assert.match(desktopScript, /stat -f '%Lp' "\$credential_directory"/);
  assert.match(desktopScript, /stat -f '%Lp' "\$credential_path"/);
  assert.match(desktopScript, /assert_smoke_does_not_echo_bearer/);
  assert.match(desktopScript, /renderer-ready-from-keychain\.json/);

  const operatorGuide = await readFile(join(process.cwd(), "eng/services/README.md"), "utf8");
  for (const section of ["Bootstrap", "Rotation", "Recovery", "Rollback"]) {
    assert.match(operatorGuide, new RegExp(`\\*\\*${section}:\\*\\*`));
  }
  assert.doesNotMatch(operatorGuide, /desktop-smoke-not-a-real-secret|Bearer\s+sk-[A-Za-z0-9]/i);
});

test("only the exact launchd service-not-found error is idempotently ignorable", () => {
  assert.equal(
    isServiceNotFoundError({ stderr: 'Could not find service "gui/501/com.hobocy.jarvis.api.phase6" in domain for system' }),
    true);
  assert.equal(
    isServiceNotFoundError({ stderr: 'Bad request.\nCould not find service "com.hobocy.jarvis.api.phase6" in domain for user gui: 501' }),
    true);
  assert.equal(isServiceNotFoundError({ stderr: "Bootstrap failed: 5: Input/output error" }), false);
  assert.equal(isServiceNotFoundError(new Error("permission denied")), false);
});

test("repeated install and uninstall only ignore an exact missing service", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-launchd-idempotence-"));
  const label = "com.hobocy.jarvis.api.phase6-idempotence";
  const templatePath = join(root, "template.plist");
  const calls = [];
  let loaded = false;
  const notFound = {
    stderr: `Bad request.\nCould not find service "${label}" in domain for user gui: 501`
  };
  const runner = (args) => {
    calls.push(args);
    if (args[0] === "print") {
      if (!loaded) {
        throw notFound;
      }
      return { status: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "bootout") {
      loaded = false;
    }
    if (args[0] === "bootstrap") {
      loaded = true;
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  const options = {
    root,
    label,
    executable: "/tmp/Jarvis.Api",
    workingDirectory: "/tmp/jarvis",
    templatePath,
    launchctlRunner: runner
  };

  try {
    await writeFile(templatePath, "<plist>__LABEL__ __EXECUTABLE__ __WORKING_DIRECTORY__ __DATA_DIRECTORY__ __LOG_DIRECTORY__</plist>");
    await uninstallService(options);
    await assert.rejects(() => readFile(join(root, `${label}.plist`)), /ENOENT/);
    await installService(options);
    await installService(options);
    await uninstallService(options);
    await uninstallService(options);

    assert.deepEqual(calls.map(args => args[0]), [
      "print", "print", "bootstrap", "print", "bootout", "bootstrap", "print", "bootout", "print"
    ]);
    await assert.rejects(
      () => installService({
        ...options,
        launchctlRunner: () => {
          const error = new Error("Bootstrap failed: 5: Input/output error");
          error.stderr = "Bootstrap failed: 5: Input/output error";
          throw error;
        }
      }),
      /Bootstrap failed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
