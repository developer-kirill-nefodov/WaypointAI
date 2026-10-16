import type { Citation, PlaceView, RecordView } from "@waypoint-ai/shared";

/** Links to a source's own page are built from IDs and accepted only on these hosts. */
const SOURCE_PAGE_HOSTS = new Set(["terremoti.ingv.it", "earthquake.usgs.gov", "www.openstreetmap.org"]);
const MAX_CITATIONS = 20;
const OSM_PLACE_ID = /^osm:(node|way|relation):(\d{1,20})$/;
/** A bracket holding one or more refs: [E1], [P2], [E1, E3]. */
const REF_GROUP = /\s?\[((?:[EP]\d{1,3})(?:\s*[,;]\s*[EP]\d{1,3})*)\]/g;

/**
 * Short refs (E1 for events and records, P1 for places) for the rows a tool showed the model in one turn. The model
 * cites a row by writing its ref in brackets; refs it did not receive are removed from the answer, so a citation always
 * points to a row the database returned.
 */
export class CitationRegistry {
  readonly #byKey = new Map<string, Citation>();
  readonly #byRef = new Map<string, Citation>();
  #events = 0;
  #places = 0;

  /** The ref of a record, assigning the next one on first use. */
  citeRecord(record: RecordView): string {
    return this.#cite(`record:${record.id}`, () => ({
      ref: `E${++this.#events}`,
      entityType: "record",
      id: record.id,
      sourceId: record.sourceId,
      label: record.label.slice(0, 200),
      observedAt: record.observedAt,
      url: safeSourcePage(record.attributes.sourceEventUrl),
    }));
  }

  /** The ref of a place, assigning the next one on first use. */
  citePlace(place: PlaceView): string {
    return this.#cite(`place:${place.id}`, () => ({
      ref: `P${++this.#places}`,
      entityType: "place",
      id: place.id,
      sourceId: place.sourceId,
      label: place.name.slice(0, 200),
      url: osmPage(place.id),
    }));
  }

  /**
   * Adds a `ref` to every row of a tool result that the model sees. Rows are matched by ID to the full views the tool
   * returned, so a ref is only ever given to a row from the database.
   */
  annotate(content: unknown, rows: { records?: RecordView[]; places?: PlaceView[] }): unknown {
    if (!content || typeof content !== "object" || Array.isArray(content)) return content;
    const records = new Map((rows.records ?? []).map((record) => [record.id, record]));
    const places = new Map((rows.places ?? []).map((place) => [place.id, place]));
    const withRef = (item: unknown, find: (id: string) => string | undefined) => {
      if (!item || typeof item !== "object" || typeof (item as { id?: unknown }).id !== "string") return item;
      const ref = find((item as { id: string }).id);
      return ref ? { ref, ...item } : item;
    };
    const recordRef = (id: string) => { const record = records.get(id); return record ? this.citeRecord(record) : undefined; };
    const placeRef = (id: string) => { const place = places.get(id); return place ? this.citePlace(place) : undefined; };
    const result: Record<string, unknown> = { ...content };
    for (const key of ["events", "records"] as const) {
      if (Array.isArray(result[key])) result[key] = (result[key] as unknown[]).map((item) => withRef(item, recordRef));
    }
    if (result.record) result.record = withRef(result.record, recordRef);
    if (Array.isArray(result.places)) result.places = (result.places as unknown[]).map((item) => withRef(item, placeRef));
    return result;
  }

  /**
   * Checks the refs in a final answer. Known refs are kept as `[E1]`, one bracket per ref; unknown ones are removed.
   * When the answer cites nothing but rows were shown to the model, they are listed as the data behind the answer.
   */
  resolve(text: string): { text: string; citations: Citation[]; citationsMode?: "cited" | "shown_to_model" } {
    const cited: Citation[] = [];
    const cleaned = text.replace(REF_GROUP, (match, group: string) => {
      const known = group.split(/\s*[,;]\s*/).flatMap((ref) => this.#byRef.get(ref) ?? []);
      for (const citation of known) if (!cited.includes(citation)) cited.push(citation);
      return known.length ? `${match.startsWith(" ") ? " " : ""}${known.map((citation) => `[${citation.ref}]`).join("")}` : "";
    });
    if (cited.length) return { text: cleaned, citations: cited.slice(0, MAX_CITATIONS), citationsMode: "cited" };
    const shown = [...this.#byRef.values()].slice(0, MAX_CITATIONS);
    return shown.length ? { text: cleaned, citations: shown, citationsMode: "shown_to_model" } : { text: cleaned, citations: [] };
  }

  #cite(key: string, create: () => Citation): string {
    const existing = this.#byKey.get(key);
    if (existing) return existing.ref;
    const citation = create();
    this.#byKey.set(key, citation);
    this.#byRef.set(citation.ref, citation);
    return citation.ref;
  }
}

/** Refs belong to one turn; they are removed from the stored history so a later turn's E1 is not confused with them. */
export function stripCitationRefs(text: string): string {
  return text.replace(REF_GROUP, "");
}

function safeSourcePage(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && SOURCE_PAGE_HOSTS.has(url.hostname) ? url.toString() : null;
  } catch {
    return null;
  }
}

function osmPage(placeId: string): string | null {
  const match = OSM_PLACE_ID.exec(placeId);
  return match ? `https://www.openstreetmap.org/${match[1]}/${match[2]}` : null;
}
