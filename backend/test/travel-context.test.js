import assert from "node:assert/strict";
import test from "node:test";
import { getTripClarification, isTripPlanningMessage, resolveTripPreferences } from "../src/assistant/trip-clarification.ts";
import {
  explicitTravelCity,
  explicitTravelCountry,
  inferRecentTravelCountry,
  isFreshTravelContext,
  isFreshTravelRequest,
  recentTravelContextMessages,
} from "../src/assistant/travel-place-prefetch.ts";

test("recognizes all supported country and capital pairs in Russian and English", () => {
  const destinations = [
    ["Новый план: Германия — Берлин", "DE", "Berlin"],
    ["New plan: Poland — Warsaw", "PL", "Warszawa"],
    ["Новый план: Румыния — Бухарест", "RO", "București"],
    ["New plan: France — Paris", "FR", "Paris"],
    ["Новый план: Италия — Рим", "IT", "Roma"],
    ["New plan: Spain — Madrid", "ES", "Madrid"],
  ];

  for (const [message, country, city] of destinations) {
    assert.equal(explicitTravelCountry(message), country, message);
    assert.equal(explicitTravelCity(message), city, message);
  }
});

test("treats an unspecified destination as a fresh trip without inheriting Warsaw", () => {
  const history = ["Составь маршрут по Варшаве на 2 дня, WAW, на машине", "Убери второй день"];
  const request = "Давай начнём сначала, но с другой страной";

  assert.equal(isFreshTravelRequest(request), true);
  assert.equal(explicitTravelCountry(request), undefined);
  assert.equal(isFreshTravelContext(request, history), true);
  assert.equal(inferRecentTravelCountry(history), "PL");
});

test("switching to another country or city resets destination-specific context", () => {
  const history = ["Plan a two-day Warsaw trip near WAW by car"];

  assert.equal(isFreshTravelContext("Plan a two-day trip in Germany by car", history), true);
  assert.equal(isFreshTravelContext("What about Berlin?", history), true);
  assert.equal(isFreshTravelContext("Show museums there", history), false);
});

test("keeps only the active destination segment after a trip switch", () => {
  const history = [
    "Plan a two-day Warsaw trip near WAW by car",
    "Start over with a different country",
    "New plan: Germany — Berlin",
  ];
  const activeHistory = recentTravelContextMessages(history);

  assert.deepEqual(activeHistory, ["New plan: Germany — Berlin"]);
  assert.equal(isFreshTravelContext("Plan one day in Berlin by car", activeHistory), false);
  assert.equal(resolveTripPreferences([...activeHistory, "Plan one day in Berlin by car"]).airportCode, null);
});

test("resolves Russian and English trip preferences from the active trip only", () => {
  assert.deepEqual(resolveTripPreferences(["2 дня всего, без аэропорта, на машине"]), {
    airportCode: null,
    totalDays: 2,
    routeMode: "driving",
    cityOnly: true,
  });
  assert.deepEqual(resolveTripPreferences(["Keep one day, places without a route"]), {
    airportCode: null,
    totalDays: 1,
    routeMode: "none",
    cityOnly: false,
  });
  assert.equal(resolveTripPreferences(["Убери второй день"]).totalDays, 1);
  assert.equal(resolveTripPreferences(["Составь маршрут на 1 день"]).totalDays, 1);
  assert.equal(resolveTripPreferences(["План на три дня"]).totalDays, 3);
  assert.equal(resolveTripPreferences(["Plan for one day"]).totalDays, 1);
});

test("clarifies an airport, contradictory duration, and route mode in sequence", () => {
  const ambiguous = "Хочу посетить Варшаву: первый день у аэропорта, оставшиеся два дня по городу, пробыть там два дня, составь маршрут";
  const airportClarification = getTripClarification(ambiguous, [], "ru");
  assert.deepEqual(airportClarification?.choices.map((choice) => choice.id), ["airport-waw", "airport-wmi"]);

  const durationClarification = getTripClarification("WAW", [ambiguous], "ru");
  assert.deepEqual(durationClarification?.choices.map((choice) => choice.id), ["days-two", "days-three"]);

  const routeClarification = getTripClarification("2 дня всего", ["Составь маршрут по Варшаве у аэропорта WAW"], "ru");
  assert.deepEqual(routeClarification?.choices.map((choice) => choice.id), ["route-driving", "route-none"]);
});

test("does not carry the prior Warsaw airport flow into a new named destination", () => {
  const newTrip = "New plan: Germany — Berlin";
  assert.equal(getTripClarification(newTrip, [], "en"), null);
  assert.equal(isFreshTravelContext(newTrip, ["Plan a Warsaw trip near WAW for two days by car"]), true);
  assert.equal(resolveTripPreferences([newTrip]).airportCode, null);
});

test("parses trip lengths up to seven days in Russian, English, and German", () => {
  assert.equal(resolveTripPreferences(["Буду четыре дня в Берлине"]).totalDays, 4);
  assert.equal(resolveTripPreferences(["План на 5 дней"]).totalDays, 5);
  assert.equal(resolveTripPreferences(["Plan six days in Madrid"]).totalDays, 6);
  assert.equal(resolveTripPreferences(["Sieben Tage in Rom"]).totalDays, 7);
  assert.equal(resolveTripPreferences(["Хочу в Париж на неделю"]).totalDays, 7);
  assert.equal(resolveTripPreferences(["Поездка на 10 дней"]).totalDays, null);
  assert.equal(resolveTripPreferences(["3-4 места на каждый день"]).totalDays, null);
});

test("asks for the route mode on a multi-day plan in any supported city", () => {
  const berlinTrip = "Хотел бы полететь в Берлин. Буду четыре дня, на каждый день три-четыре места";
  assert.deepEqual(getTripClarification(berlinTrip, [], "ru")?.choices.map((choice) => choice.id), ["route-driving", "route-none"]);
  assert.deepEqual(getTripClarification("Построй пути по этим точкам", [berlinTrip], "ru")?.choices.map((choice) => choice.id), ["route-driving", "route-none"]);
  assert.equal(getTripClarification("Да, автомобильный маршрут", [berlinTrip, "Построй пути по этим точкам"], "ru"), null);
  assert.deepEqual(resolveTripPreferences([berlinTrip, "Построй пути по этим точкам", "Да, автомобильный маршрут"]), {
    airportCode: null,
    totalDays: 4,
    routeMode: "driving",
    cityOnly: false,
  });
  assert.equal(getTripClarification("Что посмотреть в Берлине?", [], "ru"), null);
});

test("rebuilds a trip plan only on turns about the trip", () => {
  for (const message of ["Да, автомобильный маршрут", "Нет, покажи только список мест", "Убери второй день", "WAW", "3 дня всего", "Plan four days in Berlin", "Построй пути по этим точкам"]) {
    assert.equal(isTripPlanningMessage(message), true, message);
  }
  for (const message of ["Which data sources are available?", "Что это за место?", "Show me the latest earthquakes", "Какие источники доступны?"]) {
    assert.equal(isTripPlanningMessage(message), false, message);
  }
});
