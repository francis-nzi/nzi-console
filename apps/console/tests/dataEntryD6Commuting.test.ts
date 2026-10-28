// Data entry D6 (R1, R2a) in the console: the commuting bulk grid still reads an Employee column — so a paste lines up — but never
// sends it: each source is "Commuter n · mode", with no identifier and no name or registration in its detail. The register's
// commuting form asks for neither. That the write drops them whatever is sent, and the one-off clear, are proved in isolated-backend's
// dataEntryD6CommutingTravelPiiReal.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { parseCommutingLedger } from "../app/jobs/commutingBulk";

const here = dirname(fileURLToPath(import.meta.url));
const source = (path: string) => readFileSync(resolve(here, "..", path), "utf8");

describe("Data entry D6: commuting capture keeps no name and no registration", () => {
  it("R2a: the grid parses an Employee column, and the import sends the commuter by number and mode — never the name", () => {
    assert.equal(parseCommutingLedger("Employee\tMode\tDistance\nA. Example\tRail\t3200")[0]!.employee, "A. Example", "the paste still lines up");
    const panel = source("app/jobs/CommutingBulkPanel.tsx");
    assert.match(panel, /sourceName: label, assetIdentifier: null,/);
    assert.match(panel, /const label = commuterLabel\(next, row\.mode\);/);
    assert.match(panel, /detail: \{ kind: "commuting", commuteMode: row\.mode, distanceUnit: row\.distanceUnit, wfhDaysPerYear: row\.wfhDaysPerYear, wfhHoursPerDay: row\.wfhHoursPerDay \},/);
    assert.doesNotMatch(panel, /employeeName|vehicleRegistration/);
    // Read only to show and label the grid's own row — the import never touches it.
    assert.doesNotMatch(panel.slice(panel.indexOf("async function importRows"), panel.indexOf("async function undo")), /row\.employee/);
  });
  it("R1, R2a: the register's commuting form has no name, identifier or registration field, and sends none", () => {
    const register = source("app/jobs/EmissionSourceRegister.tsx");
    assert.doesNotMatch(register, /employeeName|Employee name|Employee ID/);
    assert.match(register, /\{kind:"commuting",commuteMode:d\.commuteMode,distanceUnit:d\.distanceUnit,wfhDaysPerYear:num\(d\.wfhDaysPerYear\),wfhHoursPerDay:num\(d\.wfhHoursPerDay\)\}/);
    assert.match(register, /assetIdentifier:value\.sourceType==="commuting"\?null:value\.assetIdentifier\|\|null,/);
    assert.match(register, /\{value\.sourceType==="commuting"\?null:<label className="nz-fl">/, "no identifier field for a commuter");
    const commutingForm = register.slice(register.indexOf('{value.sourceType==="commuting"?<>'), register.indexOf('{value.sourceType==="vehicle"?<>'));
    assert.doesNotMatch(commutingForm, /Vehicle registration/);
  });
});
