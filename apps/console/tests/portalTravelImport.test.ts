// Portal bulk import, Business Travel (BRIEF-portal-data-entry-parity #3, kind 1): the portal reads and resolves a filled template with
// the CRM's own adapter — the same trips resolve to the same factor, quantity, site and date — and files each ready trip as the one
// pending row the create command takes. Nothing staff-only is sent, and no plate or name travels in a row.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { PORTAL_STAFF_ONLY_FIELDS, type FactorOption } from "@nzi/contracts";
import { parseTravelTemplate, resolveTravelTemplateRow, TRAVEL_TEMPLATE_COLUMNS } from "../app/jobs/travelTemplate";
import { portalTravelRow, portalTravelTemplateName, previewPortalTravel, travelFactorOptions } from "../app/portal/data/portalTravelImport";

const here = dirname(fileURLToPath(import.meta.url));
const source = (path: string) => readFileSync(resolve(here, "..", path), "utf8");
const factor = (id: string, label: string, unit: string, over: Partial<FactorOption> = {}) => ({
  datasetId: "ds-1", datasetName: "DESNZ", datasetVersion: "2025", factorId: id, label, activityUnit: unit, scopes: ["3"], factorSource: "dataset", ...over,
}) as unknown as FactorOption;
const FACTORS = [
  factor("sh-eco", "Business travel- air - Flights - Short-haul, to/from UK - Economy class - With RF", "passenger.km"),
  factor("rail", "Business travel- land - Rail - National rail", "passenger.km"),
  factor("hotel-uk", "Hotel stay - United Kingdom", "nights"),
  factor("s1-gas", "Natural gas", "kWh", { scopes: ["1"] }),
  factor("client-f", "Client's own", "km", { factorSource: "client" as never }),
];
const SITES = [{ id: "site-hq", name: "Head office" }];
const csv = (...lines: string[]) => [TRAVEL_TEMPLATE_COLUMNS.join(","), ...lines].join("\n");
const FILE = csv(
  "Rail,Leeds,London,300,km,,,2,2025-03-02,Head office,,,",
  "Air,LHR,EDI,500,km,,,1,2025-04-01,,Short haul,Economy,",
  "Hotel,,,,,3,,,2025-04-02,,,,",
  "Grey fleet,,,50,miles,,,,,,,,AB12CDE",
  "Rail,Leeds,London,-4,km,,,,,Nowhere,,,",
);

describe("portal travel import: the CRM adapter's output, not a fork", () => {
  const options = travelFactorOptions(FACTORS);
  const preview = previewPortalTravel(FILE, options, SITES);

  it("offers only the job's Scope 3 dataset factors", () => {
    assert.deepEqual(options.map((option) => option.id), ["sh-eco", "rail", "hotel-uk"]);
  });

  it("resolves every row to what the CRM's resolver says for the same file and factors", () => {
    const crm = parseTravelTemplate(FILE).rows.map((row) => resolveTravelTemplateRow(row, options, SITES));
    assert.equal(preview.lines.length, crm.length);
    preview.lines.forEach((line, index) => {
      const expected = crm[index]!;
      assert.deepEqual([line.resolved.option?.id ?? null, line.resolved.quantity, line.resolved.siteId, line.resolved.tripDate, line.resolved.mode],
        [expected.option?.id ?? null, expected.quantity, expected.siteId, expected.tripDate, expected.mode], `row ${index + 1}`);
    });
  });

  it("marks ready exactly the rows the CRM would import, and says why for the rest — a registration is not read from a file", () => {
    assert.deepEqual(preview.lines.map((line) => line.ready), [true, true, true, false, false]);
    assert.match(preview.lines[3]!.issues.join(" "), /Add entry drawer/);
    assert.match(preview.lines[4]!.issues.join(" "), /cannot be negative|not one of this job's sites/);
  });

  it("refuses a file that is not the travel template, by column", () => {
    assert.deepEqual(previewPortalTravel("Trip,Distance\nRail,300", options, SITES).missing, ["Mode", "Nights", "Spend"]);
  });

  it("files each ready trip as the create command's own row: category 3.6, the resolved factor and quantity, no staff-only field", () => {
    const [rail, air, hotel] = preview.lines.slice(0, 3).map(portalTravelRow);
    assert.deepEqual([rail!.scope, rail!.categoryCode, rail!.factorId, rail!.datasetId, rail!.unit, rail!.quantity, rail!.siteId], ["3.6", "3.6", "rail", "ds-1", "passenger.km", 600, "site-hq"]);
    assert.equal(rail!.sourceLabel, "Leeds → London");
    assert.equal(air!.factorId, "sh-eco");
    assert.deepEqual([hotel!.factorId, hotel!.quantity, hotel!.unit], ["hotel-uk", 3, "nights"]);
    for (const row of [rail!, air!, hotel!]) {
      for (const field of PORTAL_STAFF_ONLY_FIELDS) assert.equal(field in row, false, field);
      assert.doesNotMatch(JSON.stringify(row), /AB12CDE/);
      assert.match(row.notes ?? "", /Business travel template import/);
    }
  });

  it("names the template by category and reporting period", () => {
    assert.equal(portalTravelTemplateName(["2025-01", "2025-02", "2025-12"]), "Business Travel template 2025-01 to 2025-12.csv");
    assert.equal(portalTravelTemplateName([]), "Business Travel template.csv");
  });
});

describe("portal travel import: wired behind the gates", () => {
  it("is offered on 3.6 only, behind the travel flag, and uploads only inside an open window outside the staff preview", () => {
    const view = source("app/portal/jobs/[jobId]/data/PortalDataView.tsx");
    assert.match(view, /category\.code === "3\.6" && dataEntryAdapterEnabled\("travel"\)/);
    assert.match(view, /canImport=\{open && !surface\.readOnly\}/);
    assert.match(view, /categoryImport=\{categoryImport\}/);
  });
  it("confirms through the portal import command only — never the staff routes", () => {
    const component = source("app/portal/PortalTravelImport.tsx");
    assert.match(component, /\$\{base\}\/scope-rows\/import/);
    assert.doesNotMatch(component, /\/api\/isolated\//);
    assert.match(source("app/api/portal/jobs/[jobId]/scope-rows/import/route.ts"), /requirePortalData\(\);\s+requirePortalOrigin\(request\);\s+const user = await currentPortalUserForData\(request\)/);
  });
});
