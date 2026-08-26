import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const mobileRoot = resolve(root, "src/clients/mobile");
const requireBundles = process.argv.includes("--require-bundles");

const packageJson = JSON.parse(await readFile(join(mobileRoot, "package.json"), "utf8"));
const exactDependencies = {
  "react-native": "0.87.0",
  "react-native-incall-manager": "4.2.1",
  "react-native-webrtc": "124.0.8",
  "react-native-keychain": "10.0.0",
  "@openai/agents-realtime": "0.17.0"
};
for (const [name, version] of Object.entries(exactDependencies)) {
  if (packageJson.dependencies?.[name] !== version) {
    fail(`${name} must be pinned to ${version}.`);
  }
}
if (packageJson.dependencies?.["@openai/agents"]) {
  fail("Mobile must use @openai/agents-realtime, not the browser agent package.");
}
const agentsPackagePath = resolve(root, "node_modules/@openai/agents-realtime/package.json");
if (!existsSync(agentsPackagePath)) {
  fail("@openai/agents-realtime must be installed before the mobile gate runs.");
}
const agentsPackage = JSON.parse(await readFile(agentsPackagePath, "utf8"));
if (!agentsPackage.exports?.["."]?.["react-native"]) {
  fail("@openai/agents-realtime must expose a react-native package condition.");
}

const manifest = await readFile(join(mobileRoot, "android/app/src/main/AndroidManifest.xml"), "utf8");
for (const permission of [
  "android.permission.INTERNET",
  "android.permission.RECORD_AUDIO",
  "android.permission.MODIFY_AUDIO_SETTINGS",
  "android.permission.BLUETOOTH",
  "android.permission.BLUETOOTH_ADMIN",
  "android.permission.BLUETOOTH_CONNECT"
]) {
  if (!manifest.includes(`android:name="${permission}"`)) {
    fail(`Android manifest is missing ${permission}.`);
  }
}
if (manifest.includes('android:usesCleartextTraffic="true"')) {
  fail("Android cleartext traffic must not be enabled unconditionally.");
}

const infoPlist = await readFile(join(mobileRoot, "ios/JarvisMobile/Info.plist"), "utf8");
for (const key of ["NSMicrophoneUsageDescription", "NSBluetoothAlwaysUsageDescription"]) {
  if (!infoPlist.includes(`<key>${key}</key>`)) {
    fail(`iOS Info.plist is missing ${key}.`);
  }
}
if (!infoPlist.includes("<key>NSAllowsArbitraryLoads</key>\n\t\t<false/>")) {
  fail("iOS arbitrary network loads must remain disabled.");
}

const audioRoute = await readFile(
  join(mobileRoot, "src/audio/reactNativeAudioRoute.ts"),
  "utf8");
if (!audioRoute.includes("react-native-incall-manager")) {
  fail("Mobile audio must use the cross-platform react-native-incall-manager adapter.");
}
if (audioRoute.includes("RTCAudioSession")) {
  fail("Mobile audio must not call the WebRTC iOS-only audio-session API.");
}
const podfile = await readFile(join(mobileRoot, "ios/Podfile"), "utf8");
if (!podfile.includes("use_native_modules!")) {
  fail("iOS Podfile must keep React Native native-module autolinking enabled.");
}
const androidSettings = await readFile(join(mobileRoot, "android/settings.gradle"), "utf8");
const androidBuild = await readFile(join(mobileRoot, "android/app/build.gradle"), "utf8");
if (!androidSettings.includes("autolinkLibrariesFromCommand")
  || !androidBuild.includes("autolinkLibrariesWithApp")) {
  fail("Android Gradle configuration must keep React Native native-module autolinking enabled.");
}

const transport = await readFile(
  join(mobileRoot, "src/realtime/ReactNativeWebRTCTransport.ts"),
  "utf8");
if (transport.includes("OpenAIRealtimeWebRTC") || transport.includes("registerGlobals")) {
  fail("Mobile transport must not use browser WebRTC globals.");
}
if (!transport.includes("/v1/realtime/calls")) {
  fail("Mobile transport must post SDP directly to OpenAI /v1/realtime/calls.");
}

const runtimeFiles = await filesUnder(join(mobileRoot, "src"));
const runtimeFindings = [];
for (const path of runtimeFiles.filter(path => !path.endsWith(".test.ts") && !path.endsWith(".test.tsx"))) {
  const content = await readFile(path, "utf8");
  if (/\bsk-[A-Za-z0-9]{20,}\b/.test(content)
    || content.includes("OpenAIRealtimeWebRTC")
    || content.includes("registerGlobals")
    || /\bnode:(?:fs|crypto|path|url|os)\b/.test(content)) {
    runtimeFindings.push(relative(root, path));
  }
}
if (runtimeFindings.length > 0) {
  fail(`Mobile runtime contains a forbidden secret/browser/Node reference: ${runtimeFindings.join(", ")}.`);
}

const bundlePaths = [
  join(mobileRoot, "android/app/src/main/assets/index.android.bundle"),
  join(mobileRoot, "ios/main.jsbundle")
];
const missingBundles = bundlePaths.filter(path => !existsSync(path));
if (missingBundles.length > 0 && requireBundles) {
  fail(`Release Metro bundles are required but missing: ${missingBundles.map(path => relative(root, path)).join(", ")}.`);
}
for (const path of bundlePaths.filter(path => existsSync(path))) {
  const content = await readFile(path, "utf8");
  // The SDK's shared export module contains the browser transport symbol as
  // dead code. The safety gate rejects invocation/global registration, not a
  // vendor export name that Metro cannot tree-shake from RealtimeSession.
  if (/\bsk-[A-Za-z0-9]{20,}\b/.test(content)
    || /\bnew\s+OpenAIRealtimeWebRTC\b/.test(content)
    || /\bregisterGlobals\s*\(/.test(content)
    || /\bnode:(?:fs|crypto|path|url|os)\b/.test(content)) {
    fail(`Metro bundle contains a forbidden secret/browser/Node reference: ${relative(root, path)}.`);
  }
}

console.log(`Mobile native configuration and runtime scans passed${missingBundles.length > 0 ? " (bundles not present; use --require-bundles for release gate)" : " with Android and iOS bundles"}.`);

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "Pods") {
      continue;
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await filesUnder(path));
    } else if (/\.(?:ts|tsx)$/.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

function fail(message) {
  throw new Error(message);
}
