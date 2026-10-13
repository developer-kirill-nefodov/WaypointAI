# Technical decisions: Investigation Workspace

Status: **implemented** (demo). Builds on the audit in [extension-plan.md](extension-plan.md). Source behavior below was checked with live requests on 2026-10-13; terms were read from the providers' own pages on the same date.

## 1. External data source

### Candidates

All three are FDSN event web services (the international seismology standard), so they share query parameters: `starttime`, `endtime`, rectangle (`minlatitude` …), circle (`latitude`, `longitude`, `maxradius`/`maxradiuskm`), `minmagnitude`, `limit`, `orderby`.

Measured with a Central Italy box (lat 41–44.5, lon 10–15), which matches the imported `osm-it-centro` extract (about 644,000 places):

| | INGV FDSN | USGS FDSN | EMSC SeismicPortal |
|---|---|---|---|
| Operator | Istituto Nazionale di Geofisica e Vulcanologia (Italy) | U.S. Geological Survey | Euro-Mediterranean Seismological Centre |
| Endpoint | `https://webservices.ingv.it/fdsnws/event/1/query` | `https://earthquake.usgs.gov/fdsnws/event/1/query` | `https://www.seismicportal.eu/fdsnws/event/1/query` |
| License | CC BY 4.0 (ONT site licence notice) | U.S. public domain; credit "U.S. Geological Survey" requested | CC BY 4.0 for datasets, **but commercial reproduction or transmission requires prior written permission** |
| Credentials | None | None | None |
| GeoJSON | Yes (`format=geojson`) | Yes (`format=geojson`) | Yes (`format=json`) |
| Events, Central Italy, last 30 days | **799** | 0 | 42 |
| Events, Central Italy, last 365 days | — | 9 | — |
| Events, Romania box, 30 days / 365 days | not covered | 7 per year | 21 per 30 days |
| Max `limit` | 20,000 (`400` above) | 20,000 (`400` above) | 20,000 |
| Empty result | `204 No Content` | `200` with `features: []` | `204 No Content` |
| Documented rate limit | None found | None; real-time feeds recommended for display apps | None found |

### Decision

**Primary source: INGV FDSN event service.**

- **Density where we have entities.** About 800 events per month in the region where `places` already holds real OSM objects. This is the only option that gives a convincing "events near places" demo. USGS returned nothing for the same box and month.
- **License fits a client demo.** CC BY 4.0 allows commercial use with attribution. EMSC would need written permission for anything commercial.
- **No account, documented standard API, GeoJSON output, radius and magnitude filters on the server.**
- **No personal data.** Events describe natural phenomena, not people.

**Second adapter (optional): USGS.** Public domain and global. Adding it after INGV proves that a new source is one adapter, not a redesign. It is not the demo source because European coverage below magnitude 2.5 is sparse.

**Rejected: EMSC.** Good coverage, but the commercial-use clause makes it a poor default for client work.

### What INGV provides (verified response)

```json
{
  "type": "Feature",
  "properties": {
    "eventId": 47520802,
    "originId": 148004521,
    "time": "2026-10-13T05:57:19.510000",
    "author": "SURVEY-INGV",
    "magType": "ML",
    "mag": 1.1,
    "magAuthor": "--",
    "type": "earthquake",
    "place": "4 km S Cagli (PU)",
    "version": 100,
    "geojson_creationTime": "2026-10-13T06:58:47"
  },
  "geometry": { "type": "Point", "coordinates": [12.6492, 43.5133, 2.7] }
}
```

Details that matter for the adapter:

- **No top-level `id`.** The stable identifier is `properties.eventId`.
- **`time` has no timezone suffix.** FDSN times are UTC, so the adapter must parse it as UTC explicitly. `new Date("2026-10-13T05:57:19.51")` would use the server's local time zone.
- **Microseconds.** Six fractional digits; JavaScript `Date` keeps milliseconds. That precision loss is acceptable.
- **Coordinates are `[longitude, latitude, depthKm]`.**
- **No "updated" timestamp.** Revisions change `originId` and `version`. `geojson_creationTime` is when the response was generated, not when the event changed, so it must not be used for change detection.
- **`204` for no matches,** not an empty collection.
- **Errors are plain text** (`Error 400 … "limit" must be between 0 and "20000"`), not JSON.

### Mapping to the internal schema

| Internal field | INGV source | Notes |
|---|---|---|
| `records.id` | `"ingv-fdsn:" + eventId` | Deterministic, makes imports idempotent |
| `records.external_id` | `eventId` (string) | Unique with `source_id` |
| `records.source_id` | `"ingv-fdsn"` | Row in `data_sources` |
| `records.observed_at` | `time` parsed as UTC | Origin time of the event |
| `records.lat`, `records.lon` | `coordinates[1]`, `coordinates[0]` | Validated ranges |
| `records.category` | `"seismic:" + type` | For example `seismic:earthquake`, `seismic:quarry blast` |
| `records.source_revision` | `originId + ":" + version` | Replaces the `source_updated_at` idea from the plan, because INGV has no update time |
| `records.attributes` | `magnitude`, `magnitudeType`, `depthKm`, `placeDescription`, `author` | Only fields the UI or filters use |
| `records.accuracy_meters` | — | Not in the GeoJSON summary; left `NULL` |
| `data_sources` row | `id: ingv-fdsn`, `mode: approved_live`, `license: CC-BY-4.0`, `attribution: "Earthquake data: INGV – Istituto Nazionale di Geofisica e Vulcanologia, CC BY 4.0"`, `source_url` | Registered by the importer, like the OSM import |
| `record_place_links` | Computed: up to 5 nearest `places` within 5 km, with distance | Our derived data, labeled as derived |

`place` from INGV ("4 km S Cagli (PU)") is external free text. It is stored and displayed as data and is never interpreted as an instruction or a link target.

### Rate limits, failure behavior, and etiquette

INGV documents no rate limit, so the importer limits itself:

| Concern | Behavior |
|---|---|
| Request size | One request per import window; window ≤ 30 days; `limit=20000`; if the response has exactly 20,000 events, split the window in two (the result was truncated) |
| Frequency | Cooldown between imports (default 10 minutes); one import at a time |
| Timeout | 20 seconds per request through `AbortSignal.timeout` |
| `204` | Successful run with 0 events |
| `400` | Failed run, code `upstream_bad_request`; no retry (our request is wrong) |
| `429`, `500`, `502`, `503`, `504`, network error | Up to 2 retries with exponential backoff and jitter; respect `Retry-After`; then failed run, code `upstream_unavailable` |
| Invalid JSON or wrong shape | Failed run, code `upstream_malformed` |
| One invalid feature | Skipped and counted in `skipped_count`; the rest of the page is imported |
| Identification | `User-Agent: WaypointAI-demo/<version> (+repository URL)` |
| Logging | Codes and counts only; no response bodies |

Previously imported data stays intact when a run fails. The UI shows the last successful sync time so stale data is visible.

### Offline demo fixture

The project rules require synthetic demo fixtures. If the network is unavailable during a demo, a separate source `demo-seismic-synthetic` (`mode: synthetic_local`) can be loaded from a generated fixture with obviously synthetic IDs and descriptions. The UI labels it as synthetic. It is never presented as INGV data. Automated tests use synthetic fixtures shaped like INGV responses.

## 2. Database

| Decision | Choice | Reason |
|---|---|---|
| Event table | Reuse `records` | Already models time, coordinates, category, attributes, source FK; currently empty. A new table would duplicate it. |
| Idempotency | `external_id` + `UNIQUE (source_id, external_id)`; upsert with `ON CONFLICT DO UPDATE … WHERE source_revision IS DISTINCT FROM EXCLUDED.source_revision` | Re-imports update only revised events; unchanged events count as skipped |
| Change detection | `source_revision varchar(80)` | INGV has no update timestamp; `originId:version` changes on revision. USGS can use its `updated` value. |
| Magnitude | Stays in `attributes` JSONB; filtered by `(attributes->>'magnitude')::double precision` | Thousands of rows per month; the time-window index narrows rows first. Promote to a typed column or expression index if `EXPLAIN ANALYZE` shows a problem. |
| New indexes | `records (observed_at)`, `records (lat, lon)` | Every event query has a time window; spatial prefilter uses lat/lon ranges. The existing `(source_id, observed_at)` index does not serve queries without `source_id`. |
| Sync history | New `source_sync_runs` table | Import audit, status for the UI, cooldown check |
| Relationships | New `record_place_links (record_id, place_id, relation, distance_meters)` | Many-to-many event ↔ place; `records.place_id` stays for the single-place case |
| Spatial engine | No PostGIS | Not installed in `postgres:17-alpine`; the existing bbox prefilter plus haversine pattern already serves 3 million places. Revisit with polygons or much larger event volumes. |
| Migration safety | Additive only; `down` reverses it; nullable new columns | Existing data and features are untouched |

## 3. REST API

| Decision | Choice | Reason |
|---|---|---|
| Location | New router at `/api/v1/investigations`, mounted next to `apiRouter` | Keeps `http.ts` focused; same prefix and conventions |
| Validation | Zod `.strict()` per route | Existing convention |
| Errors | `{ "error": "<code>" }` with standard status codes | Existing convention; no stack traces |
| Pagination | Keyset cursor on `(observed_at DESC, id ASC)`, opaque base64url token | Stable while imports add rows; uses the index. Existing endpoints return `total` plus `limit`; they stay unchanged. |
| Bounds | Window ≤ 90 days (default 7), radius ≤ 300 km, `limit` ≤ 200 (default 50) | Predictable query cost |
| Map data | `mapFeatures` GeoJSON in responses | Same shape as `/data/places` |
| Sources | Extend `GET /data/sources` additively with `lastSync` | Avoids two endpoints with the same purpose |
| Import trigger | CLI first (`npm run data:import:events`); `POST /investigations/import/:sourceId` only when `INVESTIGATION_IMPORT_ENABLED=true` | No authentication exists; a public write endpoint must be opt-in |

## 4. Natural-language query

| Decision | Choice | Reason |
|---|---|---|
| Transport | REST `POST /investigations/query` | The investigation view needs one structured response (interpretation, filters, rows), not a chat stream. The chat keeps using the WebSocket. |
| Model role | Interpretation only: one allowlisted tool `search_events`; the model must call it and does not write the answer | The model cannot claim results that do not exist; rows come from the database |
| Ollama API | Existing `chat()` in `backend/src/llm/ollama.provider.ts` with `tools` | Ollama `/api/chat` returns `message.tool_calls`; no new client |
| Locations | The model passes a settlement name; the backend resolves it to one OSM `place:city/town/village/suburb/hamlet` row by exact local or English name (`resolveSettlement`), or uses the selected event for "here" | The model never supplies coordinates; an unknown name returns `422 place_not_found` instead of a guess |
| Validation | Zod schema, then clamping to the REST bounds | Same limits as the REST endpoint |
| Fallback | Rule-based parser for "last N hours/days", "within N km of X", "magnitude above N" in EN/RU/DE; response says `interpretedBy: "rules"` | The 4B local model can produce malformed calls; the fallback is visible, not hidden |
| Concurrency | Move `modelBusy` from `turn.ts` into a shared gate | One local inference at a time across chat and query |
| Chat integration | `search_events` is also allowlisted for the chat assistant. It shares validation, settlement resolution, and bounds with the query endpoint (`assistant/event-search.ts`), is narrowed by the chat's source and date scope, can use the selected map item as the center, and returns `searchArea` in `turn.completed` so the chat map draws the circle | One behavior for both entry points; the WebSocket contract, shared types, and prompt were updated together |

## 5. Frontend

| Decision | Choice | Reason |
|---|---|---|
| Navigation | New `investigation` value in the existing `activePage` state | No router exists; adding one is out of scope |
| Map | Reuse `MapPanel` with events as `records` | It already renders records with popups |
| Data fetching | `fetch` with `AbortController` in `frontend/src/shared/api/investigations.ts` | Existing pattern in `client.ts`; no new library |
| States | Distinct loading, empty, error, fallback-interpretation, and synthetic-source states | Project rule |

## 6. Dependencies

No new npm runtime dependencies were added. The PostgreSQL contrib extension `fuzzystrmatch` (shipped with the official image) is enabled by migration for approximate settlement-name matching. Node's `fetch`, Zod, Sequelize, Express, Leaflet, and `node:test` (including `mock.method` for `fetch`) cover the work. Any addition must be recorded in [stack-decision.md](stack-decision.md).

## 7. Open points

- INGV's FDSN pages do not state a separate licence for the web service. The CC BY 4.0 notice applies to data published by INGV's earthquake observatory site. Confirm with INGV before production or commercial use.
- No rate limit is documented by INGV; self-imposed limits above are conservative assumptions.

## 8. References

- INGV web services: <https://terremoti.ingv.it/en/webservices_and_software>, licence notice: <https://terremoti.ingv.it/en>
- INGV FDSN event service: <https://webservices.ingv.it/fdsnws/event/1/>
- USGS FDSN event service: <https://earthquake.usgs.gov/fdsnws/event/1/>
- USGS GeoJSON summary format: <https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php>
- USGS copyright policy: <https://www.usgs.gov/faqs/are-usgs-reportspublications-copyrighted>
- EMSC SeismicPortal event service: <https://www.seismicportal.eu/fdsn-wsevent.html>, terms: <https://www.seismicportal.eu/terms.html>
- FDSN web service specifications: <https://www.fdsn.org/webservices/>
- Ollama API (chat, tools): <https://github.com/ollama/ollama/blob/main/docs/api.md>
- PostgreSQL `INSERT … ON CONFLICT`: <https://www.postgresql.org/docs/17/sql-insert.html>
- OWASP API Security Top 10 (2023): <https://owasp.org/API-Security/editions/2023/en/0x11-t10/>
