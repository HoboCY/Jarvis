export type MobileRealtimeBootstrapRequest = {
  conversationId: string;
  deviceId: string;
  preferredVoice: null;
};

export type MobileTaskRequest = {
  conversationId: string;
  sourceMessageIds: readonly string[];
  goal: string;
  expectedOutput: null;
  requiredCapabilities: readonly ["localFiles"] | readonly ["deepReasoning"];
  preferredDeviceId: string | null;
  attachmentRefs: readonly string[];
  capabilityEnvelope: {
    readFiles: true;
    writeFiles: false;
    runCommands: false;
    network: false;
    allowedRoots: readonly [string];
  } | null;
};

export type MobileTaskRequestInput = {
  conversationId: string;
  goal: string;
  allowedRoot: string;
  preferredDesktopDeviceId: string | undefined;
};

/** Realtime client-secret identity is always the paired Mobile Device. */
export function buildMobileRealtimeBootstrapRequest(
  conversationId: string,
  mobileDeviceId: string
): MobileRealtimeBootstrapRequest {
  const normalizedConversationId = requiredValue(conversationId, "A conversation is required.");
  const normalizedMobileDeviceId = requiredValue(mobileDeviceId, "A paired Mobile Device is required.");
  return {
    conversationId: normalizedConversationId,
    deviceId: normalizedMobileDeviceId,
    preferredVoice: null
  };
}

/** Only local-files work crosses the Desktop Device boundary. */
export function buildMobileTaskRequest(input: MobileTaskRequestInput): MobileTaskRequest {
  const conversationId = requiredValue(input.conversationId, "A conversation is required.");
  const goal = requiredValue(input.goal, "A task goal is required.");
  const allowedRoot = input.allowedRoot.trim();
  if (!allowedRoot) {
    return {
      conversationId,
      sourceMessageIds: [],
      goal,
      expectedOutput: null,
      requiredCapabilities: ["deepReasoning"],
      preferredDeviceId: null,
      attachmentRefs: [],
      capabilityEnvelope: null
    };
  }

  const preferredDesktopDeviceId = input.preferredDesktopDeviceId?.trim();
  if (!preferredDesktopDeviceId) {
    throw new Error("Select a Desktop Device before submitting a local-files task.");
  }
  return {
    conversationId,
    sourceMessageIds: [],
    goal,
    expectedOutput: null,
    requiredCapabilities: ["localFiles"],
    preferredDeviceId: preferredDesktopDeviceId,
    attachmentRefs: [],
    capabilityEnvelope: {
      readFiles: true,
      writeFiles: false,
      runCommands: false,
      network: false,
      allowedRoots: [allowedRoot]
    }
  };
}

function requiredValue(value: string, message: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(message);
  }
  return normalized;
}
