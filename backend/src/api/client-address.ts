import type { IncomingMessage } from "node:http";

/**
 * Client address for per-client limits. Forwarded headers count only when TRUST_PROXY names the number of
 * trusted proxy hops, mirroring Express's "trust proxy" setting; otherwise the socket address is used.
 */
export function clientAddress(request: Pick<IncomingMessage, "headers" | "socket">, trustProxy: false | number): string {
  const socketAddress = request.socket.remoteAddress ?? "unknown";
  if (trustProxy === false) return socketAddress;
  const header = request.headers["x-forwarded-for"];
  const hops = (Array.isArray(header) ? header.join(",") : header ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  return hops[hops.length - trustProxy] ?? hops[0] ?? socketAddress;
}
