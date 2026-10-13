import { useEffect, useState } from "react";

type Clock = {
  startedAt: number;
  now: number;
};

/** Milliseconds since `running` became true, refreshed ten times a second; 0 while idle. */
export function useElapsed(running: boolean): number {
  const [clock, setClock] = useState<Clock | null>(null);

  useEffect(() => {
    if (!running) return;
    const startedAt = performance.now();
    setClock({ startedAt, now: startedAt });
    const timer = window.setInterval(() => setClock({ startedAt, now: performance.now() }), 100);
    return () => {
      window.clearInterval(timer);
      setClock(null);
    };
  }, [running]);

  return running && clock ? clock.now - clock.startedAt : 0;
}
