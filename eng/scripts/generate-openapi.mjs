import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { dirname, resolve } from "node:path";

const root = resolve(new URL("../..", import.meta.url).pathname);
const apiProject = resolve(root, "src/backend/Jarvis.Api/Jarvis.Api.csproj");
const openApiPath = resolve(root, "artifacts/openapi/openapi.json");
const contractsPath = resolve(root, "packages/contracts-ts/src/generated/openapi.ts");
const port = "45432";

await mkdir(dirname(openApiPath), { recursive: true });
await mkdir(dirname(contractsPath), { recursive: true });

const dotnet = spawn("dotnet", [
  "run",
  "--project",
  apiProject,
  "--no-restore",
  "--urls",
  `http://127.0.0.1:${port}`
], {
  cwd: root,
  stdio: "ignore",
  env: { ...process.env, ASPNETCORE_ENVIRONMENT: "Production" }
});

let ready = false;
try {
  const deadline = Date.now() + 30_000;
  while (!ready && Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/openapi/v1.json`);
      ready = response.ok;
    } catch {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    }
  }

  if (!ready) {
    throw new Error("Jarvis.Api did not expose OpenAPI within 30 seconds.");
  }

  const response = await fetch(`http://127.0.0.1:${port}/openapi/v1.json`);
  if (!response.ok) {
    throw new Error(`OpenAPI endpoint returned HTTP ${response.status}.`);
  }

  const document = JSON.parse(await response.text());
  await writeFile(openApiPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");

  const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const generator = spawn(pnpmCommand, [
    "exec",
    "openapi-typescript",
    openApiPath,
    "-o",
    contractsPath
  ], { cwd: root, stdio: "inherit" });
  const [result] = await once(generator, "close");
  if (result !== 0) {
    throw new Error(`openapi-typescript exited with code ${result}.`);
  }

  const generated = await readFile(contractsPath, "utf8");
  if (!generated.includes("export interface paths")) {
    throw new Error("Generated TypeScript contract does not export the paths interface.");
  }
  console.log(`OpenAPI generated: ${openApiPath}`);
  console.log(`TypeScript contract generated: ${contractsPath}`);
} finally {
  if (!dotnet.killed) {
    dotnet.kill("SIGTERM");
  }
}
