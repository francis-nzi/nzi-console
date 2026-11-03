import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { plainInternalNames, plainInternalNamesDeep } from "../src/userFacingText";

/** Stored text written under the old name is shown in plain words; codes and identifiers are left exactly as they are. */
describe("plainInternalNames", () => {
  it("says what the internal name stood for, in words a person can read", () => {
    assert.equal(plainInternalNames("Re-ingested from NZ Insights Pro v7"), "Re-ingested from the previous system");
    assert.equal(plainInternalNames("carries v7's 12 t (v7 row abc)"), "carries the previous system’s 12 t (the previous system row abc)");
    assert.equal(plainInternalNames("against the v7 figure"), "against the previous system figure", "no doubled article");
    assert.equal(plainInternalNames("v7 reported total, no activity data (record of account)"), "the previous system reported total, no activity data (record of account)");
    assert.equal(plainInternalNames("NZ Insights Pro v7’s input"), "the previous system’s input");
    assert.equal(plainInternalNames("V7 recorded zero"), "the previous system recorded zero");
  });

  it("leaves identifiers, codes and text without the name exactly as they are", () => {
    for (const same of ["nzi-pro-v7", "v7-import", "policy:v7-reingest", "v7.reingest.job", "v7Record", "V7_REINGEST_ACTOR", "row v7RowId", "Imported", "It was seven"]) assert.equal(plainInternalNames(same), same, same);
  });

  it("walks prose at any depth - lineage, provenance - but leaves keys, numbers and a lone code value alone", () => {
    const stored = { source: "v7", capturedAs: "v7-import", v7RowId: "r1", lineage: [{ title: "Re-ingested from NZ Insights Pro v7", detail: "v7 reported 12 t", at: 5 }], note: null };
    assert.deepEqual(plainInternalNamesDeep(stored), {
      source: "v7", capturedAs: "v7-import", v7RowId: "r1", lineage: [{ title: "Re-ingested from the previous system", detail: "the previous system reported 12 t", at: 5 }], note: null,
    });
    assert.equal(stored.lineage[0]!.title, "Re-ingested from NZ Insights Pro v7", "the input is not mutated");
  });
});
