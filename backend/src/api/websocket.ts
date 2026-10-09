import { randomUUID } from "node:crypto";
import type { ClientFrame, ServerFrame } from "@waypoint-ai/shared";
import type { Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { processTurn } from "../assistant/turn.js";
import { hasConversation } from "../data/conversation.repository.js";
import { env } from "../config/env.js";
import { ActiveTurnGate } from "./active-turn.js";
import { getCapabilities } from "../services/readiness.js";
import { validateClientFrame } from "../schemas/websocket.js";

export function attachWebSocket(server: Server): void {
  const websocketServer = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
    if (url.pathname !== "/api/v1/assistant/ws" || request.headers.origin !== env.FRONTEND_ORIGIN) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    websocketServer.handleUpgrade(request, socket, head, (websocket) => websocketServer.emit("connection", websocket, request));
  });

  websocketServer.on("connection", (websocket: WebSocket) => {
    const activeTurn = new ActiveTurnGate();
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
      if (clientFrame.type === "session.start") {
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
    websocket.on("close", () => activeTurn.current?.controller.abort());
    websocket.on("error", () => activeTurn.current?.controller.abort());
  });
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
