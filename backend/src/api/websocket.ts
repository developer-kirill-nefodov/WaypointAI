import { randomUUID } from "node:crypto";
import type { ClientFrame, ServerFrame } from "@waypoint-ai/shared";
import type { IncomingMessage, Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { processTurn } from "../assistant/turn.js";
import { hasConversation } from "../data/conversation.repository.js";
import { env } from "../config/env.js";
import { ActiveTurnGate } from "./active-turn.js";
import { clientAddress } from "./client-address.js";
import { isAllowedOrigin } from "./origin.js";
import { closeAllClients, startHeartbeat } from "./websocket-lifecycle.js";
import { getCapabilities } from "../services/readiness.js";
import { validateClientFrame } from "../schemas/websocket.js";
import { isVoiceInputConfigured } from "../config/voice.js";
import { openRealtimeTranscription } from "../voice/openai-realtime.provider.js";
import { VoiceBudget } from "../voice/voice-budget.js";
import { isVoiceFrame, VoiceSessionManager } from "../voice/voice-session.js";

const VOICE_FINISH_TIMEOUT_MS = 10_000;
const VOICE_BUDGET_WINDOW_MS = 60 * 60 * 1000;

/** Attaches the assistant WebSocket; returns a function that closes every client, for graceful shutdown. */
export function attachWebSocket(server: Server): (code: number, reason: string) => Promise<void> {
  const websocketServer = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  const stopHeartbeat = startHeartbeat(websocketServer);
  const voiceBudget = new VoiceBudget({
    maxConcurrentSessions: env.VOICE_MAX_CONCURRENT_SESSIONS,
    maxSessionsPerClient: env.VOICE_SESSIONS_PER_CLIENT_PER_HOUR,
    maxSecondsPerClient: env.VOICE_SECONDS_PER_CLIENT_PER_HOUR,
    sessionSeconds: env.VOICE_MAX_SESSION_SECONDS,
    windowMs: VOICE_BUDGET_WINDOW_MS,
  });
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
    if (url.pathname !== "/api/v1/assistant/ws" || !isAllowedOrigin(request.headers.origin, env.FRONTEND_ORIGIN, env.NODE_ENV)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    websocketServer.handleUpgrade(request, socket, head, (websocket) => websocketServer.emit("connection", websocket, request));
  });

  websocketServer.on("connection", (websocket: WebSocket, request: IncomingMessage) => {
    const activeTurn = new ActiveTurnGate();
    const client = clientAddress(request, env.TRUST_PROXY);
    const voice = new VoiceSessionManager(
      {
        enabled: isVoiceInputConfigured(env),
        maxSessionMs: env.VOICE_MAX_SESSION_SECONDS * 1000,
        finishTimeoutMs: VOICE_FINISH_TIMEOUT_MS,
        acquireBudget: () => voiceBudget.tryAcquire(client),
      },
      openRealtimeTranscription,
      (event) => send(websocket, event),
    );
    websocket.on("message", async (raw) => {
      let frame: unknown;
      try { frame = JSON.parse(raw.toString()); } catch {
        send(websocket, { protocolVersion: 1, type: "turn.error", requestId: "invalid", code: "invalid_message", message: "Message must be valid JSON.", retryable: false });
        return;
      }
      if (!validateClientFrame?.(frame)) {
        const requestId = getRequestId(frame);
        send(websocket, { protocolVersion: 1, type: "turn.error", requestId, code: "invalid_message", message: getLanguage(frame) === "ru" ? "Формат сообщения не поддерживается." : "Unsupported message format.", retryable: false });
        return;
      }

      const clientFrame = frame as ClientFrame;
      if (isVoiceFrame(clientFrame)) {
        voice.handle(clientFrame);
      } else if (clientFrame.type === "session.start") {
        const capabilities = await getCapabilities();
        send(websocket, {
          protocolVersion: 1,
          type: "session.ready",
          requestId: clientFrame.requestId,
          connectionId: randomUUID(),
          assistantStatus: capabilities.assistantStatus,
          modelLabel: capabilities.modelLabel,
          demoMode: capabilities.demoMode,
          supportedFilters: capabilities.supportedFilters,
          voiceInput: capabilities.voiceInput,
        });
      } else if (clientFrame.type === "turn.cancel") {
        const currentTurn = activeTurn.current;
        if (currentTurn?.requestId === clientFrame.requestId) currentTurn.controller.abort();
        else send(websocket, { protocolVersion: 1, type: "turn.cancelled", requestId: clientFrame.requestId });
      } else {
        if (activeTurn.current) {
          send(websocket, { protocolVersion: 1, type: "turn.error", requestId: clientFrame.requestId, code: "busy", message: getLanguage(clientFrame) === "ru" ? "Сначала завершите текущий запрос в этом соединении." : "Finish the active request in this connection first.", retryable: true });
          return;
        }
        const controller = new AbortController();
        const turn = { requestId: clientFrame.requestId, controller };
        if (!activeTurn.tryAcquire(turn)) {
          send(websocket, { protocolVersion: 1, type: "turn.error", requestId: clientFrame.requestId, code: "busy", message: getLanguage(clientFrame) === "ru" ? "Сначала завершите текущий запрос в этом соединении." : "Finish the active request in this connection first.", retryable: true });
          return;
        }
        try {
          const workspaceId = clientFrame.scope.workspaceId ?? "demo";
          const candidateId = clientFrame.conversationId;
          const validId = candidateId && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidateId);
          let conversationId: string = randomUUID();
          if (validId) {
            try {
              if (await hasConversation(candidateId, workspaceId)) conversationId = candidateId;
            } catch {
              send(websocket, { protocolVersion: 1, type: "turn.error", requestId: clientFrame.requestId, code: "source_unavailable", message: getLanguage(clientFrame) === "ru" ? "Не удалось загрузить историю беседы из базы данных." : "Could not load conversation history from the database.", retryable: true });
              return;
            }
          }
          if (controller.signal.aborted) {
            send(websocket, { protocolVersion: 1, type: "turn.cancelled", requestId: clientFrame.requestId });
            return;
          }
          send(websocket, { protocolVersion: 1, type: "turn.accepted", requestId: clientFrame.requestId, conversationId });
          await processTurn(clientFrame, conversationId, controller.signal, (event) => send(websocket, event));
        } finally {
          activeTurn.release(turn);
        }
      }
    });
    websocket.on("close", () => {
      activeTurn.current?.controller.abort();
      voice.dispose();
    });
    websocket.on("error", () => {
      activeTurn.current?.controller.abort();
      voice.dispose();
    });
  });

  return (code, reason) => {
    stopHeartbeat();
    return closeAllClients(websocketServer, code, reason);
  };
}

function getRequestId(value: unknown): string {
  if (value && typeof value === "object" && "requestId" in value && typeof value.requestId === "string") return value.requestId.slice(0, 80);
  return "invalid";
}

function getLanguage(value: unknown): "en" | "ru" | "de" {
  if (!value || typeof value !== "object" || !("scope" in value)) return "en";
  const scope = value.scope;
  if (!scope || typeof scope !== "object" || !("language" in scope)) return "en";
  return scope.language === "ru" ? "ru" : scope.language === "de" ? "de" : "en";
}

function send(websocket: WebSocket, frame: ServerFrame): void {
  if (websocket.readyState === WebSocket.OPEN) websocket.send(JSON.stringify(frame));
}
