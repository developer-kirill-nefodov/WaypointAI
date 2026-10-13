import { reconnectDelay, SERVICE_RESTART_GRACE_MS, WS_CLOSE_SERVICE_RESTART, type ServerFrame } from "@waypoint-ai/shared";
import { apiBase, websocketUrl, type ConnectionState } from "./client";

const HEALTH_TIMEOUT_MS = 3_000;
const NORMAL_CLOSE = 1000;

/** Reconnect progress for the UI; null while connected or on the first attempt. */
export type ReconnectInfo = { attempt: number; retryInMs: number } | null;

export type AssistantConnectionHandlers = {
  onFrame: (frame: ServerFrame) => void;
  onState: (state: ConnectionState, reconnect: ReconnectInfo) => void;
  /** Called with the new socket after every successful (re)connect. */
  onOpen: (socket: WebSocket) => void;
  /** Called when an open socket closes, before a reconnect is scheduled. */
  onClose: () => void;
};

export type AssistantConnection = {
  /** Skip the remaining backoff delay and try now (manual button, network back online, tab visible). */
  reconnectNow: () => void;
  /** Close for good, for example when the page unmounts. */
  close: () => void;
};

/**
 * Keeps the assistant WebSocket connected:
 * - checks GET /api/v1/healthz before opening a socket, so no WebSocket is attempted while the server restarts;
 * - retries with exponential backoff and jitter, and never gives up;
 * - retries at once when the network comes back or the tab becomes visible.
 * In-flight turns are not resent: a model turn is not idempotent.
 */
export function createAssistantConnection(handlers: AssistantConnectionHandlers): AssistantConnection {
  let socket: WebSocket | null = null;
  let attempt = 0;
  let retryTimer: number | undefined;
  let connecting = false;
  let closed = false;

  const scheduleRetry = (minimumDelayMs = 0) => {
    attempt += 1;
    const delay = Math.max(minimumDelayMs, reconnectDelay(attempt));
    handlers.onState("connecting", { attempt, retryInMs: delay });
    retryTimer = window.setTimeout(() => void connect(), delay);
  };

  const connect = async () => {
    window.clearTimeout(retryTimer);
    if (closed || connecting || socket) return;
    connecting = true;
    const healthy = await isServerHealthy();
    connecting = false;
    if (closed || socket) return;
    if (!healthy) {
      scheduleRetry();
      return;
    }
    openSocket();
  };

  const openSocket = () => {
    const next = new WebSocket(websocketUrl);
    socket = next;
    next.addEventListener("open", () => {
      attempt = 0;
      handlers.onState("connected", null);
      handlers.onOpen(next);
    });
    next.addEventListener("message", (event: MessageEvent<string>) => {
      const frame = parseFrame(event.data);
      if (frame) handlers.onFrame(frame);
    });
    // "error" is always followed by "close", which owns the reconnect.
    next.addEventListener("close", (event) => {
      if (socket !== next) return;
      socket = null;
      handlers.onClose();
      if (closed) return;
      // A planned restart: start the backoff over, but give the server time to come back first.
      if (event.code === WS_CLOSE_SERVICE_RESTART) {
        attempt = 0;
        scheduleRetry(SERVICE_RESTART_GRACE_MS);
        return;
      }
      scheduleRetry();
    });
  };

  const reconnectNow = () => {
    if (closed || socket) return;
    window.clearTimeout(retryTimer);
    void connect();
  };
  const onVisibilityChange = () => {
    if (document.visibilityState === "visible") reconnectNow();
  };

  window.addEventListener("online", reconnectNow);
  document.addEventListener("visibilitychange", onVisibilityChange);
  handlers.onState("connecting", null);
  void connect();

  return {
    reconnectNow,
    close: () => {
      closed = true;
      window.clearTimeout(retryTimer);
      window.removeEventListener("online", reconnectNow);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      socket?.close(NORMAL_CLOSE);
      socket = null;
    },
  };
}

async function isServerHealthy(): Promise<boolean> {
  try {
    const response = await fetch(`${apiBase}/api/v1/healthz`, { cache: "no-store", signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    return response.ok;
  } catch {
    return false;
  }
}

function parseFrame(data: string): ServerFrame | null {
  try {
    return JSON.parse(data) as ServerFrame;
  } catch {
    return null;
  }
}
