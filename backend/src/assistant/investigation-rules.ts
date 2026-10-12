import { SEARCH_LIMITS } from "../config/search-limits.js";
import type { SearchEventsArgs } from "../tools/search-events.js";

const EVENT_WORD = /earthquake|quake|seismic|tremor|\bevents?\b|землетряс|толч|сейсм|событи|erdbeben|beben|ereignis|seism|terremot/i;
const PERIOD_PATTERN = /(?:last|past|за\s+последние|за|letzten|vergangenen)\s+(\d{1,6})\s*(hours?|hrs?|h|days?|час[а-яё]*|ч|дн[а-яё]*|день|суток|stunden?|tage?n?)/i;
const RADIUS_PATTERN = /(?:within|radius(?:\s+of)?|в\s+радиусе|im\s+umkreis\s+von|umkreis)\s*(\d+(?:[.,]\d+)?)\s*(?:km|км|kilometers?|километр[а-яё]*)/i;
const RADIUS_BEFORE_PLACE_PATTERN = /(\d+(?:[.,]\d+)?)\s*(?:km|км)\s+(?:of|from|around|near|от|вокруг|возле|von|um|bei)\b/i;
const MAGNITUDE_PATTERN = /(?:magnitude|mag\.?|магнитуд[а-яё]*|stärke)\s*(?:above|over|greater\s+than|at\s+least|>=?|больше|выше|не\s+меньше|от|über|ab|mindestens)?\s*(\d+(?:[.,]\d+)?)/i;
const MAGNITUDE_PLUS_PATTERN = /\bM\s?(\d(?:[.,]\d)?)\s*\+/i;
const SELECTION_PATTERN = /\b(?:this|the\s+selected)\s+(?:location|point|event|place)\b|\bhere\b|этой\s+точк\w*|этого\s+места|выбранн\w+\s+(?:точк\w*|событи\w*|мест\w*)|здесь|\bhier\b|diese[mn]?\s+(?:ort|punkt|ereignis)/i;
// A capitalized settlement name after a spatial preposition, for example "near Norcia" or "от Norcia".
const PLACE_PATTERN = /(?:\bof|\bnear|\baround|\bfrom|\bin|от|около|возле|рядом\s+с|вокруг|\bvon|\bbei|\bum)\s+([A-ZÀ-ÖØ-Þ][\p{L}'’-]+(?:\s+(?:(?:di|del|della|sul|in)\s+)?[A-ZÀ-ÖØ-Þ][\p{L}'’-]+)*)/u;

/**
 * Deterministic interpretation for common phrasings in English, Russian, and German.
 * Used when the model is unavailable, busy, or returns an invalid tool call. Returns null if nothing is recognized.
 */
export function interpretWithRules(text: string): SearchEventsArgs | null {
  const value = text.trim();
  const args: SearchEventsArgs = {};

  const hours = parseHours(value);
  if (hours !== null) args.hours = hours;

  const radius = value.match(RADIUS_PATTERN) ?? value.match(RADIUS_BEFORE_PLACE_PATTERN);
  if (radius) args.radiusKm = clamp(parseDecimal(radius[1]!), 1, SEARCH_LIMITS.radiusKm.max);

  const magnitude = value.match(MAGNITUDE_PATTERN) ?? value.match(MAGNITUDE_PLUS_PATTERN);
  if (magnitude) {
    args.minMagnitude = clamp(parseDecimal(magnitude[1]!), SEARCH_LIMITS.magnitude.min, SEARCH_LIMITS.magnitude.max);
  }

  if (SELECTION_PATTERN.test(value)) {
    args.nearSelection = true;
  } else {
    const place = value.match(PLACE_PATTERN);
    if (place) args.place = place[1]!.trim();
  }

  // A bare place ("weather in Rome") is not an event search unless the text is about events.
  const hasConstraint = args.hours !== undefined
    || args.radiusKm !== undefined
    || args.minMagnitude !== undefined
    || args.nearSelection;
  if (!hasConstraint && !EVENT_WORD.test(value)) return null;
  if ((args.place || args.nearSelection) && args.radiusKm === undefined) {
    args.radiusKm = SEARCH_LIMITS.radiusKm.default;
  }
  return Object.keys(args).length ? args : null;
}

function parseHours(value: string): number | null {
  if (/\b(?:today|last\s+day)\b|сегодня|за\s+(?:последние\s+)?сутки|\bheute\b|letzten\s+tag/i.test(value)) return 24;
  if (/\b(?:last|past|this)\s+week\b|за\s+(?:последнюю\s+)?неделю|letzte[nr]?\s+woche/i.test(value)) return 168;
  if (/\b(?:last|past|this)\s+month\b|за\s+(?:последний\s+)?месяц|letzte[nr]?\s+monat/i.test(value)) return 720;
  const match = value.match(PERIOD_PATTERN);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2]!.toLowerCase();
  const hours = /^(?:h|hrs?|hours?|час|ч|stunde)/.test(unit) ? amount : amount * 24;
  return clamp(Math.round(hours), 1, SEARCH_LIMITS.hours.max);
}

function parseDecimal(value: string): number {
  return Number(value.replace(",", "."));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
