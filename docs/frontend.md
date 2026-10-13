# Frontend structure and integration

## Stack and design

The application uses React, TypeScript, and Vite, with Leaflet behind the independent `widgets/map/` adapter. The map uses bundled Natural Earth country polygons to outline countries represented by current place results. It automatically requests an optimized road trip through up to eight places from the most represented country. The backend proxies coordinates to an OSRM-compatible service configured by `ROUTING_BASE_URL`; only coordinates are sent, never chat text, place names, or IDs. The default public OSRM demo endpoint is for development and has no availability guarantee; production should use an approved self-hosted endpoint. The Waypoint AI workspace focuses on requests, filters, evidence, and map results. The demo requests visible OSM tiles from the browser and displays attribution. Configure `VITE_MAP_TILES_URL` to use another provider or disable the basemap. In offline mode, the country outlines remain available, but automatic road routes require a reachable routing endpoint. See [the stack decision](stack-decision.md).

## Source structure

```text
frontend/src/
├── app/                  # bootstrap, routes, global providers
├── features/assistant/   # conversation, composer, status, filters, history
├── features/results/    # result rows, evidence, filter chips
├── features/voice/       # demo voice input: AudioWorklet capture, voice.* frames, mic button
├── features/investigation/ # event search page: filters, table, details, sync status
├── widgets/map/          # isolated map adapter
├── entities/record/      # shared record view and selection
└── shared/
    ├── api/              # WebSocket client and HTTP metadata client
    ├── i18n.ts           # English, Russian, and German locale preference
    └── ui/               # reusable controls and styles
```

Wire shapes come from `contracts/websocket.schema.json`; shared TypeScript mirrors live in `packages/shared/src/protocol.ts`; semantics and examples are in `contracts/websocket.md`. REST types are generated from `contracts/openapi.yaml` into `packages/shared/src/openapi.generated.ts`.

## Pages and routing

`shared/routing.ts` maps pages to paths with the History API: `/` (home), `/map` (map and chat), `/investigation`, and `/model`. Reloads and back/forward keep the page. A static host must serve `index.html` for these paths; the Vite dev server already does. The map pages stay mounted after their first visit and are hidden instead of unmounted, so each Leaflet map keeps its view, markers, and page state; `MapSizeObserver` resizes the map when it becomes visible again.

The brand mark lives in `shared/ui/Logo.tsx`; `public/favicon.svg` uses the same artwork. Map libraries are built into a separate `map-vendor` chunk.

## Investigation page (demo)

The rail button **Investigation** opens `features/investigation/InvestigationWorkspace.tsx`. It reads only REST responses from `/api/v1/investigations` through `shared/api/investigations.ts`; nothing is hardcoded.

Module layout:

| Files | Responsibility |
|---|---|
| `InvestigationWorkspace.tsx` | Page composition and user actions (apply filters, refresh, clear query, open event, map focus) |
| `useEventSearch.ts`, `useInvestigationQuery.ts` | Filter search and natural-language query; they share one request generation and abort controller so late responses are dropped |
| `useEventDetails.ts`, `useSources.ts` | Event details for the dialog; source list and sync status |
| `EventFilters`, `ResultsSummary`, `ResultsList`, `EventTable`, `SyncStatus`, `QueryBar`, `InterpretationCard`, `EventModal`, `EventDetails`, `ElapsedSeconds`, `Warning` | Presentational components; `ElapsedSeconds` re-renders only itself while a request runs |
| `types.ts`, `errors.ts`, `format.ts` | Shared types, error-code messages, and formatting (`formatKm`, `formatSeconds`, UTC times) |

- Filters (period, minimum magnitude, sources) map directly to query parameters. Selecting an event loads its details and linked places; "Events within N km" pivots the search to a radius around that event.
- "Show more" requests the next page with the server's cursor and the same time window as the first page.
- Loading, empty, error (with retry), failed-import, and synthetic-data states are shown separately. Synthetic events carry a visible tag and warning.
- Layout: the query, filters, and result summary stay fixed at the top of the left panel; only the event list scrolls (sticky header, "Show more" at the end). The map fills the right column.
- Selecting an event in the list or on the map opens its details in a native modal `<dialog>` (`EventModal.tsx`): focus is trapped, Esc, the close button, or a backdrop click closes it, and focus returns to the list. "Show event on the map", a nearby place, or a radius button closes the dialog and moves the map there (the chosen place is highlighted; on narrow screens the map scrolls into view).
- The map reuses `MapPanel` with `variant="investigation"`: events are drawn as records, linked places as highlights, and the assistant's result list, viewport place loading, and road routing are turned off. Selecting an event frames it with its linked places. When a radius is applied (filter pivot or query), a dashed circle with its size and center label is drawn and the map fits the circle.
- Loading states show a live timer (search, query interpretation, "Show more", details); the summary and the interpretation card show how long the last response took.
- Source links are rendered only for INGV event pages built from a numeric ID.
- The query bar sends text, language, and the selected event's coordinates to `POST /api/v1/investigations/query`. The interpretation card shows whether the local model or the rule parser produced the filters, the fallback reason, the resolved settlement, and any rejected tool names. "Show more" continues through `GET /events` with the server's `appliedFilters`.

## WebSocket client flow

1. Load `GET /api/v1/assistant/capabilities` and `/api/v1/data/sources`; display readiness and server-provided source options.
2. Connect to `/api/v1/assistant/ws`, send `session.start`, and wait for `session.ready`.
3. Let the user choose source and date filters and a language (English, Russian, or German). Submit them in `turn.submit.scope` with a unique request ID. Pass the ID and kind of a selected map item; the backend resolves the card from the database and checks its source/date scope.
4. Handle acceptance, status, tool progress, and assistant text; ignore late events for other request IDs and prevent concurrent submissions.
5. Treat completion, clarification, error, and cancellation as terminal states. Restore the current transcript locally and send its conversation ID on each turn.
6. Build map highlights and source provenance from `turn.completed`. Outline country geometry from the local Natural Earth bundle. For two or more verified places, request the backend route endpoint; render returned road geometry, stop order, distance, and estimated duration. Selecting a result opens only returned fields. Do not infer missing values.
7. Trip plans support two map scopes: select the city header to fit and highlight its verified place points, or select a day to fit that day's stops and returned route geometry. Every click requests a fresh fit, including repeated selection of the currently active day. Numbered markers show the selected stop set. Selected places show their day and stop number, along with the metadata returned by the local snapshot. The current extracts include country geometry but no administrative city polygons; label city focus as verified place points, not as an official city boundary. Each city of a trip is outlined in the search-radius blue (`visited-area.ts`: convex hull of that city's stops with a ~600 m buffer) and labelled "City · days · places"; this is the visited area, not an administrative boundary. Multi-city plans label every day with its city.
8. When a new trip needs destination clarification, clear the prior trip result and return the map to its Europe overview so old city POIs do not appear to belong to the new request.
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

Chat history lives in browser storage (`features/assistant/chat-storage.ts`): each conversation keeps its messages and the map result of its last completed turn, so reloading the page or reopening a recent chat restores its places, trip plan, and search radius. Follow-up suggestions (`features/assistant/suggestions.ts`) are built from that result: trip plans offer longer, shorter, single-city, or route-free variants; event searches offer a wider radius, a magnitude or period filter, and the strongest event; place results offer a day route and related searches. A new chat shows starter prompts shuffled per chat.
