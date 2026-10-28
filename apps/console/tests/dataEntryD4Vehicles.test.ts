// Data entry D4 (R1–R4) in the console: the registration never enters a free-text field — not the portal record's note (D0's
// finding), not an entry's label, not a bulk vehicle's name — and only a company vehicle sends one at all (business travel and
// commuting use it for the lookup alone). The drawer names the vehicle for an opted-out client, offers the type → size → fuel
// fallback and the miles / km / litres choice; the client's page holds the opt-out. The seal is proved in dataEntryD4VehicleRegReal.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { emissionCategoryTaxonomy, type EmissionCategory } from "@nzi/contracts";
import {
  emissionEntryDraftToPortalRecord, emissionEntryDraftToScopeRow, vehicleLookupPatch, type EmissionEntryDraft, type EntryFactorRef, type PortalBucketRef,
} from "../app/jobs/emissionEntryModel";

const here = dirname(fileURLToPath(import.meta.url));
const source = (path: string) => readFileSync(resolve(here, "..", path), "utf8");
const cat = (code: string): EmissionCategory => emissionCategoryTaxonomy.find(entry => entry.code === code)!;
const PLATE = "AB12 CDE";
const draft = (over: Partial<EmissionEntryDraft> = {}): EmissionEntryDraft => ({
  activity: "", quantity: "8000", unit: "miles", vatPercent: "", glCode: "", spendCategoryId: "", registration: PLATE, manualMode: false, manualDetail: "",
  factorId: "dataset:d|car-mi", qualityTier: "Measured", dataConfidence: "M — Medium", supplySource: "", factorOverrideReason: "", note: "Pool car", monthlyOpen: false,
  monthly: {}, ...over,
});
const refs: EntryFactorRef[] = [
  { id: "dataset:d|car-km", factorId: "car-km", label: "Passenger vehicles - Cars (by size) - Small car - Diesel", unit: "km", datasetId: "d", datasetVersion: "v1", factorSource: "dataset", scope: "1" },
  { id: "dataset:d|car-mi", factorId: "car-mi", label: "Passenger vehicles - Cars (by size) - Small car - Diesel", unit: "miles", datasetId: "d", datasetVersion: "v1", factorSource: "dataset", scope: "1" },
];

describe("R2 — the registration never lands in free text", () => {
  it("the portal record's note carries the activity, the detail and the note — never the plate", () => {
    const bucket: PortalBucketRef = { bucketGrantId: "b", entryKind: "vehicle", factors: [{ id: "f", label: "Car", unit: "miles" }], units: ["miles"], sites: [], pgsCategories: [] };
    const record = emissionEntryDraftToPortalRecord(draft({ factorId: "f", activity: "Small car · Diesel", manualDetail: "Ford Fiesta" }), bucket, { id: null });
    assert.ok(!("error" in record));
    if ("error" in record) return;
    assert.equal(record.note, "Small car · Diesel · Ford Fiesta · Pool car");
    assert.ok(!JSON.stringify(record).includes("AB12"), "nowhere in the record");
  });
  it("an entry with no activity is labelled by its detail or category, never by its plate", () => {
    const row = emissionEntryDraftToScopeRow(draft({ activity: "" }), cat("1.company-vehicles"), { id: null, label: null }, refs, []);
    assert.equal(row.sourceLabel, "Company Vehicles");
    assert.ok(![row.sourceLabel, row.reportLabel, row.notes].some(value => String(value ?? "").includes("AB12")));
    assert.equal(row.assetIdentifier, PLATE, "the plate goes only to the identifier, which the write seals");
  });
  it("a bulk vehicle with no make or model is named by its fuel, never its plate", () => {
    assert.match(source("app/jobs/VehicleBulkPanel.tsx"), /\["Company vehicle", row\.fuel\]/);
    assert.doesNotMatch(source("app/jobs/VehicleBulkPanel.tsx"), /\|\| row\.registration,/);
  });
});

describe("R1 — only a company vehicle holds a plate", () => {
  it("business travel and commuting send none — the lookup used it, transiently", () => {
    for (const code of ["3.6", "3.7"]) {
      assert.equal(emissionEntryDraftToScopeRow(draft(), cat(code), { id: null, label: null }, refs, []).assetIdentifier, null, code);
    }
  });
});

describe("R3 — a looked-up vehicle opens on miles", () => {
  it("the lookup's km match becomes its miles sibling", () => {
    const patch = vehicleLookupPatch({ unit: "", manualDetail: "", factorOverrideReason: "" }, { ok: true, factorId: "dataset:d|car-km" } as never, refs, null);
    assert.deepEqual([patch.factorId, patch.unit], ["dataset:d|car-mi", "miles"]);
  });
});

describe("the wiring", () => {
  const form = source("app/jobs/EmissionEntryForm.tsx");
  it("an opted-out client's drawer names the vehicle and looks nothing up", () => {
    assert.match(form, /props\.entryBasis\?\.vehicleRegistrationsOptOut === true/);
    assert.match(form, /Vehicle name or fleet number/);
  });
  it("the manual fallback is type → size → fuel; the vehicle is measured in miles, km or litres", () => {
    assert.match(form, /aria-label="Vehicle type, size and fuel"/);
    assert.match(form, /vehicleUnitOptions\(basisFactors, chosenVehicle\)/);
    assert.match(form, /Measured in/);
  });
  it("the client's page holds the opt-out, through the gated command", () => {
    assert.match(source("app/clients/[clientId]/OverviewArea.tsx"), /<VehicleRegistrationsCard clientId=\{client\.id\}/);
    assert.match(source("app/api/isolated/clients/[clientId]/vehicle-registrations/route.ts"), /requireCommandPrincipal\(request, "client\.vehicle_registrations\.set"\)/);
    assert.match(source("app/clients/[clientId]/VehicleRegistrationsCard.tsx"), /destroyed now, and cannot be recovered/);
  });
});
