import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { JobApplicableCategories, ScopeRowReadModel } from "@nzi/contracts";
import {
  accordionAttentionRows,
  accordionTotals,
  buildDataEntryAccordion,
  rowCategoryCode,
} from "../app/jobs/dataEntryAccordion";

const row = (overrides: Partial<ScopeRowReadModel> = {}): ScopeRowReadModel => ({
  id: "row-a", jobId: "job-a", scope: "1", sourceLabel: "Gas", reportLabel: "Gas", notes: null,
  categoryPath: [], monthlyActivity: [], quantity: 10, unit: "kWh", datasetId: "d", factorId: "f",
  factorVersion: "v1", factorLabel: "Gas factor", qualityTier: "measured", calculatedTco2e: 1,
  overrideTco2e: null, overrideReason: null, reviewStatus: "approved", reviewedRowVersion: 1,
  reviewedBy: "r", reviewedAt: "2026-08-29", reviewerNote: null, version: 2, enabled: true,
  provenance: {}, lineage: [], ...overrides,
});

const applicable = (categories: JobApplicableCategories["categories"], includedScopes: JobApplicableCategories["includedScopes"] = ["1", "3"]): JobApplicableCategories => ({
  audience: "crm", includedScopes, categories,
});
const cat = (over: Partial<JobApplicableCategories["categories"][number]> & { scope: "1" | "2" | "3"; code: string; name: string }): JobApplicableCategories["categories"][number] => ({
  kind: "manual", entryCount: 0, tco2e: 0, completeness: 0, noData: true, ...over,
});

describe("rowCategoryCode", () => {
  it("uses the stamped category_code when it maps to the taxonomy", () => {
    assert.equal(rowCategoryCode(row({ categoryCode: "1.natural-gas" })), "1.natural-gas");
  });
  it("falls back to the row's own scope string for legacy granular Scope 3 rows", () => {
    assert.equal(rowCategoryCode(row({ scope: "3.1", categoryCode: null })), "3.1");
    assert.equal(rowCategoryCode(row({ scope: "3.15" })), "3.15");
  });
  it("returns null for a top-level Scope 1/2 row that cannot be placed", () => {
    assert.equal(rowCategoryCode(row({ scope: "1", categoryCode: null })), null);
    assert.equal(rowCategoryCode(row({ scope: "2" })), null);
  });
  it("returns null for an unknown code", () => {
    assert.equal(rowCategoryCode(row({ categoryCode: "9.99" })), null);
  });
});

describe("buildDataEntryAccordion", () => {
  it("places rows in their category and keeps the server metrics authoritative", () => {
    const groups = buildDataEntryAccordion(
      [row({ id: "r1", scope: "3.1", categoryCode: "3.1" }), row({ id: "r2", scope: "3.1", categoryCode: "3.1" })],
      applicable([
        cat({ scope: "3", code: "3.1", name: "Purchased Goods and Services", kind: "spend", entryCount: 2, tco2e: 686.3, completeness: 50, noData: false }),
        cat({ scope: "3", code: "3.2", name: "Capital Goods", kind: "spend" }),
      ], ["3"]),
    );
    assert.equal(groups.length, 1);
    const pgs = groups[0]!.categories.find(entry => entry.category.code === "3.1")!;
    assert.equal(pgs.rows.length, 2);
    assert.equal(pgs.tco2e, 686.3);
    assert.equal(pgs.completeness, 50);
    assert.equal(pgs.noData, false);
    const capital = groups[0]!.categories.find(entry => entry.category.code === "3.2")!;
    assert.equal(capital.rows.length, 0);
    assert.equal(capital.noData, true);
  });

  it("never drops a row — an unplaceable Scope 1 row lands in that scope's unsorted bucket", () => {
    const groups = buildDataEntryAccordion(
      [row({ id: "u1", scope: "1", categoryCode: null }), row({ id: "g1", scope: "1", categoryCode: "1.natural-gas" })],
      applicable([cat({ scope: "1", code: "1.natural-gas", name: "Natural Gas", entryCount: 1, noData: false })], ["1"]),
    );
    assert.deepEqual(groups[0]!.unsorted.map(r => r.id), ["u1"]);
    assert.deepEqual(groups[0]!.categories[0]!.rows.map(r => r.id), ["g1"]);
  });

  it("only renders scopes the read model says are included", () => {
    const groups = buildDataEntryAccordion([], applicable([cat({ scope: "3", code: "3.1", name: "Purchased Goods and Services", kind: "spend" })], ["3"]));
    assert.deepEqual(groups.map(group => group.scope), ["3"]);
  });

  it("counts needs-attention per category from the placed rows", () => {
    const groups = buildDataEntryAccordion(
      [
        row({ id: "ok", scope: "3.1", categoryCode: "3.1", reviewStatus: "approved" }),
        row({ id: "pending", scope: "3.1", categoryCode: "3.1", reviewStatus: "pending" }),
        row({ id: "nofactor", scope: "3.1", categoryCode: "3.1", calculatedTco2e: null, overrideTco2e: null }),
      ],
      applicable([cat({ scope: "3", code: "3.1", name: "Purchased Goods and Services", kind: "spend", entryCount: 3, noData: false })], ["3"]),
    );
    assert.equal(groups[0]!.categories[0]!.needsAttention, 2);
  });
});

describe("accordionAttentionRows / accordionTotals", () => {
  it("attention lens is the exception filter over every row", () => {
    const rows = [row({ id: "a", reviewStatus: "approved" }), row({ id: "b", reviewStatus: "rejected" }), row({ id: "c", qualityTier: null })];
    assert.deepEqual(accordionAttentionRows(rows).map(r => r.id), ["b", "c"]);
  });

  it("totals summarise category coverage and combine category + unsorted attention", () => {
    const groups = buildDataEntryAccordion(
      [row({ id: "u", scope: "1", categoryCode: null, reviewStatus: "pending" }), row({ id: "g", scope: "3.1", categoryCode: "3.1", reviewStatus: "pending" })],
      applicable([
        cat({ scope: "1", code: "1.natural-gas", name: "Natural Gas" }),
        cat({ scope: "3", code: "3.1", name: "Purchased Goods and Services", kind: "spend", entryCount: 1, noData: false }),
      ], ["1", "3"]),
    );
    const totals = accordionTotals(groups);
    assert.equal(totals.categories, 2);
    assert.equal(totals.withData, 1);
    assert.equal(totals.unsorted, 1);
    assert.equal(totals.needsAttention, 2);
  });
});
