import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AssuranceAuditRow, AssuranceGap, JobApplicableCategories, ScopeRowReadModel } from "@nzi/contracts";
import { formatQuantity, formatTonnes } from "../app/lib/formatNumber";
import { accordionTotals, buildDataEntryAccordion, visibleAccordionRows } from "../app/jobs/dataEntryAccordion";
import { auditRowIsDone, filterAuditRows, filterGaps, worklistCounts } from "../app/jobs/assuranceWorklist";

/**
 * SPEC-review-surface-readiness §1–3 (display and reviewer workflow only — no figure, enabled set, D7 or report changes):
 * switched-off rows hidden by default; the working list drops a row once approved with its gaps resolved, with counts from
 * the same data; quantities shown with separators and two places, the stored value untouched.
 */
describe("§3 quantity formatting (display only)", () => {
  it("separators and exactly two places; float noise gone", () => {
    assert.equal(formatQuantity(10771.200000000003), "10,771.20");
    assert.equal(formatQuantity(4502003.46), "4,502,003.46");
    assert.equal(formatQuantity(356736), "356,736.00");
    assert.equal(formatQuantity(39099.132), "39,099.13");
    assert.equal(formatQuantity(0), "0.00");
  });
  it("a missing or non-finite value is a dash, never a zero", () => {
    for (const value of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(formatQuantity(value), "—");
    assert.equal(formatTonnes(null), "—");
  });
  it("tCO₂e keeps up to six places, so a small figure is never shown as 0.00, with separators like the quantities", () => {
    assert.equal(formatTonnes(43.416467), "43.416467");
    assert.equal(formatTonnes(11657.452248), "11,657.452248");
    assert.equal(formatTonnes(0.0015), "0.0015");
    assert.equal(formatTonnes(2.19), "2.19");
    assert.equal(formatTonnes(0.1 + 0.2), "0.30", "float noise rounded away at six places");
  });
  it("is display only: the input is not changed", () => {
    const stored = 10771.200000000003;
    formatQuantity(stored);
    assert.equal(stored, 10771.200000000003);
  });
});

const row = (overrides: Partial<ScopeRowReadModel> = {}): ScopeRowReadModel => ({
  id: "row-a", jobId: "job-a", scope: "1", sourceLabel: "Gas", reportLabel: "Gas", notes: null,
  categoryPath: [], monthlyActivity: [], quantity: 10, unit: "kWh", datasetId: "d", factorId: "f",
  factorVersion: "v1", factorLabel: "Gas factor", qualityTier: "measured", calculatedTco2e: 1,
  overrideTco2e: null, overrideReason: null, reviewStatus: "pending", reviewedRowVersion: null,
  reviewedBy: null, reviewedAt: null, reviewerNote: null, version: 2, enabled: true,
  provenance: {}, lineage: [], ...overrides,
});
const applicable: JobApplicableCategories = {
  audience: "crm", includedScopes: ["1"],
  categories: [{ scope: "1", code: "1.natural-gas", name: "Natural gas", kind: "manual", entryCount: 1, tco2e: 1, completeness: 100, noData: false }],
};

describe("§1 switched-off rows are hidden by default, never dropped", () => {
  // J000663's shape after the revert and re-run: the live row, its superseded original (category stripped, so it would be
  // Unsorted), a superseded original still filed, and v7's own switched-off row.
  const rows = [
    row({ id: "live", categoryCode: "1.natural-gas" }),
    row({ id: "superseded-stripped", categoryCode: null, enabled: false }),
    row({ id: "superseded-filed", categoryCode: "1.natural-gas", enabled: false }),
    row({ id: "v7", origin: "migrated", categoryCode: null, enabled: false }),
  ];
  it("off: only the enabled rows are listed, and Unsorted is empty", () => {
    const visible = visibleAccordionRows(rows, false);
    assert.deepEqual(visible.rows.map((r) => r.id), ["live"]);
    assert.equal(visible.switchedOff, 3, "the toggle says how many are behind it");
    const groups = buildDataEntryAccordion(visible.rows, applicable);
    assert.deepEqual(groups[0]!.categories[0]!.rows.map((r) => r.id), ["live"]);
    assert.deepEqual([groups[0]!.unsorted.length, groups[0]!.imported.length, accordionTotals(groups).unsorted], [0, 0, 0]);
  });
  it("on: every row is back where it was — nothing was deleted", () => {
    const visible = visibleAccordionRows(rows, true);
    assert.equal(visible.rows.length, 4);
    const groups = buildDataEntryAccordion(visible.rows, applicable);
    assert.deepEqual(groups[0]!.categories[0]!.rows.map((r) => r.id), ["live", "superseded-filed"]);
    assert.deepEqual([groups[0]!.unsorted.map((r) => r.id), groups[0]!.imported.map((r) => r.id)], [["superseded-stripped"], ["v7"]]);
  });
  it("the category's figures are the server's either way — the toggle changes what is listed, never a total", () => {
    const off = buildDataEntryAccordion(visibleAccordionRows(rows, false).rows, applicable)[0]!.categories[0]!;
    const on = buildDataEntryAccordion(visibleAccordionRows(rows, true).rows, applicable)[0]!.categories[0]!;
    assert.deepEqual([off.entryCount, off.tco2e], [on.entryCount, on.tco2e]);
  });
});

const audit = (rowId: string, reviewStatus: string): AssuranceAuditRow => ({ rowId, reviewStatus } as AssuranceAuditRow);
const gap = (key: string, scopeRowId: string | null, resolved: boolean): AssuranceGap => ({ key, scopeRowId, resolved } as AssuranceGap);

describe("§2 the working list drops a row once it is approved with its gaps resolved", () => {
  const rows = [audit("a", "approved"), audit("b", "approved"), audit("c", "pending"), audit("d", "rejected")];
  const gaps = [gap("zero_blank:b", "b", false), gap("unmapped:a", "a", true), gap("completeness:category:3.5", null, false)];
  it("done = approved and none of its own gaps open; a job-level gap does not hold a row back", () => {
    assert.equal(auditRowIsDone(rows[0]!, gaps), true, "approved, its gap resolved");
    assert.equal(auditRowIsDone(rows[1]!, gaps), false, "approved, but its zero gap is open");
    assert.equal(auditRowIsDone(rows[2]!, gaps), false, "pending");
    assert.deepEqual(filterAuditRows(rows, gaps, "todo").map((r) => r.rowId), ["b", "c", "d"]);
    assert.deepEqual(filterAuditRows(rows, gaps, "done").map((r) => r.rowId), ["a"]);
    assert.equal(filterAuditRows(rows, gaps, "all").length, 4, "still reachable");
  });
  it("approving a row and resolving its gap moves it to done — the counts come from the same data, so they move with it", () => {
    assert.deepEqual(worklistCounts(rows, gaps), { todo: 3, done: 1, awaitingReview: 2, approved: 2, openGaps: 2, resolvedGaps: 1 });
    const afterApprove = rows.map((r) => (r.rowId === "c" ? audit("c", "approved") : r));
    const afterResolve = gaps.map((g) => (g.key === "zero_blank:b" ? gap(g.key, "b", true) : g));
    assert.deepEqual(worklistCounts(afterApprove, afterResolve), { todo: 1, done: 3, awaitingReview: 1, approved: 3, openGaps: 1, resolvedGaps: 2 });
    assert.deepEqual(filterAuditRows(afterApprove, afterResolve, "todo").map((r) => r.rowId), ["d"]);
  });
  it("gaps: a resolved gap leaves the open list and stays under resolved", () => {
    assert.deepEqual(filterGaps(gaps, "open").map((g) => g.key), ["zero_blank:b", "completeness:category:3.5"]);
    assert.deepEqual(filterGaps(gaps, "resolved").map((g) => g.key), ["unmapped:a"]);
    assert.equal(filterGaps(gaps, "all").length, 3);
  });
});
