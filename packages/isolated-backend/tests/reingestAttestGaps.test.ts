import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AssuranceGap } from "@nzi/contracts";
import { recordOfAccountGap, UNMAPPED_REPORTED_TOTAL_REASON, ZERO_RECORD_OF_ACCOUNT_REASON, type AttestScopeRow } from "../src/reingestAttest";

/**
 * RULING-reingest-bulk-attest 3, a hard boundary: the attestation resolves a gap only where its reason is literally true. Every
 * gap flag the engine raises, against the rule — the two record-of-account cases resolve; everything else is left for a person.
 */
const gap = (flag: AssuranceGap["flag"], key: string, scopeRowId: string | null): AssuranceGap =>
  ({ key, flag, scopeRowId, scopeCode: null, siteId: null, label: "x", detail: "x", resolved: false, resolution: null });
const row = (over: Partial<AttestScopeRow> = {}): AttestScopeRow => ({ rowId: "r1", label: "Row", reportedTotal: false, v7Tco2e: 0, tco2e: 0, ...over });

describe("recordOfAccountGap: only the two record-of-account gaps", () => {
  it("unmapped on a reported-total row: resolved, with the reported-total reason", () => {
    assert.deepEqual(recordOfAccountGap(gap("unmapped", "unmapped:r1", "r1"), row({ reportedTotal: true, v7Tco2e: 2.19, tco2e: 2.19 })),
      { gapKey: "unmapped:r1", flag: "unmapped", rowId: "r1", label: "Row", reason: UNMAPPED_REPORTED_TOTAL_REASON });
  });
  it("zero_blank where v7 recorded 0 and the row reproduces 0: resolved, with the zero reason", () => {
    assert.equal(recordOfAccountGap(gap("zero_blank", "zero_blank:r1", "r1"), row())?.reason, ZERO_RECORD_OF_ACCOUNT_REASON);
  });
  it("both halves of the zero rule: v7 non-zero, or the row non-zero, or either unknown — not resolved", () => {
    for (const over of [{ v7Tco2e: 0.2, tco2e: 0.2 }, { v7Tco2e: 0, tco2e: 0.5 }, { v7Tco2e: null, tco2e: 0 }, { v7Tco2e: 0, tco2e: null }])
      assert.equal(recordOfAccountGap(gap("zero_blank", "zero_blank:r1", "r1"), row(over)), null, JSON.stringify(over));
  });
  it("unmapped on any other row (a missing factor) is a judgment — not resolved", () => {
    assert.equal(recordOfAccountGap(gap("unmapped", "unmapped:r1", "r1"), row({ reportedTotal: false, v7Tco2e: 0.2, tco2e: 0.2 })), null);
    assert.equal(recordOfAccountGap(gap("unmapped", "uncalculated:r1", "r1"), row({ reportedTotal: true })), null, "the uncalculated variant is not the reported-total case");
  });
  it("category, site, YoY and out-of-boundary gaps are never resolved — on the row or not", () => {
    for (const g of [gap("completeness", "completeness:category:3.6", null), gap("completeness", "completeness:site:s1", null),
      gap("yoy_movement", "yoy_movement:category:3.1", null), gap("out_of_boundary", "out_of_boundary:r1", "r1")])
      assert.equal(recordOfAccountGap(g, row({ reportedTotal: true })), null, g.key);
  });
  it("a gap on a row outside the act (rejected, another run's, not linked) — not resolved", () => {
    assert.equal(recordOfAccountGap(gap("zero_blank", "zero_blank:r2", "r2"), undefined), null);
    assert.equal(recordOfAccountGap(gap("zero_blank", "zero_blank:r2", "r2"), row({ rowId: "r1" })), null, "the row must be the gap's own");
  });
});
