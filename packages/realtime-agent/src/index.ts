export const realtimeToolNames = ["delegate_task", "get_task_status", "cancel_task", "remember_fact"] as const;

export type RealtimeToolName = (typeof realtimeToolNames)[number];

export type TextOnlyResponseEvent = {
  type: "response.create";
  response: {
    output_modalities: ["text"];
  };
};

export function createTextOnlyResponseEvent(): TextOnlyResponseEvent {
  return {
    type: "response.create",
    response: { output_modalities: ["text"] }
  };
}
