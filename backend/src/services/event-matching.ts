import { haversineDistanceMeters } from "../data/geo-sql.js";

/**
 * Rules for finding the same earthquake in two catalogues. Agencies locate an event from different stations, so the
 * origin time differs by seconds and the epicentre by kilometres; a match needs both to be close. Magnitude is not used
 * to find a match (agencies use different magnitude types), only to judge whether the two descriptions agree.
 */
export const MATCH_RULES = {
  maxTimeDeltaMs: 30_000,
  maxDistanceMeters: 50_000,
  /** A larger magnitude difference marks the match as a discrepancy. */
  maxMagnitudeDelta: 0.5,
  /** A larger depth difference marks a discrepancy: 10 km, or 10% of the depth for deep events. */
  minDepthToleranceKm: 10,
  depthToleranceRatio: 0.1,
} as const;

export interface MatchableEvent {
  id: string;
  sourceId: string;
  observedAt: Date;
  lat: number;
  lon: number;
  magnitude: number | null;
  depthKm: number | null;
}

export interface EventMatch {
  /** The pair is stored once, with the smaller ID first. */
  recordId: string;
  matchedRecordId: string;
  timeDeltaMs: number;
  distanceMeters: number;
  magnitudeDelta: number | null;
  depthDeltaKm: number | null;
  /** False when magnitude or depth differ more than the rules allow. */
  consistent: boolean;
}

/**
 * Pairs events of one source with events of other sources. Each event is matched at most once per other source;
 * pairs are chosen greedily from the closest (time and distance, each relative to its limit), so a burst of
 * aftershocks does not pair one event with several.
 */
export function matchEvents(events: MatchableEvent[], candidates: MatchableEvent[]): EventMatch[] {
  const sorted = [...candidates].sort((left, right) => left.observedAt.getTime() - right.observedAt.getTime());
  const times = sorted.map((candidate) => candidate.observedAt.getTime());
  const pairs: Array<{ event: MatchableEvent; candidate: MatchableEvent; timeDeltaMs: number; distanceMeters: number; score: number }> = [];
  for (const event of events) {
    const time = event.observedAt.getTime();
    for (let index = lowerBound(times, time - MATCH_RULES.maxTimeDeltaMs); index < sorted.length && times[index]! <= time + MATCH_RULES.maxTimeDeltaMs; index += 1) {
      const candidate = sorted[index]!;
      if (candidate.sourceId === event.sourceId) continue;
      const distanceMeters = haversineDistanceMeters(event, candidate);
      if (distanceMeters > MATCH_RULES.maxDistanceMeters) continue;
      const timeDeltaMs = Math.abs(times[index]! - time);
      pairs.push({ event, candidate, timeDeltaMs, distanceMeters, score: timeDeltaMs / MATCH_RULES.maxTimeDeltaMs + distanceMeters / MATCH_RULES.maxDistanceMeters });
    }
  }
  pairs.sort((left, right) => left.score - right.score || left.event.id.localeCompare(right.event.id) || left.candidate.id.localeCompare(right.candidate.id));
  // One match per event and other source, on both sides of the pair.
  const taken = new Set<string>();
  const matches: EventMatch[] = [];
  for (const { event, candidate, timeDeltaMs, distanceMeters } of pairs) {
    const eventKey = `${event.id}>${candidate.sourceId}`;
    const candidateKey = `${candidate.id}>${event.sourceId}`;
    if (taken.has(eventKey) || taken.has(candidateKey)) continue;
    taken.add(eventKey);
    taken.add(candidateKey);
    const magnitudeDelta = event.magnitude !== null && candidate.magnitude !== null ? round(Math.abs(event.magnitude - candidate.magnitude), 2) : null;
    const depthDeltaKm = event.depthKm !== null && candidate.depthKm !== null ? round(Math.abs(event.depthKm - candidate.depthKm), 1) : null;
    const depthTolerance = Math.max(MATCH_RULES.minDepthToleranceKm, MATCH_RULES.depthToleranceRatio * Math.max(event.depthKm ?? 0, candidate.depthKm ?? 0));
    const [recordId, matchedRecordId] = event.id < candidate.id ? [event.id, candidate.id] : [candidate.id, event.id];
    matches.push({
      recordId,
      matchedRecordId,
      timeDeltaMs,
      distanceMeters: Math.round(distanceMeters),
      magnitudeDelta,
      depthDeltaKm,
      consistent: (magnitudeDelta === null || magnitudeDelta <= MATCH_RULES.maxMagnitudeDelta) && (depthDeltaKm === null || depthDeltaKm <= depthTolerance),
    });
  }
  return matches;
}

function lowerBound(values: number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (values[middle]! < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
