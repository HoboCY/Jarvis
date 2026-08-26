import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildMobileRealtimeBootstrapRequest, buildMobileTaskRequest } from "./MobileRequestBuilders.js";

test("mobile realtime bootstrap only requires the paired mobile device", () => {
  assert.deepEqual(
    buildMobileRealtimeBootstrapRequest(
      "00000000-0000-7000-8000-000000000001",
      "00000000-0000-7000-8000-000000000002"),
    {
      conversationId: "00000000-0000-7000-8000-000000000001",
      deviceId: "00000000-0000-7000-8000-000000000002",
      preferredVoice: null
    });
});

test("local-files tasks require a selected desktop device while deep reasoning does not", () => {
  assert.throws(
    () => buildMobileTaskRequest({
      conversationId: "00000000-0000-7000-8000-000000000001",
      goal: "read the project",
      allowedRoot: "/tmp/project",
      preferredDesktopDeviceId: undefined
    }),
    /Desktop Device/);

  assert.deepEqual(
    buildMobileTaskRequest({
      conversationId: "00000000-0000-7000-8000-000000000001",
      goal: "summarize the issue",
      allowedRoot: "",
      preferredDesktopDeviceId: undefined
    }),
    {
      conversationId: "00000000-0000-7000-8000-000000000001",
      sourceMessageIds: [],
      goal: "summarize the issue",
      expectedOutput: null,
      requiredCapabilities: ["deepReasoning"],
      preferredDeviceId: null,
      attachmentRefs: [],
      capabilityEnvelope: null
    });
});
