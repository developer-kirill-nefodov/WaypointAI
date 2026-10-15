# Frontend structure and integration

## Stack and design

The application uses React, TypeScript, and Vite, with Leaflet behind the independent `widgets/map/` adapter. The map uses bundled Natural Earth country polygons to outline countries represented by current place results. When the user presses "Build route", it requests an optimized road trip through up to eight places from the most represented country; plain search results are not routed automatically. The backend proxies coordinates to an OSRM-compatible service configured by `ROUTING_BASE_URL`; only coordinates are sent, never chat text, place names, or IDs. The default public OSRM demo endpoint is for development and has no availability guarantee; production should use an approved self-hosted endpoint. The Waypoint AI workspace focuses on requests, filters, evidence, and map results. The demo requests visible OSM tiles from the browser and displays attribution. Configure `VITE_MAP_TILES_URL` to use another provider or disable the basemap. In offline mode, the country outlines remain available, but road routes require a reachable routing endpoint. See [the stack decision](stack-decision.md).

## Source structure

```text
frontend/src/
├── app/                  # bootstrap, routes, global providers
├── features/assistant/   # conversation, composer, status, filters, history
├── features/results/    # result rows, evidence, filter chips
├── features/voice/       # demo voice input: AudioWorklet capture, voice.* frames, mic button
├── features/investigation/ # event search page: filters, table, details, sync status
├── features/data/          # data page: datasets, countries and cities, import history, deletion
├── widgets/map/          # isolated map adapter
├── entities/record/      # shared record view and selection
└── shared/
    ├── api/              # WebSocket client and HTTP metadata client
    ├── i18n.ts           # English, Russian, and German locale preference
    └── ui/               # reusable controls and styles
```

Wire shapes come from `contracts/websocket.schema.json`; shared TypeScript mirrors live in `packages/shared/src/protocol.ts`; semantics and examples are in `contracts/websocket.md`. REST types are generated from `contracts/openapi.yaml` into `packages/shared/src/openapi.generated.ts`.

## Pages and routing

`shared/routing.ts` maps pages to paths with the History API: `/` (home), `/map` (the map page; `?mode=events` or `?mode=places` opens a mode), `/data`, and `/model`. The former `/investigation` address opens the map's events mode. Reloads and back/forward keep the page. A static host must serve `index.html` for these paths; the Vite dev server already does. The map pages stay mounted after their first visit and are hidden instead of unmounted, so each Leaflet map keeps its view, markers, and page state; `MapSizeObserver` resizes the map when it becomes visible again.

The brand mark lives in `shared/ui/Logo.tsx`; `public/favicon.svg` uses the same artwork. Map libraries are built into a separate `map-vendor` chunk.

## Map page: assistant, events, places

`/map` has one `MapPanel` and a side panel with three modes (`AssistantWorkspace.tsx`, `mapMode`, kept in `?mode=`). The events and places panels load on first use and stay mounted, so switching modes keeps their filters and lists.

- **Assistant**: the chat. Its map shows the chat's results, the trip plan, and the search radius. Two layer switches: *Places* (map-area places from the local snapshot) and *Events* (the last week's earthquakes as a background layer that is not framed or listed as results). The card of the selected item floats over the map (bottom left) with a close button and "Ask the assistant", which offers a ready question about it.
- **Events** (`features/investigation/EventsPanel.tsx`): period, minimum magnitude, and sources; one status line with when the data was updated and a link to the data page (import runs and failures are shown only there); a period summary from the server (`total`, `magnitudeRange` over every match, the latest event); and the list. Selecting an event opens its details in a modal `<dialog>` with its provenance and linked places; "Events within N km" pivots the search to a radius, "Show on the map" moves the map, and "Ask the assistant" makes it the selected map point and switches to the chat with a ready question. The map draws events as records and linked places as highlights, frames only the events, and draws the applied radius. An empty result offers to import recent events.
- **Places** (`features/map/PlacesPanel.tsx`): the place catalog by country, city, category, and text, shared with the data page (`features/data/catalog.tsx`); the chosen place opens its card under its row, with "Ask the assistant".

Panels hand their map content to the shell as a `MapScene` (`widgets/map/map-scene.ts`), and map clicks go back to the active panel. "Ask the assistant" pins the event or place on the assistant map and sends it as `scope.selectedMapItem`, which the backend resolves for "the selected point" (`search_events` with `nearSelection`).

Event modules: `useEventSearch.ts` (filter search with paging; late responses are dropped), `useEventDetails.ts`, `useSources.ts`, and presentational components (`EventFilters`, `ResultsSummary`, `ResultsList`, `EventTable`, `SyncStatus` (the status line), `EventModal`, `EventDetails`). The natural-language query field of the former event explorer is gone; `POST /api/v1/investigations/query` remains in the API.

## WebSocket client flow

1. Load `GET /api/v1/assistant/capabilities` and `/api/v1/data/sources`; display readiness and server-provided source options.
2. Connect to `/api/v1/assistant/ws`, send `session.start`, and wait for `session.ready`.
3. Let the user choose source and date filters and a language (English, Russian, or German). Submit them in `turn.submit.scope` with a unique request ID. Pass the ID and kind of a selected map item; the backend resolves the card from the database and checks its source/date scope.
4. Handle acceptance, status, tool progress, and assistant text; ignore late events for other request IDs and prevent concurrent submissions.
5. Treat completion, clarification, error, and cancellation as terminal states. Restore the current transcript locally and send its conversation ID on each turn.
6. Build map highlights and source provenance from `turn.completed`. Outline country geometry from the local Natural Earth bundle. For two or more verified places, offer a "Build route" action and, when it is pressed, request the backend route endpoint; render returned road geometry, stop order, distance, and estimated duration. Selecting a result opens only returned fields. Do not infer missing values.
7. Trip plans support two map scopes: select the city header to fit and highlight its verified place points, or select a day to fit that day's stops and returned route geometry. Every click requests a fresh fit, including repeated selection of the currently active day. Numbered markers show the selected stop set. Selected places show their day and stop number, along with the metadata returned by the local snapshot. The current extracts include country geometry but no administrative city polygons; label city focus as verified place points, not as an official city boundary. Each city of a trip is outlined in the search-radius blue (`visited-area.ts`: convex hull of that city's stops with a ~600 m buffer) and labelled "City · days · places"; this is the visited area, not an administrative boundary. Multi-city plans label every day with its city.
8. When the assistant asks a clarifying question about a trip, keep the current map result until a new result arrives.
9. `shared/api/assistantSocket.ts` keeps the socket connected. Before each attempt it calls `GET /api/v1/healthz` and opens the WebSocket only when the backend answers, so no socket is attempted while the server restarts. Retries use exponential backoff with jitter (0.5 s doubling to a 15 s cap, never giving up), start immediately when the network returns or the tab becomes visible, and wait about 1.2 s after a `1012 Service Restart` close. The footer shows "Reconnecting in N s · attempt M" with a "Connect now" action. A turn that was running when the socket dropped is reported in the chat as interrupted and is not resent automatically, because a model turn is not idempotent; the conversation ID is kept, so the next turn continues the conversation.

## Voice input (demo, opt-in)

The mic button appears only when the backend reports `voiceInput: true`.

1. On click, the browser asks for microphone access. A native `AudioWorklet` (`features/voice/pcm-recorder.worklet.ts`) resamples the input to 24 kHz mono PCM16 and emits ~100 ms chunks.
2. `useVoiceInput` sends `voice.start`, buffers up to ~3 s of audio until `voice.ready`, and then streams `voice.audio` frames over the existing assistant WebSocket.
3. `voice.transcript.delta` text is written into the composer as it arrives, after any text the user typed earlier. `voice.transcript.completed` replaces it with the final transcript. The composer is read-only and sending is disabled while recording or finishing.
4. Stopping releases the microphone immediately and sends `voice.stop`. The transcript is never submitted automatically.
5. The footer shows distinct states: requesting access, recording (with a notice that audio is sent to OpenAI), finishing, permission denied, no microphone, unsupported browser, disconnected, and server or provider errors.

The browser never connects to OpenAI and never receives the API key.

## Privacy and accessibility

- Browser code must not call Ollama or public data sources directly.
- Do not place prompts, IDs, or tokens in URL query strings.
- Display only fields returned by the backend.
- Keep the `demoMode=true` badge visible.
- Do not show stack traces, filesystem paths, or provider internals in user-facing errors.
- Support keyboard use and text status in addition to color.
- Request open driving trips from OSRM with the supported `roundtrip=false`, `source=first`, `destination=last` combination. A route line is rendered only when the backend returns valid road geometry; if the provider is unavailable, keep the verified stops visible and offer a retry.

Places of the map area (zoom 8 and closer, when no query result is shown) are loaded per fixed grid cell (`widgets/map/viewport-places.ts`): a cell is about three tiles wide at the current zoom, holds up to 250 places, and is fetched once per session and kept in a 300-cell LRU cache; one ring of cells beyond the screen is preloaded, and points on screen stay until their replacement is loaded, so panning neither blanks nor reshuffles the map. The backend sends `Cache-Control: private, max-age=300` for these requests. Markers are drawn on a canvas (`preferCanvas`), and the tile layer keeps a wider buffer (`keepBuffer` 8), does not reload tiles during zoom animations, and shows tiles without the fade-in (cached tiles appear at once); tiles are drawn 0.6 px larger with normal blending (Leaflet’s default `plus-lighter` would brighten the overlap) so seams do not show at fractional browser zoom.

Chat history lives in browser storage (`features/assistant/chat-storage.ts`): each conversation keeps its messages and the map result of its last completed turn, so reloading the page or reopening a recent chat restores its places, trip plan, and search radius. Follow-up suggestions (`features/assistant/suggestions.ts`) are built from that result: trip plans offer edits that the server applies to the stored plan (one more day, a museum on day 1, parks for the last day, removing a day, turning the route off or on, or a single city); event searches offer a wider radius, a magnitude or period filter, and the strongest event; place results offer a day route and related searches. A new chat shows starter prompts shuffled per chat.

The interface language is saved in browser storage and in a first-party `waypoint_language` cookie; without a saved choice the browser's preferred language is used (Russian or German, otherwise English). The dev server redirects `localhost` to `127.0.0.1`, because the two hosts are separate origins with separate storage.

## Import dialog and dock

`features/imports/ImportLayer.tsx` is mounted once in the app shell. "Import data" on the data page opens the dialog (one fixed width of 640 px on every tab; labels never wrap, long names end with an ellipsis) with three tabs: *City or area* (suggested cities to start from, with the loaded ones marked; search a city, see its extent on a small map, pick kinds of places; an area over the limit is narrowed to a square around the centre), *Whole region* (Europe's countries in the interface language with a drill-down into their regions and a "Whole" button, or a search in any language that also places cities and states in the catalogue; already loaded regions are marked; file size and date, a warning above 300 MB; progress in megabytes), and *Events* (sources with licence, last sync, and cooldown; period); "Loaded data" in its footer opens the data page. Closing it while a job runs moves the job to the dock at the bottom right: a ring with one arc per source, a bar per source with the phase ("fetching · 11 Oct · 421"), counts after completion, errors in plain words (cooldown with the wait, source unavailable, interrupted), cancel, and retry for failed sources. Every job in the dock has a close button (a running job is only hidden and keeps going), and "Close all" hides every job at once when there is more than one. The dock collapses to a pill with the percentage. State lives in `features/imports/import-store.ts` (a small external store): jobs come from `import.progress` WebSocket frames, and from `GET /imports` on load, so the dock reattaches after a reload; when no WebSocket update arrives for 2.5 s the running jobs are polled. A finished job dispatches `waypoint:import-finished`, which reloads the explorer's sources and events. The form draft, collapsed state, and dismissed jobs are kept in local storage. For a second dev server against a test backend, set `VITE_API_PROXY_TARGET`.

## Data page

The rail button **Data** opens `features/data/DataPage.tsx` (`/data`), a data explorer. On desktop it fills the window: the datasets and the selected one's panel reach the bottom, and only the lists scroll. A one-line summary (datasets, places, events, countries, cities and towns) sits beside the title. On the left, the datasets are grouped into those imported from the app, the built-in regions, and events, with "All data" on top; on the right, the selected one has three tabs:

- **Records** (the default): filters for country (the dataset's own countries with its own counts, largest first), city (a searchable list, largest first), category (counts under the other filters), and a text search; below them the list beside a map of the current page. Choosing a record highlights it on the map and opens a card with its address, tags, and links to OpenStreetMap, the website, and Wikidata; the page stays where it is, and "Open in chat" hands the place to the chat map only when asked. After moving the map, "Search this area" limits the list to it. "All data" works the same across datasets for the chosen country. Event sources list their events, newest first, with their points on the map (`GET /api/v1/data/datasets/{id}/events`).
- **Overview**: categories as bars and the dataset's countries, both opening Records with that filter; the extent on a small map and the licence. For all data, places by country; a country opens its records, a dataset link opens the dataset.
- **History**: the import and deletion jobs, of the dataset or all of them, with live progress; all data can clear finished entries (the data stays).

Each dataset keeps its own filters, so switching between datasets returns to where you were. The selected dataset, tab, and filters are kept in the address (`/data?dataset=…&city=…&category=…`): choosing a dataset or tab adds a history step, typing a filter replaces it, and the rail reopens the page where it was. Records come from `GET /api/v1/data/catalog/places` and `/catalog/categories`, which need a dataset or a country.

Datasets imported from the app have a Delete button with a confirmation that names the number of places; it starts a `dataset_delete` job, whose progress shows in the dock.

Data comes from `shared/data-cache.ts`, a small stale-while-revalidate cache: a page that returns to a request it has made shows the cached response at once and refreshes it in the background, and only the first load of a request shows a loading state. The data page also stays mounted after its first visit, like the map pages, so its maps, filters, and loaded pages survive switching pages. A finished import or deletion marks the cached data stale. The import dialog reads its event sources from the same cache.

## Chat progress and streaming

While a turn runs, the chat shows the current step with a timer and the finished steps below it (`TurnSteps`); streamed text appears in the answer bubble with a cursor. When the turn ends, its steps fold into "How this was answered" under the answer and are saved with the chat.
