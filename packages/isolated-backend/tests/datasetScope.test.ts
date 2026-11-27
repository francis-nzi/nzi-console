import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { internationalDefaultAllows, isGridElectricity, registeredCountryCode, windowMonths, windowYearParts } from "../src/datasetScope";
import { migratedRecordProblems } from "../src/v7ClientImport";
import { EXTRACT_CONTRACT } from "../src/v7ClientExtract";

/** Datasets by period and site (DESIGN §1, §4): the window's years and months, the client's country, D-A, the extract's dataset country. */
describe("datasets by period: the pure parts", () => {
  it("a window's calendar years, each with its part; a calendar year is one part", () => {
    assert.deepEqual(windowYearParts({ from: "2024-05-01", to: "2025-04-30" }), [{ year: 2024, from: "2024-05-01", to: "2024-12-31" }, { year: 2025, from: "2025-01-01", to: "2025-04-30" }]);
    assert.deepEqual(windowYearParts({ from: "2024-01-01", to: "2024-12-31" }), [{ year: 2024, from: "2024-01-01", to: "2024-12-31" }]);
    assert.equal(windowYearParts({ from: "2023-01-12", to: "2025-04-30" }).length, 3);
  });

  it("a window's months, in order", () => {
    assert.deepEqual(windowMonths({ from: "2025-11-01", to: "2026-02-28" }), ["2025-11", "2025-12", "2026-01", "2026-02"]);
    assert.equal(windowMonths({ from: "2024-05-01", to: "2025-04-30" }).length, 12);
  });

  it("the client's registered country, in words or a code; the UK's nations are the UK; anything else is not a country (D-D)", () => {
    assert.deepEqual(["United Kingdom", "Scotland", "England", "Northern Ireland", "Ireland", "United Arab Emirates", "USA", "Kenya", "Netherlands", "GB", "Aberdeenshire", "  ", null]
      .map(registeredCountryCode), ["GB", "GB", "GB", "GB", "IE", "AE", "US", "KE", "NL", "GB", null, null, null]);
  });

  it("library L-5: grid electricity is Scope 2 or the UK grid's lines; spend is not", () => {
    assert.equal(isGridElectricity({ label: "Electricity", scopes: ["2"] }), true);
    assert.equal(isGridElectricity({ label: "Transmission and distribution - T&D- UK electricity", scopes: ["3"] }), true);
    assert.equal(isGridElectricity({ label: "Land transport services", scopes: ["3"] }), false);
  });

  it("D-A: DESNZ serves another country's activity, never its electricity or spend", () => {
    assert.equal(internationalDefaultAllows({ factorId: "uk-ghg-gas", label: "Fuels - Natural gas", scopes: ["1"] }), true);
    assert.equal(internationalDefaultAllows({ factorId: "uk-ghg-7_400", label: "UK electricity - Electricity generated", scopes: ["2"] }), false);
    assert.equal(internationalDefaultAllows({ factorId: "uk-ghg-td", label: "Transmission and distribution - T&D- UK electricity", scopes: ["3"] }), false);
    assert.equal(internationalDefaultAllows({ factorId: "uk-ghg-SPEND-SIC-20.5", label: "Chemicals", scopes: ["3"] }), false);
  });

  it("the extract reads each dataset's country, and a migrated record carries it as a code only", () => {
    assert.ok(EXTRACT_CONTRACT.datasets.optional.includes("country"));
    const record = { qty: 1, uom: "kWh", apply_pct: 100, factor: 0.2, ghg_unit: "kg", original_id: "g", reported_tco2e: 0.0002, data_source: "Other", enabled: true };
    assert.deepEqual(migratedRecordProblems({ ...record, dataset: { id: "7", year: 2025, version: null, country: "IN" } }), []);
    assert.deepEqual(migratedRecordProblems({ ...record, dataset: { id: "7", year: 2025, version: null } }), [], "a record from an extract without it stays valid");
    assert.deepEqual(migratedRecordProblems({ ...record, dataset: { id: "7", year: 2025, version: null, country: "India" } }), ["migrated_record.dataset.country: not a country"]);
  });
});
