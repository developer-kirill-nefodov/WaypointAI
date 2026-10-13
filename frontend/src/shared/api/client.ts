import type { AssistantStatus, ClientFrame, ServerFrame, SourceView } from "@waypoint-ai/shared";

export type ConnectionState = "connecting" | "connected" | "disconnected";
export type Capabilities = { assistantStatus: AssistantStatus; modelLabel: string | null; demoMode: boolean; voiceInput?: boolean };
export type RoutePlan = { distanceMeters: number; durationSeconds: number; order: number[]; geometry: GeoJSON.LineString };

export const apiBase = import.meta.env.VITE_API_BASE ?? "";
export const websocketUrl = resolveWebSocketUrl();

function resolveWebSocketUrl(): string {
  const configured = import.meta.env.VITE_WS_URL;
  if (configured) return configured;
  const base = apiBase || window.location.origin;
  const url = new URL("/api/v1/assistant/ws", base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export async function loadCapabilities(signal?: AbortSignal): Promise<Capabilities> {
  const response = await fetch(`${apiBase}/api/v1/assistant/capabilities`, { signal });
  if (!response.ok) throw new Error("Unable to load assistant capabilities");
  return response.json() as Promise<Capabilities>;
}

export async function loadDataSources(signal?: AbortSignal): Promise<SourceView[]> {
  const response = await fetch(`${apiBase}/api/v1/data/sources`, { signal });
  if (!response.ok) throw new Error("Unable to load data sources");
  const payload = await response.json() as { sources: SourceView[] };
  return payload.sources;
}

export async function clearAssistantHistory(): Promise<void> {
  const response = await fetch(`${apiBase}/api/v1/assistant/history`, { method: "DELETE" });
  if (!response.ok) throw new Error("Unable to clear assistant history");
}

export async function buildRoute(points: Array<{ lat: number; lon: number }>, signal?: AbortSignal): Promise<RoutePlan> {
  const response = await fetch(`${apiBase}/api/v1/map/route`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ points }),
    signal,
  });
  if (!response.ok) throw new Error("Route calculation is unavailable");
  return response.json() as Promise<RoutePlan>;
}

export function sendClientFrame(socket: WebSocket | null, frame: ClientFrame): boolean {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(frame));
  return true;
}
