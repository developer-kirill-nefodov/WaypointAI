# Demo Rehearsal Checklist

## Before the session

- [ ] Install dependencies and complete the project build.
- [ ] Start PostgreSQL and apply migrations.
- [ ] Import the intended regional OSM snapshots and confirm their source dates and licenses.
- [ ] Start Ollama explicitly and confirm the configured model is ready.
- [ ] Confirm the routing endpoint is reachable, or prepare to demonstrate the unavailable-route state.
- [ ] Open the app and verify that its model and data-source status match the backend.

## Scenarios

| Scenario | Expected behavior |
|---|---|
| Ask for places in a supported city | The backend returns matching verified rows; the map highlights those same place IDs. |
| Request an itinerary with missing details | The assistant asks a focused clarification; it does not guess airport, duration, or travel mode. |
| Select a trip day repeatedly | The map refits to that day's stops and route on every selection. |
| Ask about a selected place | The answer uses returned place metadata and does not invent missing details. |
| Ask for a place outside snapshot coverage | The app clearly explains that local data is unavailable. |
| Make route service unavailable | Stops remain visible and the route state explains the limitation. |
| Stop the local model | Readiness changes and the app presents a useful disconnected state. |

## Notes

Record repeatable latency or quality measurements separately with machine specifications, warm/cold state, exact prompt, and dataset version. Do not record prompts containing personal data or put operational logs in public documentation.
