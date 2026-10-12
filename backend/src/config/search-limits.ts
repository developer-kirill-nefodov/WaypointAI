/**
 * Bounds shared by the event search endpoint, the natural-language query, the model tool schema,
 * the rule parser, and source validation, so every entry point accepts the same ranges.
 */
export const SEARCH_LIMITS = {
  radiusKm: { default: 25, max: 300 },
  hours: { default: 7 * 24, max: 2160 },
  magnitude: { min: -3, max: 11 },
  /** Time window of GET /investigations/events. */
  windowDays: { default: 7, max: 90 },
  /** Page size of GET /investigations/events. */
  eventPageLimit: { default: 50, max: 200 },
  /** Rows returned for one natural-language query. */
  queryResultLimit: 50,
  /** Source IDs accepted in one filter; extra IDs are ignored. */
  maxSourceIds: 20,
} as const;
