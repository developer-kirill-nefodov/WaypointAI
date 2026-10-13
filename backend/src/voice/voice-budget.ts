export interface VoiceBudgetConfig {
  /** Sessions open at the same time across all connections. */
  maxConcurrentSessions: number;
  /** Sessions one client may start per window. */
  maxSessionsPerClient: number;
  /** Seconds of recording one client may use per window, counting each session's full allowance. */
  maxSecondsPerClient: number;
  /** Seconds one session may last; reserved up front so a client cannot exceed its budget mid-session. */
  sessionSeconds: number;
  windowMs: number;
}

export type VoiceBudgetDecision =
  | { ok: true; release: () => void }
  | { ok: false; reason: "server_busy" | "client_limit" };

interface ClientUsage {
  sessions: number;
  seconds: number;
  resetAt: number;
}

/**
 * Shared spending limits for the paid transcription provider. One instance serves the whole process:
 * a global cap on open sessions plus a fixed-window budget per client address, so neither many
 * connections nor one aggressive client can run up the provider bill.
 */
export class VoiceBudget {
  #active = 0;
  readonly #clients = new Map<string, ClientUsage>();

  constructor(
    private readonly config: VoiceBudgetConfig,
    private readonly now: () => number = Date.now,
  ) {}

  tryAcquire(clientKey: string): VoiceBudgetDecision {
    const time = this.now();
    this.#sweep(time);
    if (this.#active >= this.config.maxConcurrentSessions) return { ok: false, reason: "server_busy" };
    let usage = this.#clients.get(clientKey);
    if (!usage || usage.resetAt <= time) {
      usage = { sessions: 0, seconds: 0, resetAt: time + this.config.windowMs };
      this.#clients.set(clientKey, usage);
    }
    if (usage.sessions >= this.config.maxSessionsPerClient
      || usage.seconds + this.config.sessionSeconds > this.config.maxSecondsPerClient) {
      return { ok: false, reason: "client_limit" };
    }
    usage.sessions += 1;
    usage.seconds += this.config.sessionSeconds;
    this.#active += 1;
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        this.#active -= 1;
      },
    };
  }

  #sweep(time: number): void {
    for (const [key, usage] of this.#clients) {
      if (usage.resetAt <= time) this.#clients.delete(key);
    }
  }
}
