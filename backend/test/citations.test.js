import assert from "node:assert/strict";
import test from "node:test";
import { CitationRegistry, stripCitationRefs } from "../src/assistant/citations.ts";
import { formatPlaceResultsMessage } from "../src/assistant/place-results-message.ts";

/** Synthetic rows shaped like the repository's views. */
const event = (id, url) => ({ id, sourceId: "demo-seismic-synthetic", observedAt: "2026-10-12T05:00:00.000Z", label: `M2.1 · Synthetic ${id}`, lat: 43, lon: 13, accuracyMeters: null, attributes: { magnitude: 2.1, sourceEventUrl: url } });
const place = (id, name) => ({ id, sourceId: "osm-xt", name, category: "tourism:museum", countryCode: "XT", city: "Testville", street: null, houseNumber: null, postcode: null, lat: 1, lon: 1 });

test("gives refs only to rows the tool returned and keeps them stable within a turn", () => {
  const registry = new CitationRegistry();
  const records = [event("demo:1", "https://terremoti.ingv.it/en/event/1"), event("demo:2", null)];
  const content = registry.annotate({ total: 3, events: [{ id: "demo:1" }, { id: "demo:2" }, { id: "demo:unknown" }] }, { records });
  assert.deepEqual(content.events.map((row) => row.ref), ["E1", "E2", undefined]);
  // The same row seen again keeps its ref; places are numbered separately.
  const again = registry.annotate({ record: { id: "demo:2" } }, { records });
  assert.equal(again.record.ref, "E2");
  const places = registry.annotate({ places: [{ id: "osm:node:7" }] }, { places: [place("osm:node:7", "Synthetic Museum")] });
  assert.equal(places.places[0].ref, "P1");
  // Non-object content passes through unchanged.
  assert.equal(registry.annotate("text", { records }), "text");
});

test("keeps known refs, removes invented ones, and lists what the answer cites", () => {
  const registry = new CitationRegistry();
  registry.annotate({ events: [{ id: "demo:1" }, { id: "demo:2" }] }, { records: [event("demo:1", "https://terremoti.ingv.it/en/event/1"), event("demo:2", "https://evil.example/x")] });
  const resolved = registry.resolve("Strongest was M2.1 [E2]. Another one [E1, E9]. Made up [E7]. Place [P3].");
  assert.equal(resolved.text, "Strongest was M2.1 [E2]. Another one [E1]. Made up. Place.");
  assert.equal(resolved.citationsMode, "cited");
  assert.deepEqual(resolved.citations.map((citation) => citation.ref), ["E2", "E1"]);
  // Source pages are accepted only on allowlisted HTTPS hosts.
  assert.equal(resolved.citations[0].url, null);
  assert.equal(resolved.citations[1].url, "https://terremoti.ingv.it/en/event/1");
});

test("falls back to the rows shown to the model when the answer cites nothing", () => {
  const registry = new CitationRegistry();
  assert.deepEqual(registry.resolve("Hello [E1]"), { text: "Hello", citations: [] });
  registry.annotate({ places: [{ id: "osm:way:42" }] }, { places: [place("osm:way:42", "Synthetic Park")] });
  const resolved = registry.resolve("There is one park.");
  assert.equal(resolved.citationsMode, "shown_to_model");
  assert.deepEqual(resolved.citations, [{ ref: "P1", entityType: "place", id: "osm:way:42", sourceId: "osm-xt", label: "Synthetic Park", url: "https://www.openstreetmap.org/way/42" }]);
});

test("place lists carry refs, and stored history has none", () => {
  const registry = new CitationRegistry();
  const message = formatPlaceResultsMessage({ kind: "museum", city: "Testville", query: null, category: null }, [place("osm:node:1", "Synthetic Museum"), place("custom-1", "Synthetic Hall")], 2, "en", (item) => registry.citePlace(item));
  assert.match(message, /1\. Synthetic Museum — Testville \[P1\]\n2\. Synthetic Hall — Testville \[P2\]$/);
  const resolved = registry.resolve(message);
  assert.deepEqual(resolved.citations.map((citation) => citation.url), ["https://www.openstreetmap.org/node/1", null]);
  assert.equal(stripCitationRefs("Museum [P1] and park [P2, E3]."), "Museum and park.");
});
