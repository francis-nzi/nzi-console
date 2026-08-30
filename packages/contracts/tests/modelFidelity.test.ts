import assert from "node:assert/strict";
import { it } from "node:test";
import type {
  ScopeRowReadModel,
  ClientFactor,
  ClientSite,
  EmissionSource,
  EmissionSourceGroup,
  MonthlyActivitySlot,
} from "../src/index";

// Proves the canonical model can REPRESENT real-world intricacies losslessly.
// Type-level proof: `tsc --noEmit` must accept these fixtures as the contract types.
// Runtime proof: each fixture must survive a JSON round-trip and satisfy its invariants.

const roundTrip = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const months = (values: Array<number | null>): MonthlyActivitySlot[] =>
  values.map((quantity, index) => ({ month: `2026-${String(index + 1).padStart(2, "0")}`, quantity }));

const baseRow = (overrides: Partial<ScopeRowReadModel>): ScopeRowReadModel => ({
  id: "row", jobId: "J000712", scope: "3.1", sourceLabel: "Source", reportLabel: "Source",
  notes: null, categoryPath: ["Scope 3", "Purchased goods & services"], monthlyActivity: [],
  quantity: 0, unit: "kg", datasetId: null, factorId: null, factorVersion: null, factorLabel: null,
  qualityTier: "estimated", calculatedTco2e: 0, overrideTco2e: null, overrideReason: null,
  reviewStatus: "approved", reviewedRowVersion: 1, reviewedBy: "reviewer", reviewedAt: "2026-08-29",
  reviewerNote: null, version: 1, enabled: true, provenance: {}, lineage: [],
  ...overrides,
});

it("A. custom client factor (with EPD evidence) used on a Scope 3 row", () => {
  const factor: ClientFactor = {
    id: "cf-epd-001", organisationId: "org-nzi", clientId: "client-acme", jobId: null,
    scope: "3.1", categoryPath: ["Scope 3", "Purchased goods & services"],
    reportLabel: "Widget X (supplier EPD)", description: "Supplier-published EPD factor for Widget X",
    unit: "unit", ghgUnit: "kgCO2e", kgco2ePerUnit: 12.4, geography: "GB", vintageYear: 2025, version: 1,
    source: "Acme Ltd EPD 2025",
    evidence: { fileName: "widget-x-epd-2025.pdf", storageProvider: "sharepoint", url: "https://sp/doc/123", externalItemId: "123", hash: "sha256:abcd1234" },
    archived: false, createdBy: "consultant", createdAt: "2026-08-29", updatedBy: null, updatedAt: null,
  };
  const row = baseRow({
    id: "row-pgs-widget", sourceLabel: "Widget X", reportLabel: "Widget X (supplier EPD)",
    quantity: 500, unit: "unit", factorSource: "client", clientFactorId: factor.id, isCustomEntry: true,
    factorLabel: factor.reportLabel, qualityTier: "measured",
    calculatedTco2e: (500 * factor.kgco2ePerUnit) / 1000,
    provenance: { factorSource: "client", clientFactorId: factor.id, evidenceHash: factor.evidence!.hash },
    lineage: [{ title: "Client factor", detail: "Acme EPD 2025 (12.4 kgCO2e/unit)" }],
  });
  assert.deepEqual(roundTrip(factor), factor);
  assert.deepEqual(roundTrip(row), row);
  assert.equal(row.factorSource, "client");
  assert.equal(row.clientFactorId, factor.id);
  assert.equal(row.isCustomEntry, true);
  assert.equal((row.provenance as Record<string, unknown>).evidenceHash, factor.evidence!.hash);
});

it("B. one source apportioned across two sites, with a mid-year site closure", () => {
  const closedSite: ClientSite = {
    id: "site-depot", organisationId: "org-nzi", clientId: "client-acme", name: "Depot",
    addressLines: ["7 Dock Rd"], postcode: "AB3 4EF", latitude: 53.4, longitude: -2.2,
    geocodeSource: "os", geocodePrecision: "rooftop", activeFrom: "2020-01-01",
    vacatedDate: "2026-07-01", archived: false, createdBy: "consultant", createdAt: "2026-01-01",
  };
  const hqRow = baseRow({
    id: "row-elec-hq", scope: "2", sourceLabel: "Grid electricity", reportLabel: "Electricity",
    categoryPath: ["Scope 2", "Purchased energy"], unit: "kWh", quantity: 60000, applyPct: 60,
    siteId: "site-hq", siteLabel: "HQ", sourceQuantity: 100000, sourceUnit: "kWh",
    monthlyActivity: months([5000, 5000, 5000, 5000, 5000, 5000, 5000, 5000, 5000, 5000, 5000, 5000]),
  });
  const depotRow = baseRow({
    id: "row-elec-depot", scope: "2", sourceLabel: "Grid electricity", reportLabel: "Electricity",
    categoryPath: ["Scope 2", "Purchased energy"], unit: "kWh", quantity: 40000, applyPct: 40,
    siteId: closedSite.id, siteLabel: "Depot", sourceQuantity: 100000, sourceUnit: "kWh",
    monthlyActivity: months([6000, 6000, 6000, 6000, 6000, 6000, null, null, null, null, null, null]),
  });
  assert.deepEqual(roundTrip(closedSite), closedSite);
  assert.deepEqual(roundTrip(depotRow), depotRow);
  assert.equal((hqRow.applyPct ?? 0) + (depotRow.applyPct ?? 0), 100);
  assert.equal(closedSite.vacatedDate, "2026-07-01");
  assert.ok(depotRow.monthlyActivity.slice(6).every((slot) => slot.quantity === null));
});

it("C. per-employee commuting rolling up into an auto-generated scope row", () => {
  const group: EmissionSourceGroup = {
    id: "grp-commute", jobId: "J000712", name: "Employee commuting",
    datasetId: "ds-defra-2025", factorId: "f-car-petrol", factorLabel: "Car (petrol)", unit: "km",
  };
  const source: EmissionSource = {
    id: "src-emp-42", jobId: "J000712", groupId: group.id, scope: "3", sourceType: "commuting",
    sourceSubtype: "car", siteId: "site-hq", sourceName: "J. Smith", assetIdentifier: "AB12 CDE", purchasedGoodsCategoryId: null,
    datasetId: group.datasetId, factorId: group.factorId, factorSource: "dataset", clientFactorId: null,
    quantity: 3000, unit: "km", applyPct: 100, dataSource: "Employee survey", dataConfidence: "M",
    monthlyActivity: months([250, 250, 250, 250, 250, 250, 250, 250, 250, 250, 250, 250]),
    detail: { kind: "commuting", vehicleRegistration: "AB12 CDE", commuteMode: "car - petrol", distanceUnit: "km", wfhDaysPerYear: 104, wfhHoursPerDay: 7.5, employeeName: "J. Smith" },
    notes: null, calculatedTco2e: 0.51, enabled: true, submittedByPortal: true, reviewStatus: "approved", version: 1,
    scopeRowId: "row-commute-auto", scopeRowVersion: 1, scopeRowReviewStatus: "approved",
  };
  const annual = source.monthlyActivity.reduce((sum, slot) => sum + (slot.quantity ?? 0), 0);
  const autoRow = baseRow({
    id: "row-commute-auto", scope: "3", sourceLabel: "Employee commuting", reportLabel: "Employee commuting",
    categoryPath: ["Scope 3", "Employee commuting"], unit: "km", quantity: annual,
    isAutoGenerated: true, autoPairKind: "commuting", sourceId: source.id, linkedRowId: null,
    monthlyActivity: source.monthlyActivity, calculatedTco2e: source.calculatedTco2e,
  });
  assert.deepEqual(roundTrip(source), source);
  assert.deepEqual(roundTrip(autoRow), autoRow);
  assert.equal(source.detail.kind, "commuting");
  assert.equal(autoRow.isAutoGenerated, true);
  assert.equal(autoRow.sourceId, source.id);
  assert.equal(autoRow.quantity, 3000);
  assert.equal(autoRow.quantity, annual);
});
