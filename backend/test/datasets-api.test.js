import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { createDatasetsRouter } from "../src/api/datasets.ts";
import { errorHandler } from "../src/api/error-handler.ts";

/** Synthetic places; the fake repository pages them by name and ID like the SQL one. */
const PLACES = ["Alpha Museum", "Beta Park", "Gamma Cafe", "Delta Hut", "Epsilon Peak"].map((name, index) => ({
  id: `p${index}`, name, category: index % 2 ? "leisure:park" : "tourism:museum", countryCode: "XT", city: "Testville", street: null, houseNumber: null, postcode: null, lat: 1, lon: 1,
}));

function listen(calls) {
  const app = express();
  app.use("/data", createDatasetsRouter({
    listDatasets: async () => [],
    listCountries: async (datasetId) => { calls.push({ countries: datasetId ?? null }); return [{ countryCode: "XT", places: 5, cities: 1, towns: 0, villages: 0, datasets: ["osm-area-testville", "osm-area-other"] }]; },
    listSettlements: async () => ({ total: 0, settlements: [] }),
    listCatalogPlaces: async (query) => {
      calls.push(query);
      const sorted = [...PLACES].sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
      const rest = query.after ? sorted.filter((place) => place.name > query.after.name || (place.name === query.after.name && place.id > query.after.id)) : sorted;
      const page = rest.slice(0, query.limit);
      return { total: query.after ? null : PLACES.length, places: page, next: rest.length > query.limit ? { part: 0, name: page.at(-1).name, id: page.at(-1).id } : null };
    },
    listCatalogCategories: async (filter) => { calls.push({ categories: filter }); return [{ category: "tourism:museum", places: 3 }]; },
    listDatasetEvents: async (query) => { calls.push(query); return { total: 0, events: [], next: null }; },
    geocode: async () => [],
    searchRegions: async (query) => (query === "Poland" ? [{ id: "poland" }] : []),
    childRegions: async (parentId) => { calls.push({ children: parentId }); return [{ id: "poland" }]; },
    locateRegions: async (query) => (query === "Lombardia" ? { place: "Lombardia", regions: [{ id: "nord-ovest" }] } : null),
    regionInfo: async () => null,
  }));
  app.use(errorHandler);
  return new Promise((resolve) => { const server = app.listen(0, "127.0.0.1", () => resolve(server)); });
}

test("pages through the catalog with an opaque cursor, bounds every query to datasets, and validates every parameter", async () => {
  const calls = [];
  const server = await listen(calls);
  const base = `http://127.0.0.1:${server.address().port}/data`;
  const url = `${base}/catalog/places`;
  try {
    const first = await (await fetch(`${url}?dataset=osm-area-testville&limit=2`)).json();
    assert.equal(first.total, 5);
    assert.deepEqual(first.places.map((place) => place.name), ["Alpha Museum", "Beta Park"]);
    const names = [...first.places.map((place) => place.name)];
    let cursor = first.nextCursor;
    while (cursor) {
      const page = await (await fetch(`${url}?dataset=osm-area-testville&limit=2&cursor=${cursor}`)).json();
      assert.equal(page.total, null);
      names.push(...page.places.map((place) => place.name));
      cursor = page.nextCursor;
    }
    assert.deepEqual(names, ["Alpha Museum", "Beta Park", "Delta Hut", "Epsilon Peak", "Gamma Cafe"]);

    await fetch(`${url}?dataset=osm-area-testville&q=%25museum&category=tourism:museum&city=Testville&bbox=1,2,3,4`);
    assert.deepEqual(calls.at(-1), { datasetIds: ["osm-area-testville"], countryCode: undefined, city: "Testville", category: "tourism:museum", query: "%museum", bbox: [1, 2, 3, 4], limit: 50, after: undefined });
    // Without a dataset, the country names the datasets to read; without both, the request is refused.
    await fetch(`${url}?country=XT`);
    assert.deepEqual(calls.at(-1).datasetIds, ["osm-area-testville", "osm-area-other"]);
    assert.deepEqual(await (await fetch(`${url}?country=QQ`)).json(), { total: 0, places: [], nextCursor: null });
    assert.equal((await fetch(url)).status, 400);
    for (const bad of ["bbox=1,2,3", "bbox=3,2,1,4", "bbox=1,2,3,95", "bbox=a,b,c,d", "country=xt", "cursor=not-a-cursor", "limit=1000", "order=name"]) {
      assert.equal((await fetch(`${url}?dataset=osm-area-testville&${bad}`)).status, 400, bad);
    }
    assert.equal((await fetch(`${url}?dataset=osm-area-testville&cursor=${Buffer.from(JSON.stringify({ part: 0, name: "x", id: "y", sql: 1 })).toString("base64url")}`)).status, 400);
    assert.equal((await fetch(`${url}?dataset=Bad%20Id`)).status, 400);

    assert.deepEqual(await (await fetch(`${base}/catalog/categories?dataset=osm-area-testville&category=x`)).json(), { categories: [{ category: "tourism:museum", places: 3 }] });
    assert.equal((await fetch(`${base}/catalog/categories`)).status, 400);
    await fetch(`${base}/countries?dataset=osm-area-testville`);
    assert.deepEqual(calls.at(-1), { countries: "osm-area-testville" });
    assert.equal((await fetch(`${base}/countries?dataset=../x`)).status, 400);
    assert.equal((await fetch(`${base}/datasets/ingv-fdsn/events?cursor=${Buffer.from(JSON.stringify({ observedAt: "yesterday", id: "a" })).toString("base64url")}`)).status, 400);
    assert.equal((await fetch(`${base}/datasets/ingv-fdsn/events?limit=10`)).status, 200);

    // Regions: browsing, a catalogue name, and a place the catalogue does not name.
    assert.deepEqual(await (await fetch(`${base}/regions`)).json(), { regions: [{ id: "poland" }] });
    assert.deepEqual(calls.at(-1), { children: null });
    await fetch(`${base}/regions?parent=italy`);
    assert.deepEqual(calls.at(-1), { children: "italy" });
    assert.deepEqual(await (await fetch(`${base}/regions?q=Poland`)).json(), { regions: [{ id: "poland" }] });
    assert.deepEqual(await (await fetch(`${base}/regions?q=Lombardia`)).json(), { regions: [{ id: "nord-ovest" }], via: "Lombardia" });
    // The place lookup shares Nominatim's one-request-per-second limit.
    assert.equal((await fetch(`${base}/regions?q=Lombardia`)).status, 429);
    assert.equal((await fetch(`${base}/regions?q=x&parent=italy`)).status, 400);
    assert.equal((await fetch(`${base}/regions?parent=../etc`)).status, 400);
  } finally { server.close(); }
});
