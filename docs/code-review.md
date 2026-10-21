# Known issues and fixes

This is the issue log for the event explorer and the parts of the assistant it touches: what was found while building and testing it, how each issue was fixed, and what is still open. Each entry was checked against the code before it was fixed or left open.

Paths are as they were when each issue was fixed. Since then `InvestigationWorkspace.tsx` and `QueryBar.tsx` were folded into the Events mode of the map page (`frontend/src/features/investigation/EventsPanel.tsx`; plain-language questions go to the assistant chat), and `backend/src/assistant/trip-clarification.ts` was replaced by the `plan_trip` and `edit_trip_plan` tools.

Current verification: `npm test` and `npm run test:db` (PostgreSQL, disposable database) pass in CI together with `npm run typecheck` and `npm run build`; a live INGV import runs against the HTTP code.

No SQL injection was found: every value is a bind parameter and dynamic SQL fragments are constants. The external source URL comes only from an allowlisted environment value.

## High

| # | Area and path | Issue | Impact | Resolution |
|---|---|---|---|---|
| H1 | Import linking — `backend/src/services/event-import.ts`, `backend/src/data/event-import.repository.ts` | Place links were computed only for rows inserted or updated in the same run, after the upserts had committed. | If the link step failed once, the events were stored, the next run skipped them as unchanged, and they never got place links. | **Fixed.** Each run also links events in its window that have no `nearby` links (`findUnlinkedRecordIds`). Tests: memory-store retry test and a PostgreSQL test. |
| H2 | Frontend request races — `frontend/src/features/investigation/InvestigationWorkspace.tsx` | "Show more" and the natural-language query were not tied to the active result set and could not be cancelled. | A late page could merge rows from old filters into a new result set, and a late filter search could overwrite query results while the card still described the query. | **Fixed.** Each result set gets a generation number. Late responses are dropped, and `loadMore` and `runQuery` share an `AbortController` that is aborted when a new result set starts or the page unmounts. |

## Medium

| # | Area and path | Issue | Impact | Resolution |
|---|---|---|---|---|
| M1 | Null revisions — `backend/src/sources/ingv/ingv.adapter.ts` | Events without `originId` got `revision: null`, and `NULL IS DISTINCT FROM NULL` is false. | Corrections to such events would never be stored. | **Fixed.** A content hash of the normalized fields is used as the revision. Test added. |
| M2 | Interrupted imports — `backend/src/server.ts`, `backend/src/data/event-import.repository.ts` | A process exit during an import left the run `running`. | The unique "one running import" index blocked the source for up to 30 minutes. | **Fixed.** The fetch phase has a 15-minute deadline, below the 30-minute stale limit. On startup, only runs older than the stale limit are marked `interrupted`, so a CLI import running next to the API is left alone. |
| M3 | Body download timeout — `backend/src/sources/http.ts` | The response body was read after the retry loop. | A timeout while downloading a large body was recorded as `import_failed` and not retried. | **Fixed.** The body is read inside each attempt, so the existing retry and `upstream_timeout` mapping apply. Test added. |
| M4 | Rate limiting behind a proxy — `backend/src/api/rate-limit.ts`, `backend/src/server.ts` | Limits are keyed on `request.ip`, and `trust proxy` was not configured. | Behind a reverse proxy every client shares one bucket. Setting `trust proxy` to `true` would make the limit spoofable. | **Fixed.** `TRUST_PROXY` env (default `false`, or a hop count 1–5; `true` is rejected). Documented in `.env.example`. |
| M5 | Settlement lookup cost — `backend/src/data/investigation.repository.ts` | The case-insensitive name match could not use an index. | One query took 589 ms with a primary-key scan plan. | **Fixed.** New migration `20261013010000-add-settlement-name-indexes.cjs` adds partial expression indexes on settlement rows only. The query now lists its categories as literals so they match. Measured at 0.13 ms. The migration was tested with undo and redo. |
| M6 | `/data/sources` coupling — `backend/src/data/source.repository.ts` | The source list now also queried `source_sync_runs`, inside a catch-all. | A failure in the sync lookup would return an empty source list to the existing assistant UI. | **Fixed.** The sync lookup has its own fallback, so sources are returned with `lastSync: null`. |
| M7 | Malformed JSON — `backend/src/server.ts` | Body-parser errors went to the generic 500 handler. | Contract violation (400 documented) and noisy stack-trace logs. | **Fixed.** `backend/src/api/error-handler.ts` maps parse errors to `400 invalid_json` and oversize bodies to `413`. Test added. |
| M8 | Source status freshness — `InvestigationWorkspace.tsx` | Sources were loaded once at app start, and a load failure was shown as "no sources imported". | Sync status and failed-import warnings were stale, and errors looked like an empty state. | **Fixed.** The page loads sources itself, reloads them on Refresh, and shows a distinct error state. A running import is labelled. |
| M9 | Provenance fail-open — `EventTable.tsx`, `EventDetails.tsx`, `MapPanel.tsx` | An event whose source metadata was missing looked like ordinary data, and map markers had no provenance cue. | Synthetic or unknown-origin data could be mistaken for real observations. | **Fixed.** Unknown sources are tagged "Unverified" with a warning. Synthetic or unverified markers have a dashed outline. The event explorer popup shows the source. |
| M10 | Accessibility — `EventTable.tsx`, `EventDetails.tsx`, `QueryBar.tsx`, `EventFilters.tsx`, `styles.css` | Invalid `aria-selected` on a plain table row. No focus-visible style. Details appeared silently below the table. The query input was `disabled` while running, which dropped focus. The filter group had no role. | Keyboard and screen-reader users lost selection state and focus. | **Fixed.** The row button carries `aria-current` and has a `:focus-visible` outline. Details headings receive focus and scroll into view. The input is `readOnly` with `aria-busy`. Filters use `role="group"`. |
| M11 | Flash on refresh — `InvestigationWorkspace.tsx` | Every filter change cleared the table and map before the new page arrived. | Visible flicker and lost scroll position. | **Fixed.** Previous rows stay visible with an "updating…" note and `aria-busy` until the new page arrives. |

## Low

| # | Area and path | Issue | Resolution |
|---|---|---|---|
| L1 | Import trigger CSRF — `backend/src/api/investigations.ts` | A cross-site text/plain POST needs no preflight and could start an import when the trigger is enabled. | **Fixed.** Non-JSON bodies get `415`. The trigger stays off by default. Test added. |
| L2 | Redirects — `backend/src/sources/http.ts` | `fetch` followed redirects, so the host allowlist only covered the first URL. | **Fixed.** `redirect: "error"`. |
| L3 | Cooldown after failure — `backend/src/data/event-import.repository.ts` | A failed run started the 10-minute cooldown. | **Fixed.** Only running or succeeded runs count. Test added. |
| L4 | Empty query values — `backend/src/api/investigation-params.ts` | `minMagnitude=` was coerced to 0, and `bbox=1,2,,4` was accepted. | **Fixed.** Empty values are treated as absent and empty bbox parts are rejected. Tests added. |
| L5 | Contract gaps — `contracts/openapi.yaml` | `fallbackReason` in the 422 body was untyped, and 400 `invalid_json`, 415, and the generic 500 were undocumented. | **Fixed** and types regenerated. |
| L6 | Error messages — `frontend/src/features/investigation/format.ts`, `InvestigationWorkspace.tsx` | Some server codes fell through to "Could not load data", and the 422 `fallbackReason` was ignored. | **Fixed.** |
| L7 | "DEMO RECORD" label — `frontend/src/widgets/map/MapPanel.tsx` | The assistant card label changed to "RECORD", which could look like a lost provenance cue. | **No change needed.** Records are no longer demo-only. The same card shows the source label, and the synthetic source's label says "offline demo, not real data". |
| L8 | Cursor precision — `backend/src/data/investigation.repository.ts` | The cursor carries milliseconds while `timestamptz` stores microseconds. | **Open (latent).** Imported data is millisecond-precise. Rows written with sub-millisecond times by a future source could be skipped at a page boundary. Fix by carrying microseconds in the cursor when such a source is added. |
| L9 | Partial-failure counts — `backend/src/services/event-import.ts` | If a later upsert batch fails, earlier committed batches are not reflected in the failed run's counts. | **Open.** Data stays consistent and the next run counts those rows as skipped. Per-batch count updates would make the audit row exact. |
| L10 | Cooldown race — `backend/src/services/event-import.ts` | The cooldown check and run start are not atomic. | **Open, bounded.** The partial unique index still prevents two concurrent running imports; at worst two sequential imports run closer together than the cooldown. |
| L11 | Scope of search — `backend/src/data/investigation.repository.ts` | `/events` and `/query` return every row in `records`, not only seismic categories. | **Open by design.** `records` is the generic observation table. Today it holds only seismic events; a category default can be added when other record types arrive. |
| L12 | Model behaviour — `backend/src/assistant/investigation-query.ts` | The model sometimes adds arguments the user did not ask for (seen: a 100 km radius). When the 45 s timeout fires, Ollama may keep generating after the gate is released. | **Open.** The arguments are validated and displayed in the interpretation card. Cancelling generation needs a streaming request that can be closed. |
| L13 | Map refit — `frontend/src/widgets/map/MapPanel.tsx` | Loading more rows refits the map to all points. | **Open.** This is existing `FitToResults` behaviour and is acceptable for the demo. |
| L14 | Interpolated strings — `frontend/src/features/investigation/*` | Strings with numbers (for example "7 days", "51 found") are not translated to German; units (km, h) are not localized. | **Open.** Russian and English are complete. German falls back to English for these strings. |
| L15 | Antimeridian — `backend/src/data/investigation.repository.ts` | Radius bounding boxes do not wrap at ±180°. | **Open.** Not relevant for the European data in this demo. |
| L16 | Linked-place markers — `InvestigationWorkspace.tsx` | Clicking a linked place on the map does nothing. | **Open (intended).** Places are context for the selected event; the details panel lists them. |

## Areas checked without findings

- The inference gate is released in `finally` on both the chat and query paths.
- All repository SQL uses bind parameters. `LIKE` input is escaped in existing code.
- Model tool calls are restricted to `search_events`. Arguments are validated with `.strict()` Zod schemas, coordinates are never accepted from the model, and rejected tool names are reported but not executed.
- Frontend rows, counts, and map points come only from API responses. The only external link is built from a numeric INGV event ID and opens with `rel="noreferrer noopener"`.
- The `variant` prop leaves the assistant page's map behaviour unchanged.

## Remaining limitations

- No authentication or authorization; one demo workspace. Not production-secure.
- In-memory rate limiting is per process.
- No frontend test runner; the UI was verified manually in a browser.
- The INGV FDSN service licence is inferred from the observatory's site-wide CC BY 4.0 notice; confirm before commercial use.

## End-to-end QA pass

The feature was exercised end to end: 30 natural-language queries against the live model (EN/RU/DE, exonyms, selections, limits, off-topic text, prompt injection), the same parser with the model unavailable, concurrent query and chat requests, chat flows over the WebSocket, and 29 browser scenarios (states, errors, pagination, keyboard, languages, mobile width, regressions).

| # | Severity | Finding | Resolution |
|---|---|---|---|
| Q1 | High | After a trip plan was built, every later chat message (for example "Which data sources are available?") returned the plan again, because preferences come from the conversation history. | **Fixed.** `isTripPlanningMessage` in `backend/src/assistant/trip-clarification.ts`; the plan is rebuilt only on turns about the trip. Unit test added; re-verified over the WebSocket (follow-up answered normally, "remove the second day" still edits the plan). |
| Q2 | High | The chat assistant said it had no earthquake data and did not call `search_records`; the system prompt, tool description, and model page still described records as not loaded. | **Fixed.** Prompt and tool description now name the imported INGV events and require a tool call before claiming absence; `ModelInfoPage` text updated. Re-verified: the chat calls `search_records` and lists events. |
| Q3 | Medium | "Earthquakes in Italy" made the model substitute Roma, then (after a prompt change) pass "Italy" as a place. | **Fixed.** Prompt says countries and regions are not places; the server also drops known country and region names and reports `interpretation.ignoredPlace`. Test added. |
| Q4 | Medium | Russian "Норча" was transliterated by the model as "Norchi" and not found. | **Fixed.** Exact lookup first, then an approximate match among cities and towns only (same first three letters, edit distance ≤ 2) through the PostgreSQL `fuzzystrmatch` extension (migration `20261013020000-add-fuzzystrmatch.cjs`). The response marks `resolvedPlace.match: "approximate"` and the UI says so. Villages were excluded after "Florenz" matched a Romanian village. |
| Q5 | Medium | Naples and Catania have INGV events but no imported OSM rows, so the query only said "not found". | **Fixed (message).** The UI names the imported OSM regions and suggests searching by period and magnitude. Importing more OSM regions is a data decision. |
| Q6 | Low | With the model unavailable, the rule parser treated "weather in Rome" as an event search. | **Fixed.** Rules require an event word or a numeric/selection constraint. |
| Q7 | Low | The model mapped "this week" to 720 hours. | **Fixed** by explicit period rules in the prompt; re-verified (168 h). |
| Q8 | Low | German period labels and counters stayed in English. | **Fixed** with explicit three-language strings. |
| Q9 | Low | On narrow screens the event explorer panel scrolls inside the page. | **Open.** Functional; layout polish. |
| Q10 | Info | Chat turns that need two model calls take 70–130 s on this CPU-only machine; a client that disconnects early can leave Ollama busy for the next request. | **Open (environment).** Matches L12; a GPU or a smaller context reduces latency. The query endpoint itself takes 8–12 s. |

Results after the fixes: 79 unit and route tests and 8 PostgreSQL tests pass; typecheck and build pass; the live query matrix shows no validation or safety failures; all browser scenarios pass.

## Hardening pass

| # | Severity | Finding | Resolution |
|---|---|---|---|
| R1 | Medium | Voice input relays audio to a paid provider, and sessions were limited only to one per connection. Many connections from one client could run up the provider bill. | **Fixed.** `backend/src/voice/voice-budget.ts`: a process-wide cap on open sessions plus a per-client hourly budget of sessions and reserved seconds (`VOICE_*` settings). Refusals use the `rate_limited` voice error. Forwarded addresses count only with `TRUST_PROXY`. Tests added. |
| R2 | Medium | `model/ollama/scripts/serve.sh` cleared `OLLAMA_VULKAN` before reading it, so the flag from the environment was ignored. | **Fixed.** Flags are read first, then cleared. |
| R3 | Medium | PostgreSQL logic (radius search, keyset pagination, place linking, approximate city lookup) ran only locally, and generated OpenAPI types could drift from the contract unnoticed. | **Fixed.** CI starts PostgreSQL 17, runs `npm run test:db`, and fails when `contracts:types` changes the generated file. |
| R4 | Low | "12 days in Roma" was read as 2 days. | **Fixed.** Day counts take up to two digits and are capped at the 7-day limit. Test added. |
| R5 | Low | Numbers filled from the user text were merged after validation, so a filled minimum magnitude could exceed the model's maximum. | **Fixed.** The merged arguments are validated again; on failure the model's arguments are kept. Test added. |
| R6 | Low | Every capitalized word in a trip request became a sequential database lookup. | **Fixed.** At most 8 candidates, looked up in parallel and once per turn. Test added. |
| R7 | Low | Smaller gaps: the realtime connect timer kept running after an abort; source responses were buffered without a size limit; the chat's category filter did not reach event searches. | **Fixed.** Timer cleared on abort; bodies above 20 MB are rejected as `upstream_malformed`; the scope category narrows event searches. Tests added where the behaviour is observable. |
| R8 | Medium | The chat model saw 8 of 68 matching events and summarized them as the whole result (a wrong magnitude range), and it guessed a compass direction from the search center. | **Fixed.** The count query also returns the magnitude range over every match, the tool marks the listed events as a sample, and the server computes `directionFromCenter`; the prompt requires these values. Tests added, including PostgreSQL. |
