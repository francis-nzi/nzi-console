// DVLA lookup fix (27 Oct): "Use this" on a vehicle lookup puts the suggested factor's label — type · size · fuel — in
// Activity, the factor-matching field, and keeps make and fuel as the vehicle's detail. Before, Activity took
// "MERCEDES-BENZ · DIESEL", which names no factor, so the save gate refused it and a person re-picked every time.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { emissionCategoryTaxonomy, type EmissionCategory } from "@nzi/contracts";
import {
  emissionEntryDraftToPortalRecord,
  emissionEntryDraftToScopeRow,
  quickAddSaveIssue,
  vehicleLookupPatch,
  type EmissionEntryDraft,
  type EntryFactorOption,
  type PortalBucketRef,
  type RegistrationLookupOutcome,
} from "../app/jobs/emissionEntryModel";

const here = dirname(fileURLToPath(import.meta.url));
const source = (path: string) => readFileSync(resolve(here, "..", path), "utf8");

const draft = (over: Partial<EmissionEntryDraft> = {}): EmissionEntryDraft => ({
  activity: "", quantity: "", unit: "mi", vatPercent: "", glCode: "", spendCategoryId: "",
  registration: "AB12 CDE", manualMode: false, manualDetail: "", factorId: "", qualityTier: "Measured",
  dataConfidence: "M — Medium", supplySource: "", factorOverrideReason: "", note: "", monthlyOpen: false, monthly: {}, ...over,
});
const vehicles: EmissionCategory = emissionCategoryTaxonomy.find(entry => entry.name === "Company Vehicles")!;

const MEDIUM_DIESEL = "Passenger vehicles - Cars (by size) - Medium car - Diesel";
const factors: EntryFactorOption[] = [
  { id: "dataset:ds|uk-ghg-4_301_3045_9_1", label: "Passenger vehicles - Cars (by size) - Small car - Diesel", unit: "miles" },
  { id: "dataset:ds|uk-ghg-4_301_3053_9_1", label: MEDIUM_DIESEL, unit: "miles" },
];
const found = (over: Partial<Extract<RegistrationLookupOutcome, { ok: true }>> = {}): Extract<RegistrationLookupOutcome, { ok: true }> => ({
  ok: true, make: "MERCEDES-BENZ", fuelType: "DIESEL", suggestedClass: "car", year: 2021,
  factorId: "dataset:ds|uk-ghg-4_301_3053_9_1", factorLabel: MEDIUM_DIESEL, classification: "Medium car · Diesel",
  sizeBasis: "Size read from its 1,995 cc engine",
  attributes: { source: "stub", fuel: "diesel", vehicleClass: "car", category: "car|medium|diesel", fallbackCategory: "car|average|diesel" },
  ...over,
});

describe("R1 — Activity takes the resolved factor's label, not make + fuel", () => {
  it("sets Activity to the factor label (type · size · fuel), with that factor and its unit", () => {
    const patch = vehicleLookupPatch(draft(), found(), factors, null);
    assert.equal(patch.activity, MEDIUM_DIESEL);
    assert.equal(patch.factorId, "dataset:ds|uk-ghg-4_301_3053_9_1");
    assert.equal(patch.unit, "miles");
    assert.ok(!/MERCEDES/i.test(patch.activity!), "the make is not the factor-matching key");
  });

  it("keeps make and fuel as the vehicle's detail, and carries the lookup's attributes — never the plate", () => {
    const patch = vehicleLookupPatch(draft(), found(), factors, null);
    assert.equal(patch.manualDetail, "MERCEDES-BENZ · DIESEL");
    assert.equal(patch.assertedVehicleAttributes?.category, "car|medium|diesel");
    assert.equal(patch.manualMode, false);
    assert.ok(!("registration" in patch), "the lookup leaves the plate where it was");
    assert.ok(!JSON.stringify(patch).includes("AB12"), "no plate in anything the lookup writes");
  });

  it("the applied entry passes the save gate — no hand re-pick (the defect: make + fuel was refused as an activity)", () => {
    const options = factors.map(option => ({ id: option.id, label: option.label }));
    const applied = { ...draft(), ...vehicleLookupPatch(draft(), found(), factors, null) };
    assert.equal(quickAddSaveIssue(applied, options, vehicles, "crm"), null);
    // What main wrote, for contrast: the same factor with make + fuel as its activity is refused.
    const before = { ...applied, activity: "MERCEDES-BENZ · DIESEL" };
    assert.match(quickAddSaveIssue(before, options, vehicles, "crm") ?? "", /isn't one of Company Vehicles's activities/);
  });

  it("the scope row's label is the factor label, and the plate still lands only in the asset identifier (NZC-103, unchanged)", () => {
    const applied = { ...draft({ quantity: "1200" }), ...vehicleLookupPatch(draft(), found(), factors, null) };
    const row = emissionEntryDraftToScopeRow(applied, vehicles, { id: null, label: null },
      factors.map(option => ({ ...option, datasetId: "ds", factorVersion: "2025" })) as never, []);
    assert.equal(row.sourceLabel, MEDIUM_DIESEL);
    assert.equal(row.assetIdentifier, "AB12 CDE");
  });

  it("choosing the declared factor clears an override reason; any other keeps it", () => {
    const declared = { optionId: "dataset:ds|uk-ghg-4_301_3053_9_1" };
    assert.equal(vehicleLookupPatch(draft({ factorOverrideReason: "x" }), found(), factors, declared).factorOverrideReason, "");
    assert.equal(vehicleLookupPatch(draft({ factorOverrideReason: "x" }), found(), factors, { optionId: "other" }).factorOverrideReason, "x");
  });
});

describe("R2/R3 — no suggestion leaves Activity for the picker", () => {
  it("no factor resolved: Activity and the factor are untouched, and no make is written into Activity", () => {
    const patch = vehicleLookupPatch(draft({ activity: "", factorId: "" }), found({ factorId: null, factorLabel: null }), factors, null);
    assert.ok(!("activity" in patch) && !("factorId" in patch) && !("unit" in patch));
    assert.equal(patch.manualDetail, "MERCEDES-BENZ · DIESEL");
  });

  it("a suggestion that is not one of this entry's factors is not applied either (it could not be saved)", () => {
    const patch = vehicleLookupPatch(draft(), found({ factorId: "dataset:other|nope" }), factors, null);
    assert.ok(!("activity" in patch) && !("factorId" in patch));
  });

  it("the portal: its lookup carries no factor (the bucket decides), so Activity stays the client's and the record keeps the vehicle", () => {
    const bucket: PortalBucketRef = { bucketGrantId: "g1", entryKind: "vehicle", factors: [{ id: "f-medium-diesel", label: MEDIUM_DIESEL, unit: "miles" }],
      units: ["miles"], sites: [], pgsCategories: [] };
    const portal = found({ factorId: undefined, factorLabel: undefined });
    const applied = { ...draft({ quantity: "800" }), ...vehicleLookupPatch(draft(), portal, bucket.factors, null) };
    assert.equal(applied.activity, "");
    const record = emissionEntryDraftToPortalRecord(applied, bucket, { id: null });
    assert.ok(!("error" in record));
    assert.equal(!("error" in record) && record.factorId, "f-medium-diesel", "the bucket's factor, as before");
    assert.match(!("error" in record) ? record.note : "", /MERCEDES-BENZ · DIESEL/, "make and fuel still reach the reviewer");
    assert.deepEqual(!("error" in record) && record.detail, { vehicleAttributes: portal.attributes });
  });
});

describe("the wiring", () => {
  it("the form applies the shared patch and no longer joins make and fuel into Activity", () => {
    const form = source("app/jobs/EmissionEntryForm.tsx");
    assert.match(form, /patch\(vehicleLookupPatch\(draft, result, basisFactors, declared\)\)/);
    assert.ok(!/activity:\s*\[result\.make/.test(form), "make + fuel is not written into Activity");
  });

  it("the banner shows the band and what it was read from, and the CRM is told how to override it", () => {
    const form = source("app/jobs/EmissionEntryForm.tsx");
    assert.match(form, /lookup\.result\.sizeBasis/);
    assert.match(form, /Pick another size from the activities below/);
  });

  it("both routes return the size basis; the portal route still sends no factor (R3)", () => {
    const crm = source("app/api/isolated/jobs/[jobId]/vehicle-lookup/route.ts");
    const portal = source("app/api/portal/jobs/[jobId]/vehicle-lookup/route.ts");
    assert.match(crm, /classification, sizeBasis, factor, attributes/);
    assert.match(portal, /classification, sizeBasis, matched: factor !== null, attributes/);
    assert.ok(!/\bfactor,/.test(portal.slice(portal.indexOf("Response.json(\n"))), "the portal response carries no factor");
    assert.match(source("app/portal/PortalCategoryEntry.tsx"), /sizeBasis: body\.sizeBasis \?\? null/);
    assert.match(source("app/jobs/CrpScopeWorkspace.tsx"), /sizeBasis: body\.sizeBasis \?\? null/);
  });
});
