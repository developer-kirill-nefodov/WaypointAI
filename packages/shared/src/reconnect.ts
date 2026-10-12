/** WebSocket close codes the assistant server uses (RFC 6455 / IANA registry). */
export const WS_CLOSE_GOING_AWAY = 1001;
export const WS_CLOSE_SERVICE_RESTART = 1012;

export const RECONNECT_BASE_DELAY_MS = 500;
export const RECONNECT_MAX_DELAY_MS = 15_000;
/** After a "service restart" close, wait about as long as a dev restart takes before the first health check. */
export const SERVICE_RESTART_GRACE_MS = 1_200;

/**
 * Delay before reconnect attempt `attempt` (1-based): exponential growth capped at the maximum, with
 * "equal jitter" (half fixed, half random) so many clients do not reconnect in lockstep after a restart.
 */
export function reconnectDelay(attempt: number, random: () => number = Math.random): number {
  const exponent = Math.max(0, Math.floor(attempt) - 1);
  const ceiling = Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * 2 ** exponent);
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}
