// Portal bulk import, Company Vehicles (BRIEF-portal-data-entry-parity #3, kind 3): the portal reads and resolves a filled template with the
// CRM's own vehicle reader and resolver, files each ready vehicle as the one pending row the create command takes, and sends the plate only
// as the sealed asset identifier — never in a label, note or anywhere else.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { PORTAL_IMPORT_TEMPLATES, PORTAL_STAFF_ONLY_FIELDS, type FactorOption } from "@nzi/contracts";
import { parseVehicleTemplate, resolveVehicleTemplateRow, vehicleRowBlocking, vehicleTemplateHeaders } from "../app/jobs/vehicleTemplate";
import { portalVehicleRow, portalVehicleTemplateCsv, portalVehicleTemplateName, previewPortalVehicles, vehicleFactorOptions } from "../app/portal/data/portalVehicleImport";

const here = dirname(fileURLToPath(import.meta.url));
const source = (path: string) => readFileSync(resolve(here, "..", path), "utf8");
const MONTHS = ["2025-01", "2025-02", "2025-03"];
const SMALL_DIESEL = "Passenger vehicles - Cars (by size) - Small car - Diesel";
const factor = (id: string, label: string, unit: string, over: Partial<FactorOption> = {}) => ({
  datasetId: "ds-1", datasetName: "DESNZ", datasetVersion: "2025", factorId: id, label, activityUnit: unit, scopes: ["1"], factorSource: "dataset", ...over,
}) as unknown as FactorOption;
const FACTORS = [
  factor("car-mi", SMALL_DIESEL, "miles"), factor("car-km", SMALL_DIESEL, "km"),
  factor("van-km", "Delivery vehicles - Vans - Class II (1.305 to 1.74 tonnes) - Petrol", "km"),
  factor("gas", "Natural gas", "kWh", { scopes: ["3"] }), factor("client-f", "Client's own", "km", { factorSource: "client" as never }),
];
const SITES = [{ id: "site-hq", name: "Head office" }];
const FILE = [
  vehicleTemplateHeaders(MONTHS).join(","),
  "AB12 CDE,Van 1,Car,Small car,Diesel,9000,miles,Head office,,,",
  ",Fleet 2,Car,Small car,Diesel,,km,,100,200,300",
  "ZZ99 ZZZ,,,,,5000,miles,,,,",
  ",Fleet 4,Hoverboard,Small,Diesel,100,km,,,,",
  ",Fleet 5,Car,Small car,Diesel,,km,,,,",
].join("\n");

describe("portal vehicle import: the CRM resolver's output, not a fork", () => {
  const options = vehicleFactorOptions(FACTORS);
  const preview = previewPortalVehicles(FILE, MONTHS, options, SITES, false);

  it("offers only the job's Scope 1 dataset factors, and issues the CRM's headers-only template named by category and period", () => {
    assert.deepEqual(options.map((option) => option.id), ["car-mi", "car-km", "van-km"]);
    assert.equal(portalVehicleTemplateCsv(MONTHS).trim().split(/\r?\n/).length, 1);
    assert.equal(portalVehicleTemplateCsv(MONTHS).replace(/"/g, "").trim(), vehicleTemplateHeaders(MONTHS).join(","));
    assert.equal(portalVehicleTemplateName(MONTHS), "Company Vehicles template 2025-01 to 2025-03.csv");
  });

  it("resolves every row to what the CRM's resolver says for the same file and factors", () => {
    const crm = parseVehicleTemplate(FILE, MONTHS).rows.map((row) => resolveVehicleTemplateRow(row, options, SITES, false));
    assert.equal(preview.lines.length, crm.length);
    preview.lines.forEach((line, index) => {
      const expected = crm[index]!;
      assert.deepEqual([line.resolved.option?.id ?? null, line.resolved.quantity, line.resolved.siteId, line.resolved.monthly.length],
        [expected.option?.id ?? null, expected.quantity, expected.siteId, expected.monthly.length], `row ${index + 1}`);
    });
  });

  it("marks ready what the CRM would import, and says why for the rest — a registration alone is not read from a file", () => {
    assert.deepEqual(preview.lines.map((line) => line.ready), [true, true, false, false, false]);
    assert.match(preview.lines[2]!.issues.join(" "), /Add entry drawer/);
    assert.match(preview.lines[3]!.issues.join(" "), /not a car, van/);
    assert.match(preview.lines[4]!.issues.join(" "), /annual mileage/);
    assert.equal(previewPortalVehicles("Trip,Cost\nRail,3", MONTHS, options, SITES, false).missing.length > 0, true);
  });

  it("files a vehicle by its name, with the plate only as the sealed identifier, and the months as the whole period or the annual figure", () => {
    const [annual, monthly] = preview.lines.slice(0, 2).map((line) => portalVehicleRow(line, false));
    assert.deepEqual([annual!.scope, annual!.categoryCode, annual!.sourceLabel, annual!.assetIdentifier, annual!.quantity, annual!.unit, annual!.factorId, annual!.siteId, annual!.monthlyActivity],
      ["1", "1.company-vehicles", "Van 1", "AB12 CDE", 9000, "miles", "car-mi", "site-hq", []]);
    assert.deepEqual([monthly!.quantity, monthly!.unit, monthly!.factorId, monthly!.assetIdentifier], [null, "km", "car-km", null]);
    assert.deepEqual(monthly!.monthlyActivity, MONTHS.map((month, index) => ({ month, quantity: (index + 1) * 100 })), "every reporting month, in order");
    for (const row of [annual!, monthly!]) {
      for (const field of PORTAL_STAFF_ONLY_FIELDS) assert.equal(field in row, false, field);
    }
    assert.doesNotMatch(JSON.stringify({ ...annual, assetIdentifier: undefined }), /AB12/, "the plate is nowhere but the sealed identifier");
  });

  it("names an unnamed vehicle by size and fuel, never by its plate", () => {
    const unnamed = previewPortalVehicles(csvOf(",,Car,Small car,Diesel,500,miles,,,,"), MONTHS, options, SITES, false).lines[0]!;
    assert.equal(unnamed.ready, false, "a vehicle needs a name or a registration to be told apart");
    const withPlate = previewPortalVehicles(csvOf("QQ11 QQQ,,Car,Small car,Diesel,500,miles,,,,"), MONTHS, options, SITES, false).lines[0]!;
    const row = portalVehicleRow(withPlate, false);
    assert.equal(row.sourceLabel, "Company vehicle · Small car · Diesel");
    assert.doesNotMatch(row.sourceLabel, /QQ11/);
  });

  it("for a client that holds no registrations, the name is the identifier and a plate is never sent", () => {
    const optedOut = previewPortalVehicles(csvOf("AB12 CDE,Van 1,Car,Small car,Diesel,9000,miles,,,,"), MONTHS, options, SITES, true).lines[0]!;
    const row = portalVehicleRow(optedOut, true);
    assert.equal(row.assetIdentifier, "Van 1");
    assert.doesNotMatch(JSON.stringify(row), /AB12/);
  });

  it("is an allowed template of the import command", () => {
    assert.ok((PORTAL_IMPORT_TEMPLATES as readonly string[]).includes("vehicles"));
    assert.equal(vehicleRowBlocking({ option: null, needsLookup: false, siteId: null, quantity: 1, monthly: [], issues: ["The months add up to 3, not the annual 4: the months are used.", "x"] }).length, 1);
  });
});

const csvOf = (...lines: string[]) => [vehicleTemplateHeaders(MONTHS).join(","), ...lines].join("\n");

describe("portal vehicle import: wired behind the gates", () => {
  it("is offered on 1.company-vehicles only, behind the vehicle flag, uploading only inside an open window outside the staff preview", () => {
    const view = source("app/portal/jobs/[jobId]/data/PortalDataView.tsx");
    assert.match(view, /category\.code === "1\.company-vehicles" && dataEntryAdapterEnabled\("vehicle"\)/);
    assert.match(view, /<PortalVehicleImport[\s\S]*canImport=\{open && !surface\.readOnly\}/);
  });
  it("confirms through the portal import command only, never the staff routes, and never sends a plate in a label", () => {
    const component = source("app/portal/PortalVehicleImport.tsx");
    assert.match(component, /\$\{base\}\/scope-rows\/import/);
    assert.match(component, /template: "vehicles"/);
    assert.doesNotMatch(component, /\/api\/isolated\//);
    assert.doesNotMatch(source("app/portal/data/portalVehicleImport.ts"), /sourceLabel: [^\n]*registration/);
  });
});
