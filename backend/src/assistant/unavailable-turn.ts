import type { ServerFrame } from "@waypoint-ai/shared";

export function assistantNotConfigured(requestId: string): ServerFrame {
  return {
    protocolVersion: 1,
    type: "turn.error",
    requestId,
    code: "internal_error",
    message: "The assistant request handler is not available yet.",
    retryable: false,
  };
}
