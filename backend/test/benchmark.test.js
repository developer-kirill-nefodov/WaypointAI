import assert from "node:assert/strict";
import test from "node:test";
import { generateBenchmark } from "../src/services/benchmark-generator.ts";
import { HARD_CASES } from "../src/services/benchmark-hard-cases.ts";
import { summarizeResults, wilson } from "../src/services/benchmark-metrics.ts";
import { caseExpectationSchema, checkTurn } from "../src/services/eval-checks.ts";

/** Synthetic settlements. */
const cities = [{ name: "Testopoli", nameEn: "Testopolis", countryCode: "XT" }, { name: "Пробоград", nameEn: "Probograd", countryCode: "XT" }, { name: "Mockburg", nameEn: null, countryCode: "XT" }];
const eventTowns = [{ name: "Quietville", nameEn: null, countryCode: "XT" }];

test("generates a reproducible benchmark whose expectations are valid and accept local and English city names", () => {
  const first = generateBenchmark({ cities, eventTowns, seed: 7, perSkill: 6 });
  const second = generateBenchmark({ cities, eventTowns, seed: 7, perSkill: 6 });
  assert.deepEqual(first, second);
  assert.notDeepEqual(first, generateBenchmark({ cities, eventTowns, seed: 8, perSkill: 6 }));
  for (const item of [...first, ...HARD_CASES]) assert.ok(caseExpectationSchema.safeParse(item.expect).success, item.id);
  assert.equal(new Set([...first, ...HARD_CASES].map((item) => item.id)).size, first.length + HARD_CASES.length);
  // Cyrillic local names are not used in questions.
  assert.ok(first.every((item) => !item.question.includes("Пробоград")));
  const place = first.find((item) => item.skill === "places" && JSON.stringify(item.expect).includes("Testopoli"));
  assert.deepEqual(place.expect.args.city, ["Testopoli", "Testopolis"]);
  const counts = Object.fromEntries(["places", "events", "trips", "sources", "reply"].map((skill) => [skill, first.filter((item) => item.skill === skill).length]));
  assert.deepEqual(counts, { places: 12, events: 6, trips: 6, sources: 9, reply: 12 });
});

test("checks nested arguments and alternatives, and only the tool call at the first step", () => {
  const examCase = { id: "c", question: "q", language: "ru", enabled: true, expect: { tool: "plan_trip", args: { routeMode: "driving", "cities.0.name": ["Roma", "Rome"] }, mustInclude: ["Рим"] } };
  const checks = checkTurn(examCase, { toolCalls: [{ tool: "plan_trip", args: { cities: [{ name: "Rome", days: 2 }], routeMode: "driving" } }], answer: "" }, true);
  assert.deepEqual(checks.map((check) => [check.check, check.passed]), [["tool", true], ["args", true]]);
  const wrong = checkTurn(examCase, { toolCalls: [{ tool: "plan_trip", args: { cities: [{ name: "Milano" }], routeMode: "driving" } }], answer: "" }, true);
  assert.deepEqual(wrong.find((check) => check.check === "args").actual, { routeMode: "driving", "cities.0.name": "Milano" });
  // At the first step, reply must be an actual call; plain text is not an answer yet.
  const reply = { ...examCase, expect: { tool: "reply" } };
  assert.equal(checkTurn(reply, { toolCalls: [], answer: "Hello" }, true)[0].passed, false);
  assert.equal(checkTurn(reply, { toolCalls: [{ tool: "reply", args: {} }], answer: "" }, true)[0].passed, true);
});

test("summarizes accuracy per skill and language with Wilson intervals", () => {
  assert.deepEqual(wilson(0, 0), { passed: 0, total: 0, low: 0, high: 0 });
  const share = wilson(18, 20);
  assert.ok(share.low > 0.68 && share.low < 0.7 && share.high > 0.97 && share.high < 0.98, JSON.stringify(share));
  const metrics = summarizeResults([
    { skill: "places", language: "ru", passed: true, checks: [{ check: "tool", passed: true }, { check: "args", passed: true }] },
    { skill: "places", language: "en", passed: false, checks: [{ check: "tool", passed: true }, { check: "args", passed: false }] },
    { skill: "reply", language: "en", passed: false, checks: [{ check: "tool", passed: false }] },
  ]);
  assert.equal(metrics.overall.passed, 1);
  assert.deepEqual([metrics.bySkill.places.passed, metrics.bySkill.places.total], [1, 2]);
  assert.deepEqual([metrics.byLanguage.en.passed, metrics.byLanguage.en.total], [0, 2]);
  assert.deepEqual([metrics.tool.passed, metrics.tool.total, metrics.args.passed, metrics.args.total], [2, 3, 1, 2]);
});
