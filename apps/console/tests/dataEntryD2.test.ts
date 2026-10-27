// Data entry D2 (27 Oct): the allocation map in the console — a spend line in the drawer is filed where the client's map routes it
// (shown, with "allocate elsewhere" always open), VAT follows the map or the category, a reviewer can move a spend line (which
// teaches the map), the import preview says where every line will land, and Admin keeps each client's map. The write is proved in
// dataEntryD2Real.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { emissionCategoryTaxonomy, type EmissionCategory } from "@nzi/contracts";
import { emissionEntryDraftToScopeRow, type EmissionEntryDraft, type EntryFactorRef } from "../app/jobs/emissionEntryModel";
import { ADMIN_ITEMS } from "../app/admin/adminNav";

const here = dirname(fileURLToPath(import.meta.url));
const source = (path: string) => readFileSync(resolve(here, "..", path), "utf8");
const cat = (code: string): EmissionCategory => emissionCategoryTaxonomy.find(entry => entry.code === code)!;
const draft = (over: Partial<EmissionEntryDraft> = {}): EmissionEntryDraft => ({
  activity: "Pension admin", quantity: "4,800", unit: "", vatPercent: "", glCode: "7420", spendCategoryId: "pgs-x", registration: "", manualMode: false,
  manualDetail: "", factorId: "dataset:d|pensions-gbp", qualityTier: "Spend-based", dataConfidence: "M — Medium", supplySource: "", factorOverrideReason: "",
  note: "", monthlyOpen: false, monthly: {}, basis: "spend", currency: "GBP", ...over,
});
const refs: EntryFactorRef[] = [
  { id: "dataset:d|pensions-gbp", factorId: "pensions-gbp", label: "Financial services · GBP", unit: "GBP", datasetId: "d", datasetVersion: "v1", factorSource: "dataset", scope: "3" },
  { id: "dataset:d|fuel-gbp", factorId: "fuel-gbp", label: "Vehicle fuel · GBP", unit: "GBP", datasetId: "d", datasetVersion: "v1", factorSource: "dataset", scope: "1" },
];

describe("R2 — the drawer files a spend line where it is allocated", () => {
  it("a PG&S drawer's line allocated to Investments is filed there — scope, category — and carries no PG&S sub-category", () => {
    const row = emissionEntryDraftToScopeRow(draft({ allocateTo: "3.15" }), cat("3.1"), { id: null, label: null }, refs, []);
    assert.deepEqual([row.scope, row.categoryCode, row.purchasedGoodsCategoryId, row.columnText, row.unit, row.entryBasis], ["3.15", "3.15", null, "7420", "GBP", "spend"]);
  });
  it("across scopes: a PG&S drawer's fuel line allocated to Company Vehicles is a Scope 1 row, priced by a Scope 1 spend factor", () => {
    const row = emissionEntryDraftToScopeRow(draft({ allocateTo: "1.company-vehicles", factorId: "dataset:d|fuel-gbp", activity: "Fuel card" }), cat("3.1"), { id: null, label: null }, refs, []);
    assert.deepEqual([row.scope, row.categoryCode, row.factorId], ["1", "1.company-vehicles", "fuel-gbp"]);
  });
  it("no allocation is the drawer's own category (PG&S keeps its sub-category); an activity entry is never allocated", () => {
    const own = emissionEntryDraftToScopeRow(draft(), cat("3.1"), { id: null, label: null }, refs, []);
    assert.deepEqual([own.scope, own.categoryCode, own.purchasedGoodsCategoryId], ["3.1", "3.1", "pgs-x"]);
    const activity = emissionEntryDraftToScopeRow(draft({ basis: "activity", allocateTo: "3.15", unit: "km" }), cat("3.6"), { id: null, label: null }, refs, []);
    assert.equal(activity.categoryCode, "3.6");
  });
});

describe("the wiring", () => {
  const form = source("app/jobs/EmissionEntryForm.tsx");
  it("the drawer routes by the client's map (from the job's settings), applies it visibly, and keeps 'allocate elsewhere' open", () => {
    assert.match(form, /routeSpendLine\(props\.entryBasis\.allocations, \{ glCode: draft\.glCode, description: draft\.activity \}\)/);
    assert.match(form, /mapRouting && mapRouting\.by !== "residual"/, "an unmapped line stays in the drawer's category — the person chose it");
    assert.match(form, /aria-label="Filed under"/);
    assert.match(form, /allocationTouched\.current = true/, "a person's choice is never overwritten by the map");
    assert.match(source("../../packages/isolated-backend/src/entryBasis.ts"), /activeSpendAllocationsForJob\(db, organisationId, jobId\)/);
  });
  it("R6: VAT follows the map entry, else the category; where it does not apply the field is disabled and cleared", () => {
    assert.match(form, /const vatApplies = mapped && mapped\.categoryCode === filedCode \? mapped\.vatApplies : vatAppliesByDefault\(filedCode\)/);
    assert.match(form, /disabled=\{!vatApplies\}/);
    assert.match(form, /if \(spend && !vatApplies && draft\.vatPercent\) setDraft/);
  });
  it("R4: a spend row's drawer offers 'Move to another category', through the gated command, and says the map learns", () => {
    const control = source("app/jobs/ReallocateControl.tsx");
    assert.match(control, /if \(!isCurrencyUnit\(row\.unit\)\) return null;/);
    assert.match(control, /\/scope-rows\/\$\{row\.id\}\/reallocate/);
    assert.match(control, /This client's map now routes/);
    assert.match(source("app/jobs/CrpScopeWorkspace.tsx"), /<ReallocateControl jobId=\{jobId\} row=\{row\}/);
    assert.match(source("app/api/isolated/jobs/[jobId]/scope-rows/[rowId]/reallocate/route.ts"), /requireCommandPrincipal\(request, "scope\.row\.reallocate"\)/);
  });
  it("R2: the import preview says where every line will be filed, and why", () => {
    const panel = source("app/jobs/SpendImportPanel.tsx");
    assert.match(panel, /<th>Filed under<\/th>/);
    assert.match(panel, /PG&S residual/);
  });
  it("Admin: Spend allocation, per client, admin.lookups; every route runs its gated command", () => {
    const item = ADMIN_ITEMS.find(entry => entry.id === "spend-allocation")!;
    assert.deepEqual([item.capability, item.href], ["admin.lookups", "/admin/spend-allocation"]);
    for (const [path, key] of [["app/api/isolated/spend-allocations/route.ts", "spend_allocation.create"], ["app/api/isolated/spend-allocations/[allocationId]/route.ts", "spend_allocation.update"],
      ["app/api/isolated/spend-allocations/[allocationId]/archive/route.ts", "spend_allocation.archive"], ["app/api/isolated/spend-allocations/[allocationId]/reinstate/route.ts", "spend_allocation.reinstate"]]) {
      assert.ok(source(path!).includes(`requireCommandPrincipal(request, "${key}")`), path);
    }
  });
});
