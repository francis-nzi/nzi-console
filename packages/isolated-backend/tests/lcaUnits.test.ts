import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyFreightDenominator, detourFactor, ghgNumeratorToKgMultiplier, haversineDistanceKm,
  lineItemKgco2e, materialBasisMultiplier, MILES_PER_KM, transportLegKgco2e,
} from "../src/index";

// Parity with NZI Live services/lca_engine.py + lca_transport.py
// (docs/_handoff_LCA_engine_parity.md §1–§7).

describe("ghgNumeratorToKgMultiplier (§3 — numerator decides kg/tonne/gram)", () => {
  it("kg numerator (and the fallback) → 1", () => {
    assert.equal(ghgNumeratorToKgMultiplier("kgCO2e/kg"), 1);
    assert.equal(ghgNumeratorToKgMultiplier("kgco2e/tonne.km"), 1);
    assert.equal(ghgNumeratorToKgMultiplier(null), 1);
    assert.equal(ghgNumeratorToKgMultiplier("whatever"), 1);
  });
  it("tonne numerator → 1000", () => {
    assert.equal(ghgNumeratorToKgMultiplier("tCO2e/tonne"), 1000);
    assert.equal(ghgNumeratorToKgMultiplier("tonneCO2e/kg"), 1000);
  });
  it("gram numerator → 0.001 (only when not kg)", () => {
    assert.equal(ghgNumeratorToKgMultiplier("gCO2e/kg"), 0.001);
    assert.equal(ghgNumeratorToKgMultiplier("kgCO2e/g"), 1, "kg in the numerator wins");
  });
});

describe("materialBasisMultiplier (§2 — denominator tonne → 0.001)", () => {
  it("per-kg or non-mass denominator → 1", () => {
    assert.equal(materialBasisMultiplier("kgCO2e/kg"), 1);
    assert.equal(materialBasisMultiplier("kgCO2e/litre"), 1);
    assert.equal(materialBasisMultiplier("kg"), 1);
  });
  it("per-tonne denominator → 0.001", () => {
    assert.equal(materialBasisMultiplier("kgCO2e/tonne"), 0.001);
    assert.equal(materialBasisMultiplier("tonne.km"), 0.001);
  });
});

describe("classifyFreightDenominator (§1)", () => {
  it("tonne + km → tonne_km; tonne + mile → tonne_mile; mile → mile; else km", () => {
    assert.equal(classifyFreightDenominator("kgCO2e/tonne.km"), "tonne_km");
    assert.equal(classifyFreightDenominator("kgCO2e/tonne-mile"), "tonne_mile");
    assert.equal(classifyFreightDenominator("kgCO2e/mile"), "mile");
    assert.equal(classifyFreightDenominator("kgCO2e/km"), "km");
    assert.equal(classifyFreightDenominator("kgCO2e/vehicle"), "km", "anything odd falls to the km branch, never 0");
    assert.equal(classifyFreightDenominator(null), "km");
  });
});

describe("lineItemKgco2e (§2)", () => {
  it("per-kg dataset factor: quantity(kg) × factor", () => {
    assert.equal(lineItemKgco2e(31.5, 1.68, "kgco2e/kg"), 31.5 * 1.68);
  });
  it("per-tonne factor folds the kg→tonne basis in", () => {
    assert.ok(Math.abs(lineItemKgco2e(1000, 2, "kgco2e/tonne") - 2) < 1e-9, "1000 kg = 1 tonne × 2 = 2 kg");
  });
  it("tCO2e numerator scales the result to kg", () => {
    assert.ok(Math.abs(lineItemKgco2e(1000, 2, "tco2e/tonne") - 2000) < 1e-9);
  });
  it("clamps negative quantity / factor to zero", () => {
    assert.equal(lineItemKgco2e(-5, 1.68, "kgco2e/kg"), 0);
    assert.equal(lineItemKgco2e(5, -1, "kgco2e/kg"), 0);
  });
});

describe("transportLegKgco2e (§1)", () => {
  it("tonne.km: mass_tonnes × distance_km × factor", () => {
    // 31.5 kg = 0.0315 t · 19600 km · 0.015 kgCO2e/t.km
    const got = transportLegKgco2e({ massKg: 31.5, distanceKm: 19600, factorValue: 0.015, factorUnit: "kgco2e/tonne.km" });
    assert.ok(Math.abs(got - 0.0315 * 19600 * 0.015) < 1e-9);
  });
  it("tonne.mile: converts km→miles first", () => {
    const got = transportLegKgco2e({ massKg: 1000, distanceKm: 100, factorValue: 0.02, factorUnit: "kgco2e/tonne-mile" });
    assert.ok(Math.abs(got - 1 * (100 * MILES_PER_KM) * 0.02) < 1e-9);
  });
  it("per-km factor is mass-independent (a per-vehicle-trip figure)", () => {
    const a = transportLegKgco2e({ massKg: 10, distanceKm: 100, factorValue: 0.12, factorUnit: "kgco2e/km" });
    const b = transportLegKgco2e({ massKg: 999, distanceKm: 100, factorValue: 0.12, factorUnit: "kgco2e/km" });
    assert.equal(a, b);
    assert.ok(Math.abs(a - 100 * 0.12) < 1e-9);
  });
  it("a null (manual, unitless) factor takes the mass-independent km branch, never 0", () => {
    assert.ok(Math.abs(transportLegKgco2e({ massKg: 31.5, distanceKm: 42, factorValue: 0.05, factorUnit: null }) - 42 * 0.05) < 1e-9);
  });
});

describe("haversineDistanceKm / detourFactor (§7)", () => {
  it("London ↔ Paris ≈ 344 km", () => {
    const km = haversineDistanceKm({ lat: 51.5074, lng: -0.1278 }, { lat: 48.8566, lng: 2.3522 });
    assert.ok(Math.abs(km - 344) < 5, `got ${km}`);
  });
  it("detour: road 1.25, rail 1.2, sea 1.0, air 1.05, unknown 1.0", () => {
    assert.equal(detourFactor("road_hgv"), 1.25);
    assert.equal(detourFactor("road_van"), 1.25);
    assert.equal(detourFactor("rail"), 1.2);
    assert.equal(detourFactor("sea"), 1.0);
    assert.equal(detourFactor("air"), 1.05);
    assert.equal(detourFactor("inland_water"), 1.0);
    assert.equal(detourFactor("nonsense"), 1.0);
  });
});
