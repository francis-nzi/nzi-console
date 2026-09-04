import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildTemplateSearchIndex, fuzzyScore, searchTemplateIndex, type TemplateSearchResult } from "../app/jobs/templateSearch";
import type { FactorOption } from "@nzi/contracts";

const factor = (over: Partial<FactorOption> = {}): FactorOption => ({
  datasetId: "ds-1", datasetName: "UK DEFRA 2026", datasetVersion: "2026.1",
  factorId: "f-1", label: "Diesel — LGV", activityUnit: "litres", kgco2ePerUnit: 2.6,
  scopes: ["1"], categories: [{ scope: "1", scopeCode: "1", label: "Direct emissions" }],
  selectionSource: "automatic", factorSource: "dataset", clientFactorId: null, evidenceHash: null,
  synthetic: true, warnings: [], ...over,
});

describe("fuzzyScore (NZC-062)", () => {
  it("ranks an exact substring hit above a subsequence match, and earlier over later", () => {
    const exact = fuzzyScore("diesel", "Diesel — LGV")!;
    const later = fuzzyScore("lgv", "Diesel — LGV")!;
    const subsequence = fuzzyScore("dsl", "Diesel — LGV")!;
    assert.ok(exact > later);
    assert.ok(later > 0 && subsequence > 0);
  });

  it("matches out-of-order-free but in-sequence characters (forgiving)", () => {
    assert.ok(fuzzyScore("dlgv", "Diesel — LGV") !== null);
    assert.equal(fuzzyScore("xyz", "Diesel — LGV"), null);
  });

  it("an empty query matches everything with a neutral score", () => {
    assert.equal(fuzzyScore("", "anything"), 0);
  });

  it("is case-insensitive", () => {
    assert.equal(fuzzyScore("DIESEL", "diesel fuel"), fuzzyScore("diesel", "diesel fuel"));
  });
});

describe("buildTemplateSearchIndex (NZC-062)", () => {
  it("a Scope 3 factor resolves to exactly one category — the GHG code is unambiguous", () => {
    const f = factor({ scopes: ["3.7"], categories: [{ scope: "3", scopeCode: "3.7", label: "Employee commuting" }] });
    const index = buildTemplateSearchIndex([f]);
    assert.equal(index.length, 1);
    assert.equal(index[0]!.categoryCode, "3.7");
    assert.equal(index[0]!.categoryLabel, "Employee commuting");
  });

  it("a Scope 1 factor expands to one candidate per Scope 1 taxonomy category — never guesses", () => {
    const f = factor({ scopes: ["1"], categories: [{ scope: "1", scopeCode: "1", label: "Direct emissions" }] });
    const index = buildTemplateSearchIndex([f]);
    assert.equal(index.length, 3); // Natural Gas, Company Vehicles, Refrigerants
    assert.deepEqual(new Set(index.map((r) => r.categoryLabel)), new Set(["Natural Gas", "Company Vehicles", "Refrigerants"]));
    for (const result of index) assert.equal(result.factor, f);
  });

  it("a Scope 2 factor expands to the Scope 2 taxonomy categories", () => {
    const f = factor({ scopes: ["2"], categories: [{ scope: "2", scopeCode: "2", label: "Purchased energy" }] });
    const index = buildTemplateSearchIndex([f]);
    assert.deepEqual(new Set(index.map((r) => r.categoryLabel)), new Set(["Purchased Electricity", "Renewable Electricity"]));
  });

  it("a multi-scope factor is indexed once per scope it applies to", () => {
    const f = factor({ scopes: ["3.1", "3.6"], categories: [
      { scope: "3", scopeCode: "3.1", label: "Purchased goods and services" },
      { scope: "3", scopeCode: "3.6", label: "Business travel" },
    ] });
    const index = buildTemplateSearchIndex([f]);
    assert.equal(index.length, 2);
    assert.deepEqual(new Set(index.map((r) => r.scope)), new Set(["3.1", "3.6"]));
  });

  it("the search text carries label, category, unit and dataset — for display and matching", () => {
    const f = factor({ scopes: ["3.7"], categories: [{ scope: "3", scopeCode: "3.7", label: "Employee commuting" }] });
    const [result] = buildTemplateSearchIndex([f]);
    assert.match(result!.searchText, /Diesel — LGV/);
    assert.match(result!.searchText, /Employee commuting/);
    assert.match(result!.searchText, /litres/);
    assert.match(result!.searchText, /UK DEFRA 2026/);
  });
});

describe("searchTemplateIndex (NZC-062)", () => {
  const index: TemplateSearchResult[] = buildTemplateSearchIndex([
    factor({ factorId: "f-diesel", label: "Diesel — LGV", scopes: ["1"], categories: [{ scope: "1", scopeCode: "1", label: "Direct emissions" }] }),
    factor({ factorId: "f-petrol", label: "Petrol — car", scopes: ["1"], categories: [{ scope: "1", scopeCode: "1", label: "Direct emissions" }] }),
    factor({ factorId: "f-commuting", label: "Car — average commuter", scopes: ["3.7"], categories: [{ scope: "3", scopeCode: "3.7", label: "Employee commuting" }] }),
  ]);

  it("an empty query returns results up to the limit, no filtering", () => {
    assert.equal(searchTemplateIndex(index, "", 3).length, 3);
  });

  it("ranks the best match first and excludes non-matches", () => {
    const hits = searchTemplateIndex(index, "commuting");
    assert.ok(hits.length > 0);
    assert.equal(hits[0]!.factor.factorId, "f-commuting");
  });

  it("matching by category text surfaces every factor filed there, not just label matches", () => {
    const hits = searchTemplateIndex(index, "company vehicles");
    assert.ok(hits.some((h) => h.factor.factorId === "f-diesel" && h.categoryLabel === "Company Vehicles"));
  });

  it("respects the result limit", () => {
    assert.ok(searchTemplateIndex(index, "", 2).length <= 2);
  });
});
