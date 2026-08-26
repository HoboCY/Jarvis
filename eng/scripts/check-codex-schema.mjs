import { strict as assert } from "node:assert";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(new URL("../..", import.meta.url).pathname);
const schemaRoot = resolve(root, "artifacts/codex-schema/0.146.0");
const versions = JSON.parse(await readFile(resolve(root, "eng/versions.json"), "utf8"));
if (versions.codex?.version !== "0.146.0") {
  throw new Error("eng/versions.json and the checked-in Codex schema version do not match.");
}

async function jsonFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await jsonFiles(path));
    } else if (entry.name.endsWith(".json")) {
      files.push(path);
    }
  }
  return files;
}

const files = await jsonFiles(schemaRoot);
if (files.length === 0) {
  throw new Error(`No Codex schema JSON found under ${schemaRoot}.`);
}

for (const file of files) {
  JSON.parse(await readFile(file, "utf8"));
}

const clientRequestPath = resolve(schemaRoot, "ClientRequest.json");
const clientRequest = JSON.parse(await readFile(clientRequestPath, "utf8"));
assert(Array.isArray(clientRequest.oneOf), "ClientRequest schema must expose a oneOf request union.");

const requestVariants = new Map();
for (const variant of clientRequest.oneOf) {
  const methods = variant.properties?.method?.enum;
  assert(Array.isArray(methods) && methods.length === 1, "Each ClientRequest union member must have one method enum value.");
  const [method] = methods;
  assert(!requestVariants.has(method), `ClientRequest contains duplicate method union member: ${method}`);
  requestVariants.set(method, variant);
}

const requiredRequests = {
  initialize: {
    params: "InitializeParams",
    requiredParams: ["clientInfo"]
  },
  "thread/start": {
    params: "ThreadStartParams",
    requiredParams: []
  },
  "thread/resume": {
    params: "ThreadResumeParams",
    requiredParams: ["threadId"]
  },
  "turn/start": {
    params: "TurnStartParams",
    requiredParams: ["input", "threadId"]
  },
  "turn/interrupt": {
    params: "TurnInterruptParams",
    requiredParams: ["threadId", "turnId"]
  }
};

for (const [method, expected] of Object.entries(requiredRequests)) {
  const variant = requestVariants.get(method);
  assert(variant, `ClientRequest method union is missing ${method}.`);
  assert.deepEqual(
    variant.required,
    ["id", "method", "params"],
    `${method} request must require id, method, and params.`
  );
  assert.equal(
    variant.properties.params?.$ref,
    `#/definitions/${expected.params}`,
    `${method} must reference ${expected.params}.`
  );

  const paramsSchema = clientRequest.definitions?.[expected.params];
  assert(paramsSchema, `${expected.params} definition is missing.`);
  assert.equal(paramsSchema.type, "object", `${expected.params} must be an object schema.`);
  assert.deepEqual(
    paramsSchema.required ?? [],
    expected.requiredParams,
    `${expected.params} required params changed.`
  );
}

const initializeParams = clientRequest.definitions.InitializeParams;
assert.equal(
  initializeParams.properties.clientInfo.$ref,
  "#/definitions/ClientInfo",
  "initialize.clientInfo must reference ClientInfo."
);
assert.deepEqual(
  clientRequest.definitions.ClientInfo.required,
  ["name", "version"],
  "ClientInfo must require name and version."
);

const threadStartProperties = clientRequest.definitions.ThreadStartParams.properties;
assert.deepEqual(threadStartProperties.cwd.type, ["string", "null"], "thread/start.cwd shape changed.");
assert.deepEqual(threadStartProperties.model.type, ["string", "null"], "thread/start.model shape changed.");

const turnStartProperties = clientRequest.definitions.TurnStartParams.properties;
assert.equal(turnStartProperties.threadId.type, "string", "turn/start.threadId must be a string.");
assert.equal(turnStartProperties.input.type, "array", "turn/start.input must be an array.");
assert.equal(
  turnStartProperties.input.items.$ref,
  "#/definitions/UserInput",
  "turn/start.input must contain UserInput values."
);

const turnInterruptProperties = clientRequest.definitions.TurnInterruptParams.properties;
assert.equal(turnInterruptProperties.threadId.type, "string", "turn/interrupt.threadId must be a string.");
assert.equal(turnInterruptProperties.turnId.type, "string", "turn/interrupt.turnId must be a string.");

function unionMethods(schema, name) {
  assert(Array.isArray(schema.oneOf), `${name} schema must expose a oneOf union.`);
  return new Map(schema.oneOf.map(variant => {
    const methods = variant.properties?.method?.enum;
    assert(Array.isArray(methods) && methods.length === 1, `${name} union members need one method enum.`);
    return [methods[0], variant];
  }));
}

const serverNotification = JSON.parse(await readFile(resolve(schemaRoot, "ServerNotification.json"), "utf8"));
const serverRequest = JSON.parse(await readFile(resolve(schemaRoot, "ServerRequest.json"), "utf8"));
const notificationMethods = unionMethods(serverNotification, "ServerNotification");
const serverRequestMethods = unionMethods(serverRequest, "ServerRequest");
for (const method of [
  "thread/started",
  "turn/started",
  "item/started",
  "item/completed",
  "turn/completed",
  "serverRequest/resolved"
]) {
  assert(notificationMethods.has(method), `ServerNotification is missing ${method}.`);
}
for (const method of [
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval"
]) {
  const variant = serverRequestMethods.get(method);
  assert(variant, `ServerRequest is missing ${method}.`);
  assert.deepEqual(variant.required, ["id", "method", "params"], `${method} request shape changed.`);
}

for (const [file, definition] of [
  ["CommandExecutionRequestApprovalResponse.json", "CommandExecutionApprovalDecision"],
  ["FileChangeRequestApprovalResponse.json", "FileChangeApprovalDecision"]
]) {
  const response = JSON.parse(await readFile(resolve(schemaRoot, file), "utf8"));
  assert.deepEqual(response.required, ["decision"], `${file} required fields changed.`);
  const decisions = response.definitions?.[definition]?.oneOf
    ?.flatMap(variant => variant.enum ?? []);
  assert.deepEqual(decisions, ["accept", "acceptForSession", "decline", "cancel"], `${definition} enum changed.`);
}

const permissionsResponse = JSON.parse(await readFile(
  resolve(schemaRoot, "PermissionsRequestApprovalResponse.json"),
  "utf8"));
assert.deepEqual(permissionsResponse.required, ["permissions"], "Permission approval response fields changed.");
assert.deepEqual(
  permissionsResponse.definitions?.PermissionGrantScope?.enum,
  ["turn", "session"],
  "Permission approval scope enum changed."
);

console.log(
  `Codex schema contract passed for ${files.length} JSON file(s); ` +
  `${requestVariants.size} ClientRequest, ${notificationMethods.size} ServerNotification, and ` +
  `${serverRequestMethods.size} ServerRequest union members checked.`
);
