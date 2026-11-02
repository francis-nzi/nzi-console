// Portal bulk import, Employee Commuting (BRIEF-portal-data-entry-parity #3, kind 2): the portal reads a filled template with the CRM's own
// commuting reader and mode matcher, never sends the employee column, and files each ready commuter as the one pending row the create
// command takes — by number and mode, with the factor chosen per line.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { PORTAL_IMPORT_TEMPLATES, PORTAL_STAFF_ONLY_FIELDS, type FactorOption } from "@nzi/contracts";
import { matchCommuteMode, parseCommutingLedger } from "../app/jobs/commutingBulk";
import { entryFactorRefsFor } from "../app/jobs/emissionEntryModel";
import { commutingLineReady, PORTAL_COMMUTING_COLUMNS, portalCommutingRow, portalCommutingTemplateCsv, portalCommutingTemplateName, previewPortalCommuting } from "../app/portal/data/portalCommutingImport";
import { importErrorText } from "../app/portal/data/portalImportErrors";

const here = dirname(fileURLToPath(import.meta.url));
const source = (path: string) => readFileSync(resolve(here, "..", path), "utf8");
const factor = (id: string, label: string, unit: string) => ({
  datasetId: "ds-1", datasetName: "DESNZ", datasetVersion: "2025", datasetLabel: "DESNZ GB 2025", factorId: id, label, activityUnit: unit, scopes: ["3"], factorSource: "dataset", clientFactorId: null,
}) as unknown as FactorOption;
const FACTORS = [factor("car-p", "Cars (by size) - Average car - Petrol", "km"), factor("rail", "National rail", "passenger.km")];
const REFS = entryFactorRefsFor(FACTORS as never);
const FILE = [
  PORTAL_COMMUTING_COLUMNS.join(","),
  "Alex Example,Car — petrol,7500,km,52,7.5",
  "Sam Example,train,3200,miles,104,7.5",
  "Kim Example,Hoverboard,100,km,,",
  "Lee Example,Rail,,km,,",
  "Max Example,Rail,500,km,400,30",
].join("\n");

describe("portal commuting import: the CRM reader's output, not a fork", () => {
  const { lines, looksLikeTemplate } = previewPortalCommuting(FILE);

  it("is the CRM's columns, headers only, named by category and reporting period", () => {
    assert.equal(portalCommutingTemplateCsv().trim().split(/\r?\n/).length, 1);
    assert.equal(PORTAL_COMMUTING_COLUMNS.length, 6);
    assert.equal(portalCommutingTemplateName(["2025-01", "2025-12"]), "Employee Commuting template 2025-01 to 2025-12.csv");
    assert.equal(looksLikeTemplate, true);
    assert.equal(previewPortalCommuting("Trip,Cost\nRail,3").looksLikeTemplate, false);
  });

  it("reads and matches every line exactly as the CRM's parser and mode matcher do", () => {
    const crm = parseCommutingLedger(FILE);
    assert.equal(lines.length, crm.length);
    lines.forEach((line, index) => {
      assert.deepEqual([line.mode, line.distance, line.distanceUnit, line.wfhDaysPerYear, line.wfhHoursPerDay],
        [matchCommuteMode(crm[index]!.mode) ?? crm[index]!.mode, crm[index]!.distance, crm[index]!.distanceUnit, crm[index]!.wfhDaysPerYear, crm[index]!.wfhHoursPerDay], `row ${index + 1}`);
    });
    // The template's own headers: "WFH hours per day" holds "day", and once overwrote the WFH-days column.
    assert.deepEqual([lines[0]!.wfhDaysPerYear, lines[0]!.wfhHoursPerDay], [52, 7.5]);
    assert.equal(lines[1]!.mode, "Rail", "free text is matched to the controlled list");
    assert.equal(lines[1]!.distanceUnit, "mi");
  });

  it("says what stops a line, by the CRM grid's own rule, and needs a factor", () => {
    assert.deepEqual(lines.map((line) => line.issues.length === 0), [true, true, false, false, false]);
    assert.match(lines[2]!.issues.join(" "), /not one of the commute modes/);
    assert.match(lines[3]!.issues.join(" "), /distance/);
    assert.match(lines[4]!.issues.join(" "), /WFH days[\s\S]*WFH hours|WFH hours[\s\S]*WFH days/);
    assert.equal(commutingLineReady(lines[0]!, null), false, "no factor, not ready");
    assert.equal(commutingLineReady(lines[0]!, REFS[0]!), true);
  });

  it("files a commuter by number and mode — no name — as the create command's own row, with no staff-only field", () => {
    const row = portalCommutingRow(lines[0]!, 5, REFS[0]!, FACTORS);
    assert.deepEqual([row.scope, row.categoryCode, row.sourceLabel, row.quantity, row.unit, row.factorId, row.datasetId, row.factorLabel, row.siteId],
      ["3.7", "3.7", "Commuter 5 · Car — petrol", 7500, "km", "car-p", "ds-1", "Cars (by size) - Average car - Petrol", null]);
    assert.match(row.notes ?? "", /52 days a year, 7\.5 hours a day/);
    assert.equal(portalCommutingRow(lines[1]!, 6, REFS[1]!, FACTORS).unit, "mi");
    for (const field of PORTAL_STAFF_ONLY_FIELDS) assert.equal(field in row, false, field);
    assert.doesNotMatch(JSON.stringify(row), /Alex|Example/);
  });

  it("is an allowed template of the import command", () => {
    assert.ok((PORTAL_IMPORT_TEMPLATES as readonly string[]).includes("commuting"));
  });
});

describe("a refused import names the row", () => {
  const refused = { state: "validation_failed", message: "Refused.", correlationId: "c", issues: [{ field: "rows[1].unit", code: "UNIT_INCOMPATIBLE", message: "The factor is priced per passenger.km." }] } as never;
  it("maps the command's row index to the file's row number", () => {
    assert.equal(importErrorText(refused, [3, 7, 9]), "Row 7: The factor is priced per passenger.km. Nothing was saved.");
  });
  it("passes any other failure through", () => {
    assert.equal(importErrorText({ state: "validation_failed", message: "Refused.", correlationId: "c", issues: [{ field: "rows", code: "TOO_MANY", message: "Too many." }] } as never, [1]), "Too many.");
    assert.equal(importErrorText({ state: "denied", message: "Nope.", permission: "x", correlationId: "c" } as never, [1]), "Nope.");
  });
});

describe("portal commuting import: wired behind the gates", () => {
  it("is offered on 3.7 only, behind the commuting flag, uploading only inside an open window outside the staff preview", () => {
    const view = source("app/portal/jobs/[jobId]/data/PortalDataView.tsx");
    assert.match(view, /category\.code === "3\.7" && dataEntryAdapterEnabled\("commuting"\)/);
    assert.match(view, /<PortalCommutingImport[\s\S]*canImport=\{open && !surface\.readOnly\}/);
  });
  it("confirms through the portal import command only, and never sends the employee column", () => {
    const component = source("app/portal/PortalCommutingImport.tsx");
    assert.match(component, /\$\{base\}\/scope-rows\/import/);
    assert.match(component, /template: "commuting"/);
    assert.doesNotMatch(component, /\/api\/isolated\//);
    assert.doesNotMatch(source("app/portal/data/portalCommutingImport.ts"), /\.employee\b/);
  });
});
