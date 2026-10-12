import { WebSocket, type WebSocketServer } from "ws";

export const HEARTBEAT_INTERVAL_MS = 25_000;
const CLOSE_WAIT_MS = 1_000;

/**
 * Pings every client on an interval and terminates clients that did not answer the previous ping.
 * This detects half-open connections (sleeping laptops, changed networks) that never send a close frame.
 * Browsers answer pings automatically.
 */
export function startHeartbeat(server: WebSocketServer, intervalMs = HEARTBEAT_INTERVAL_MS): () => void {
  const alive = new WeakMap<WebSocket, boolean>();
  server.on("connection", (client: WebSocket) => {
    alive.set(client, true);
    client.on("pong", () => alive.set(client, true));
  });
  const timer = setInterval(() => {
    for (const client of server.clients) {
      if (alive.get(client) === false) {
        client.terminate();
        continue;
      }
      alive.set(client, false);
      client.ping();
    }
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

/**
 * Sends a close frame to every client and resolves once they have closed (or after a short wait).
 * Closing cleanly before the process exits lets proxies end the connection instead of writing to a dead socket.
 */
export function closeAllClients(server: WebSocketServer, code: number, reason: string): Promise<void> {
  const open = [...server.clients].filter((client) => client.readyState === WebSocket.OPEN);
  if (!open.length) return Promise.resolve();
  const closed = open.map((client) => new Promise<void>((resolve) => {
    client.once("close", () => resolve());
    client.close(code, reason);
  }));
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, CLOSE_WAIT_MS).unref());
  return Promise.race([Promise.all(closed).then(() => undefined), timeout]);
}
