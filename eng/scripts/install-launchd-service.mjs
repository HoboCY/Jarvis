import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_API_PORT,
  installService,
  smokeService,
  statusService,
  uninstallService
} from "./launchd-service.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const templateDirectory = resolve(scriptDirectory, "../services/templates");

function parseArguments(argv) {
  const result = { action: argv[0], dryRun: false };
  for (let index = 1; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--dry-run") {
      result.dryRun = true;
      continue;
    }
    if (!value?.startsWith("--") || argv[index + 1] === undefined) {
      throw new Error(`Invalid argument: ${value ?? "<missing>"}`);
    }
    result[value.slice(2)] = argv[++index];
  }
  return result;
}

function required(options, name) {
  if (typeof options[name] !== "string" || options[name].length === 0) {
    throw new Error(`--${name} is required.`);
  }
  return options[name];
}

function templateFor(kind) {
  if (kind === "api") {
    return join(templateDirectory, "jarvis-api.plist.template");
  }
  if (kind === "device-node") {
    return join(templateDirectory, "jarvis-device-node.plist.template");
  }
  throw new Error("--kind must be api or device-node.");
}

export async function run(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const action = options.action;
  const root = required(options, "root");
  const label = required(options, "label");
  if (action === "install") {
    const paths = await installService({
      root,
      label,
      executable: required(options, "executable"),
      workingDirectory: required(options, "working-directory"),
      templatePath: templateFor(required(options, "kind")),
      apiPort: options["api-port"] ?? DEFAULT_API_PORT,
      dryRun: options.dryRun
    });
    console.log(JSON.stringify({ action, ...paths, dryRun: options.dryRun }));
    return;
  }
  if (action === "uninstall") {
    const paths = await uninstallService({ root, label, dryRun: options.dryRun });
    console.log(JSON.stringify({ action, ...paths, dryRun: options.dryRun }));
    return;
  }
  if (action === "status") {
    const result = statusService({ root, label, dryRun: options.dryRun });
    console.log(result.stdout || result);
    return;
  }
  if (action === "smoke") {
    const result = smokeService({ root, label, dryRun: options.dryRun });
    console.log(JSON.stringify({ action, ...result.paths, output: result.result.stdout, dryRun: options.dryRun }));
    return;
  }
  throw new Error("Action must be install, uninstall, status, or smoke.");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run().catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
