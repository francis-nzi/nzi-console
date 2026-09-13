import test from "node:test";
import assert from "node:assert/strict";
import {
  activeMetrics, indexedSeries, intensityUnit, intensityUnitShort, resolveIntensity,
  suggestIconKey, isIntensityIconKey, type IntensityMetricDefinition,
} from "../src/intensityMetrics";

/**
 * The one intensity computation. The client YoY, the intensity detail, the job capture,
 * the portal and the report all read these, so what they encode is what every surface
 * shows — including when it shows nothing.
 */

const metric = (over: Partial<IntensityMetricDefinition> = {}): IntensityMetricDefinition => ({
  key: "employees", version: 1, label: "Employees", unitWording: "employee", divider: 1,
  iconKey: "people", isStandard: true, valueSource: "entered", active: true, ordering: 1, ...over,
});

test("intensity is emissions × divider ÷ value", () => {
  const perHead = resolveIntensity({ definition: metric(), emissionsTco2e: 1706, value: 240 });
  assert.equal(perHead.state, "resolved");
  if (perHead.state === "resolved") assert.ok(Math.abs(perHead.value - 7.108) < 0.001);

  // The divider is part of the meaning: the same data per 1,000 is a thousand times larger.
  const perThousand = resolveIntensity({ definition: metric({ divider: 1000 }), emissionsTco2e: 1706, value: 240 });
  if (perThousand.state === "resolved" && perHead.state === "resolved") {
    assert.ok(Math.abs(perThousand.value - perHead.value * 1000) < 0.001);
  }
});

test("the unit says the divider out loud, and pluralises the noun", () => {
  assert.equal(intensityUnit(metric()), "tCO₂e / employee");
  assert.equal(intensityUnit(metric({ divider: 1000 })), "tCO₂e per 1,000 employees");
  assert.equal(intensityUnit(metric({ unitWording: "box", divider: 100 })), "tCO₂e per 100 boxes");
  assert.equal(intensityUnit(metric({ unitWording: "lorry", divider: 10 })), "tCO₂e per 10 lorries");
  // A notation is not a noun and must never gain an "s" — "1,000,000 £ms" is nonsense.
  assert.equal(intensityUnit(metric({ unitWording: "m²", divider: 1000 })), "tCO₂e per 1,000 m²");
  assert.equal(intensityUnit(metric({ unitWording: "£m", divider: 1 })), "tCO₂e / £m");
  assert.equal(intensityUnit(metric({ unitWording: "£m", divider: 1000000 })), "tCO₂e per 1,000,000 £m");
  assert.equal(intensityUnit(metric({ unitWording: "kWh", divider: 100 })), "tCO₂e per 100 kWh");
  assert.equal(intensityUnit(metric({ unitWording: "m³", divider: 10 })), "tCO₂e per 10 m³");
  assert.equal(intensityUnitShort(metric({ divider: 1000 })), "tCO₂e/1k employees");
});

test("a missing value is unavailable, never zero", () => {
  const none = resolveIntensity({ definition: metric(), emissionsTco2e: 1706, value: null });
  assert.equal(none.state, "unavailable");
  if (none.state === "unavailable") assert.match(none.reason, /No employees value was recorded/);

  // Nothing to divide by, and nothing to divide.
  assert.equal(resolveIntensity({ definition: metric(), emissionsTco2e: 1706, value: 0 }).state, "unavailable");
  const noTotal = resolveIntensity({ definition: metric(), emissionsTco2e: null, value: 240 });
  assert.equal(noTotal.state, "unavailable");
  if (noTotal.state === "unavailable") assert.match(noTotal.reason, /No assured total/);
});

test("a site-derived metric explains itself differently from a typed one", () => {
  const floor = metric({ key: "floor-area", label: "Floor area", unitWording: "m²", valueSource: "site-floor-area", isStandard: false });
  const missing = resolveIntensity({ definition: floor, emissionsTco2e: 1706, value: null });
  if (missing.state === "unavailable") assert.match(missing.reason, /No floor area could be resolved/);
  const resolved = resolveIntensity({ definition: floor, emissionsTco2e: 1706, value: 3400 });
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
    { year: 2023, intensity: resolveIntensity({ definition: metric(), emissionsTco2e: 1842, value: 230 }) },
    { year: 2024, intensity: resolveIntensity({ definition: metric(), emissionsTco2e: 1706, value: 240 }) },
  ];
  const series = indexedSeries(years)!;
  assert.equal(series[0]!.value, 100, "the first resolved year is the base");
  assert.ok(series[1]!.value < 100, "intensity fell");
  assert.ok(Math.abs(series[1]!.absolute - 7.108) < 0.001, "the real figure travels with the index");
  // One point is not a shape.
  assert.equal(indexedSeries(years.slice(0, 1)), null);
  assert.equal(indexedSeries([{ year: 2024, intensity: resolveIntensity({ definition: metric(), emissionsTco2e: 1706, value: null }) }]), null);
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
