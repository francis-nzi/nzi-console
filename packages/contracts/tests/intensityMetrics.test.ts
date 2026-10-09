import test from "node:test";
import assert from "node:assert/strict";
import {
  activeMetrics, indexedSeries, intensityDenominatorText, intensityPer, intensityUnit, intensityUnitShort, resolveIntensity,
  suggestIconKey, isIntensityIconKey, type IntensityMetricDefinition,
} from "../src/intensityMetrics";
import { currencySymbol, setCurrencyDirectory, withCurrencyDirectory } from "../src/currencyDirectory";

/**
 * The one intensity computation. The client YoY, the intensity detail, the job capture,
 * the portal and the report all read these, so what they encode is what every surface
 * shows — including when it shows nothing.
 */

const GBP = { currency: "GBP" };

const metric = (over: Partial<IntensityMetricDefinition> = {}): IntensityMetricDefinition => ({
  key: "employees", version: 1, label: "Employees", unitWording: "employee", unitKind: "text", divider: 1,
  iconKey: "people", isStandard: true, valueSource: "entered", active: true, ordering: 1, ...over,
});

test("intensity is emissions × divider ÷ value", () => {
  const perHead = resolveIntensity({ definition: metric(), emissionsTco2e: 1706, value: 240, currency: "GBP" });
  assert.equal(perHead.state, "resolved");
  if (perHead.state === "resolved") assert.ok(Math.abs(perHead.value - 7.108) < 0.001);

  // The divider is part of the meaning: the same data per 1,000 is a thousand times larger.
  const perThousand = resolveIntensity({ definition: metric({ divider: 1000 }), emissionsTco2e: 1706, value: 240, currency: "GBP" });
  if (perThousand.state === "resolved" && perHead.state === "resolved") {
    assert.ok(Math.abs(perThousand.value - perHead.value * 1000) < 0.001);
  }
});

test("the unit says the divider out loud, and pluralises the noun", () => {
  assert.equal(intensityUnit(metric(), GBP), "tCO₂e / employee");
  assert.equal(intensityUnit(metric({ divider: 1000 }), GBP), "tCO₂e per 1,000 employees");
  assert.equal(intensityUnit(metric({ unitWording: "box", divider: 100 }), GBP), "tCO₂e per 100 boxes");
  assert.equal(intensityUnit(metric({ unitWording: "lorry", divider: 10 }), GBP), "tCO₂e per 10 lorries");
  // A notation is not a noun and must never gain an "s" — "1,000,000 £ms" is nonsense.
  assert.equal(intensityUnit(metric({ unitWording: "m²", divider: 1000 }), GBP), "tCO₂e per 1,000 m²");
  assert.equal(intensityUnit(metric({ unitWording: "£m", divider: 1 }), GBP), "tCO₂e / £m");
  // A unit that already carries its magnitude is never prefixed again — "per 1,000,000 £m" counted the million twice.
  assert.equal(intensityUnit(metric({ unitWording: "£m", divider: 1000000 }), GBP), "tCO₂e per £m");
  assert.equal(intensityUnit(metric({ unitWording: "kWh", divider: 100 }), GBP), "tCO₂e per 100 kWh");
  assert.equal(intensityUnit(metric({ unitWording: "m³", divider: 10 }), GBP), "tCO₂e per 10 m³");
  assert.equal(intensityUnitShort(metric({ divider: 1000 }), GBP), "tCO₂e/1k employees");
});

test("a currency metric reads in the client's currency, with the magnitude once (D3c)", () => {
  const turnover = (divider: IntensityMetricDefinition["divider"]) => metric({ key: "turnover", label: "Turnover", unitWording: "£m", unitKind: "currency", divider });
  // Every divider, in sterling: the symbol joins its magnitude, and an unnamed magnitude is spoken.
  const sterling: Array<[IntensityMetricDefinition["divider"], string, string]> = [
    [1, "tCO₂e per £", "tCO₂e/£"],
    [10, "tCO₂e per £10", "tCO₂e/£10"],
    [100, "tCO₂e per £100", "tCO₂e/£100"],
    [1000, "tCO₂e per £k", "tCO₂e/£k"],
    [10000, "tCO₂e per £10,000", "tCO₂e/£10,000"],
    [100000, "tCO₂e per £100,000", "tCO₂e/£100,000"],
    [1000000, "tCO₂e per £m", "tCO₂e/£m"],
  ];
  for (const [divider, long, short] of sterling) {
    assert.equal(intensityUnit(turnover(divider), GBP), long, `long, per ${divider}`);
    assert.equal(intensityUnitShort(turnover(divider), GBP), short, `short, per ${divider}`);
  }
  // The stored wording ("£m") is informational: a euro client reads euros, not pounds.
  assert.equal(intensityUnit(turnover(1000000), { currency: "EUR" }), "tCO₂e per €m");
  assert.equal(intensityUnit(turnover(1000), { currency: "USD" }), "tCO₂e per $k");
  assert.equal(intensityUnitShort(turnover(1000000), { currency: "EUR" }), "tCO₂e/€m");
  // A code with no symbol is written as the code, and a code is a word: it takes a space.
  assert.equal(intensityUnit(turnover(1000000), { currency: "AED" }), "tCO₂e per AED m");
  assert.equal(intensityUnit(turnover(1000), { currency: "CHF" }), "tCO₂e per CHF k");
  assert.equal(intensityUnit(turnover(1), { currency: "AED" }), "tCO₂e per AED");
  assert.equal(intensityUnitShort(turnover(1000000), { currency: "AED" }), "tCO₂e/AED m");
  // E-Q2 (superseding D3c's display alias): no "UAE" alias — 0145 corrected the stored value to AED.
  assert.equal(intensityUnit(turnover(1000000), { currency: "UAE" }), "tCO₂e per UAE m", "the country is not read as a currency");
  assert.equal(intensityUnit(turnover(1000000), { currency: " gbp " }), "tCO₂e per £m", "trimmed and case-blind");
});

test("currencySymbol is the one place a currency becomes a symbol (D3c), and before a directory is read it holds D3c's three", () => {
  assert.deepEqual(["GBP", "EUR", "USD", "AED", "UAE", "eur", "JPY"].map(currencySymbol), ["£", "€", "$", "AED", "UAE", "€", "JPY"]);
});

test("currencySymbol reads the organisation's currencies once they are read (E1)", () => {
  const directory = [
    { code: "GBP", name: "Pound sterling", symbol: "£" },
    { code: "AED", name: "UAE dirham", symbol: "Dh" },
    { code: "CHF", name: "Swiss franc", symbol: "Fr." },
  ];
  setCurrencyDirectory(directory);
  try {
    assert.deepEqual(["GBP", "AED", "chf", "EUR", "UAE"].map(currencySymbol), ["£", "Dh", "Fr.", "EUR", "UAE"],
      "the organisation's own symbols; a code it does not hold is written as itself — D3c's built-in three no longer stand in");
    assert.equal(intensityUnit(metric({ unitKind: "currency", unitWording: "£m", divider: 1000000 }), { currency: "AED" }), "tCO₂e per Dhm");
  } finally {
    setCurrencyDirectory(null);
  }
  assert.equal(currencySymbol("AED"), "AED", "cleared: back to the before-read three");
});

test("withCurrencyDirectory scopes a directory to synchronous work and puts back what was there (E1)", () => {
  setCurrencyDirectory([{ code: "GBP", name: "Pound sterling", symbol: "£" }]);
  try {
    const inside = withCurrencyDirectory([{ code: "GBP", name: "Pound sterling", symbol: "GBP£" }], () => currencySymbol("GBP"));
    assert.equal(inside, "GBP£");
    assert.equal(currencySymbol("GBP"), "£", "restored");
    assert.throws(() => withCurrencyDirectory([], () => Promise.resolve(1)), /synchronous work only/);
    assert.equal(currencySymbol("GBP"), "£", "restored after a refusal too");
  } finally {
    setCurrencyDirectory(null);
  }
});

test("the per-phrase and the denominator follow the same rules (D3c)", () => {
  const turnover = metric({ key: "turnover", label: "Turnover", unitWording: "£m", unitKind: "currency", divider: 1000000 });
  assert.equal(intensityPer(turnover, GBP), "£m");
  assert.equal(intensityPer(turnover, { currency: "AED" }), "AED m");
  assert.equal(intensityPer(metric(), GBP), "employee");
  assert.equal(intensityPer(metric({ divider: 1000 }), GBP), "1,000 employees");
  // A currency value is whole units (0143): money, never "12,500,000 £m".
  assert.equal(intensityDenominatorText(turnover, 12_500_000, GBP), "£12,500,000");
  assert.equal(intensityDenominatorText(turnover, 3_000_000, { currency: "AED" }), "AED 3,000,000");
  assert.equal(intensityDenominatorText(metric(), 240, GBP), "240 employees");
});

test("a text denominator is plural unless it is one, and a notation stays as written", () => {
  assert.equal(intensityDenominatorText(metric(), 1, GBP), "1 employee");
  assert.equal(intensityDenominatorText(metric(), 0, GBP), "0 employees");
  assert.equal(intensityDenominatorText(metric(), 1.5, GBP), "1.5 employees");
  assert.equal(intensityDenominatorText(metric({ unitWording: "box" }), 12, GBP), "12 boxes");
  assert.equal(intensityDenominatorText(metric({ unitWording: "lorry" }), 3, GBP), "3 lorries");
  assert.equal(intensityDenominatorText(metric({ unitWording: "m²" }), 1200, GBP), "1,200 m²");
  assert.equal(intensityDenominatorText(metric({ unitWording: "kWh" }), 450, GBP), "450 kWh");
  assert.equal(intensityDenominatorText(metric({ unitWording: "FTE" }), 58, GBP), "58 FTE");
});

test("the resolver stamps the unit in the client's currency, so what is frozen is right (D3c)", () => {
  const turnover = metric({ key: "turnover", label: "Turnover", unitWording: "£m", unitKind: "currency", divider: 1000000 });
  const euros = resolveIntensity({ definition: turnover, emissionsTco2e: 50, value: 12_500_000, currency: "EUR" });
  assert.equal(euros.state, "resolved");
  if (euros.state === "resolved") {
    assert.equal(euros.value, 4, "50 tCO₂e over €12.5m is 4 tCO₂e per €m");
    assert.deepEqual([euros.unit, euros.unitShort], ["tCO₂e per €m", "tCO₂e/€m"]);
  }
});

test("a missing value is unavailable, never zero", () => {
  const none = resolveIntensity({ definition: metric(), emissionsTco2e: 1706, value: null, currency: "GBP" });
  assert.equal(none.state, "unavailable");
  if (none.state === "unavailable") assert.match(none.reason, /No employees value was recorded/);

  // Nothing to divide by, and nothing to divide.
  assert.equal(resolveIntensity({ definition: metric(), emissionsTco2e: 1706, value: 0, currency: "GBP" }).state, "unavailable");
  const noTotal = resolveIntensity({ definition: metric(), emissionsTco2e: null, value: 240, currency: "GBP" });
  assert.equal(noTotal.state, "unavailable");
  if (noTotal.state === "unavailable") assert.match(noTotal.reason, /No assured total/);
});

test("a site-derived metric explains itself differently from a typed one", () => {
  const floor = metric({ key: "floor-area", label: "Floor area", unitWording: "m²", valueSource: "site-floor-area", isStandard: false });
  const missing = resolveIntensity({ definition: floor, emissionsTco2e: 1706, value: null, currency: "GBP" });
  if (missing.state === "unavailable") assert.match(missing.reason, /No floor area could be resolved/);
  const resolved = resolveIntensity({ definition: floor, emissionsTco2e: 1706, value: 3400, currency: "GBP" });
  if (resolved.state === "resolved") assert.equal(resolved.source, "site-floor-area");
});

test("the active set puts the standard pair first, and drops what was deactivated", () => {
  const set = activeMetrics([
    metric({ key: "water", label: "Water", isStandard: false, ordering: 5 }),
    metric({ key: "retired", label: "Retired", isStandard: false, active: false }),
    metric({ key: "turnover", label: "Turnover", isStandard: true, ordering: 2 }),
    metric({ key: "employees", isStandard: true, ordering: 1 }),
  ]);
  assert.deepEqual(set.map((entry) => entry.key), ["employees", "turnover", "water"]);
});

test("indexing needs two years, and reports the real figure alongside", () => {
  const years = [
    { year: 2023, intensity: resolveIntensity({ definition: metric(), emissionsTco2e: 1842, value: 230, currency: "GBP" }) },
    { year: 2024, intensity: resolveIntensity({ definition: metric(), emissionsTco2e: 1706, value: 240, currency: "GBP" }) },
  ];
  const series = indexedSeries(years)!;
  assert.equal(series[0]!.value, 100, "the first resolved year is the base");
  assert.ok(series[1]!.value < 100, "intensity fell");
  assert.ok(Math.abs(series[1]!.absolute - 7.108) < 0.001, "the real figure travels with the index");
  // One point is not a shape.
  assert.equal(indexedSeries(years.slice(0, 1)), null);
  assert.equal(indexedSeries([{ year: 2024, intensity: resolveIntensity({ definition: metric(), emissionsTco2e: 1706, value: null, currency: "GBP" }) }]), null);
});

test("an icon is suggested from the name and always resolves to the curated set", () => {
  assert.equal(suggestIconKey("Fleet vehicles", "vehicle"), "vehicle");
  assert.equal(suggestIconKey("Water use", "m³"), "water");
  assert.equal(suggestIconKey("Headcount"), "people");
  assert.equal(suggestIconKey("Turnover", "£m"), "currency");
  // Anything unrecognised gets the neutral glyph rather than nothing.
  assert.equal(suggestIconKey("Wibble"), "metric");
  for (const label of ["Fleet vehicles", "Wibble", ""]) assert.ok(isIntensityIconKey(suggestIconKey(label)));
});
