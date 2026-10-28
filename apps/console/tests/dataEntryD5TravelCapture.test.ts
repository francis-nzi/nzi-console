// Data entry D5 (R2–R5) in the console: Business Travel captured by a controlled mode — in the 3.6 drawer and the source register —
// air by haul and cabin class, grey fleet through the vehicle lookup with no plate kept, and the shared commuting list read, not
// re-declared. The pure mode model is proved in contracts' dataEntryD5Travel; the write in isolated-backend's D5 real-DB test.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { COMMUTE_MODES as SHARED } from "@nzi/contracts";
import { COMMUTE_MODES } from "../app/jobs/commutingBulk";
import { emissionEntryDraftToScopeRow } from "../app/jobs/emissionEntryModel";
import { rowSourceDetail } from "../app/jobs/rowSourceDetail";

const here = dirname(fileURLToPath(import.meta.url));
const source = (path: string) => readFileSync(resolve(here, "..", path), "utf8");

describe("D5 R2: one controlled mode list", () => {
  it("commuting's bulk grid and the register read the shared list — no second copy", () => {
    assert.equal(COMMUTE_MODES, SHARED);
    const register = source("app/jobs/EmissionSourceRegister.tsx");
    assert.doesNotMatch(register, /const (commuteModes|travelModes)=\[/, "the register re-declares a mode list");
    assert.match(register, /TRAVEL_MODES\.map\(mode=><option key=\{mode\.value\} value=\{mode\.value\}>/);
  });
});

describe("D5 R2/R3/R5: the 3.6 drawer starts from the mode", () => {
  const form = source("app/jobs/EmissionEntryForm.tsx");
  it("offers the controlled modes, not a free-text travel type, for staff", () => {
    assert.match(form, /const travelEntry = category\.kind === "travel" && audience === "crm" && !spend;/);
    assert.match(form, /TRAVEL_MODES\.map\(mode => <option key=\{mode\.value\} value=\{mode\.value\}>\{mode\.label\}<\/option>\)/);
    assert.match(form, /draft\.manualMode && !vehiclePicker && !travelEntry \?/, "the free-text travel type is still offered to staff");
  });
  it("narrows the activities to the mode's, and prices a flight by its haul and class", () => {
    assert.match(form, /const searchResults = searchActivityOptions\(modeFactors, draft\.activity\);/);
    assert.match(form, /airFactorFor\(basisFactors, haul, cabinClass\)/);
  });
  it("shows the registration only for grey fleet, and picks it as a vehicle is — type · size · fuel", () => {
    assert.match(form, /const showRegistration = !travelEntry \|\| greyFleet;/);
    assert.match(form, /const vehiclePicker = companyVehicle \|\| greyFleet;/);
  });
  it("R5 (pinned): a grey-fleet entry writes no plate — the registration is the lookup's alone", () => {
    const row = emissionEntryDraftToScopeRow(
      { activity: "Business travel- land - Cars (by size) - Small car - Diesel · miles", quantity: "240", unit: "miles", vatPercent: "", glCode: "", spendCategoryId: "", registration: "AB12 CDE",
        manualMode: false, manualDetail: "", factorId: "dataset:ds|car", qualityTier: "Measured", dataConfidence: "M — Medium", supplySource: "", factorOverrideReason: "", note: "", monthlyOpen: false, monthly: {}, basis: "activity" },
      { scope: "3", code: "3.6", name: "Business Travel", kind: "travel" }, { id: null, label: null },
      [{ id: "dataset:ds|car", factorId: "car", label: "Business travel- land - Cars (by size) - Small car - Diesel · miles", unit: "miles", datasetId: "ds", factorSource: "dataset" }], []);
    assert.equal(row.assetIdentifier, null);
    assert.ok(!JSON.stringify(row).includes("AB12"), "the plate reached the row");
  });
});

describe("D5: a trip's detail reads by its controlled mode", () => {
  const row = (detail: Record<string, unknown>) => ({ categoryCode: "3.6", scope: "3.6", assetIdentifier: null, provenance: { detail: { kind: "travel", ...detail } } }) as never;
  it("a flight with its haul and class; a hotel with its nights; a trip from before the list as it was saved", () => {
    const mode = (detail: Record<string, unknown>) => rowSourceDetail(row(detail)).fields.find((field) => field.label === "Mode")?.value;
    assert.equal(mode({ travelMode: "air", airHaul: "long-haul", cabinClass: "business" }), "Air · Long haul · Business");
    assert.equal(rowSourceDetail(row({ travelMode: "hotel", nights: 3 })).fields.find((field) => field.label === "Nights")?.value, "3");
    assert.equal(mode({ travelMode: "Flight — long haul" }), "Flight — long haul");
  });
});
