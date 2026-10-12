const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Checks a WebSocket Origin header against the configured frontend origin.
 * Production requires an exact match. Development also accepts the other loopback
 * aliases with the same scheme and port, because the dev server is reachable as
 * localhost, 127.0.0.1, or [::1].
 */
export function isAllowedOrigin(origin: string | undefined, frontendOrigin: string, nodeEnv: string): boolean {
  if (!origin) return false;
  if (origin === frontendOrigin) return true;
  if (nodeEnv !== "development") return false;
  const candidate = parseOrigin(origin);
  const configured = parseOrigin(frontendOrigin);
  if (!candidate || !configured) return false;
  return LOOPBACK_HOSTS.has(configured.hostname)
    && LOOPBACK_HOSTS.has(candidate.hostname)
    && candidate.protocol === configured.protocol
    && candidate.port === configured.port;
}

function parseOrigin(value: string): URL | undefined {
  try {
    const url = new URL(value);
    // An Origin header carries only scheme, host, and port.
    return url.origin === value.replace(/\/$/, "") ? url : undefined;
  } catch {
    return undefined;
  }
}
