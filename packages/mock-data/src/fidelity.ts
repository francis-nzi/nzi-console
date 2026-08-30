// Worst-case fixtures proving the canonical model represents real-world
// intricacies (custom client factors, site-specific data, per-entity roll-ups).
// Typed against @nzi/contracts; see docs/MODEL_FIDELITY_DATA_ENTRY.md.
// Illustrative demonstrator data only — no real client data, no PII.
import type {
  ClientFactor,
  ClientSite,
  EmissionSource,
  EmissionSourceGroup,
  MonthlyActivitySlot,
  ScopeRowReadModel,
} from "@nzi/contracts";

const months = (values: Array<number | null>): MonthlyActivitySlot[] =>
  values.map((quantity, index) => ({ month: `2026-${String(index + 1).padStart(2, "0")}`, quantity }));

const baseRow = (overrides: Partial<ScopeRowReadModel>): ScopeRowReadModel => ({
  id: "row", jobId: "712", scope: "3.1", sourceLabel: "Source", reportLabel: "Source",
  notes: null, categoryPath: ["Scope 3", "Purchased goods & services"], monthlyActivity: [],
  quantity: 0, unit: "kg", datasetId: null, factorId: null, factorVersion: null, factorLabel: null,
  qualityTier: "estimated", calculatedTco2e: 0, overrideTco2e: null, overrideReason: null,
  reviewStatus: "approved", reviewedRowVersion: 1, reviewedBy: "A. Shaw", reviewedAt: "2026-08-29",
  reviewerNote: null, version: 1, enabled: true, provenance: {}, lineage: [],
  ...overrides,
});

// A. Custom client factor (with EPD evidence) used on a Scope 3 row.
export const clientFactorWidgetEpd: ClientFactor = {
  id: "cf-epd-001", organisationId: "demo-nzi-console", clientId: "bushy-tails", jobId: null,
  scope: "3.1", categoryPath: ["Scope 3", "Purchased goods & services"],
  reportLabel: "Chew toy (supplier EPD)", description: "Supplier EPD factor for the flagship chew toy",
  unit: "unit", ghgUnit: "kgCO2e", kgco2ePerUnit: 12.4, geography: "GB", vintageYear: 2025, version: 1,
  source: "Bushy Tails supplier EPD 2025",
  evidence: { fileName: "chew-toy-epd-2025.pdf", storageProvider: "sharepoint", url: "https://sp/doc/123", externalItemId: "123", hash: "sha256:abcd1234" },
  archived: false, createdBy: "A. Shaw", createdAt: "2026-08-29", updatedBy: null, updatedAt: null,
};
export const scopeRowWithClientFactor: ScopeRowReadModel = baseRow({
  id: "row-pgs-chewtoy", sourceLabel: "Chew toy", reportLabel: "Chew toy (supplier EPD)",
  quantity: 500, unit: "unit", factorSource: "client", clientFactorId: clientFactorWidgetEpd.id, isCustomEntry: true,
  factorLabel: clientFactorWidgetEpd.reportLabel, qualityTier: "measured",
  calculatedTco2e: (500 * clientFactorWidgetEpd.kgco2ePerUnit) / 1000,
  provenance: { factorSource: "client", clientFactorId: clientFactorWidgetEpd.id, evidenceHash: clientFactorWidgetEpd.evidence!.hash },
  lineage: [{ title: "Client factor", detail: "Supplier EPD 2025 (12.4 kgCO2e/unit)" }],
});

// B. One electricity supply apportioned across two sites, one vacated mid-year.
export const siteHeadOffice: ClientSite = {
  id: "site-hq", organisationId: "demo-nzi-console", clientId: "bushy-tails", name: "Head office",
  addressLines: ["1 Kennel Way"], postcode: "AB1 2CD", latitude: 51.5, longitude: -0.1,
  geocodeSource: "os", geocodePrecision: "rooftop", activeFrom: "2020-01-01", vacatedDate: null,
  archived: false, createdBy: "A. Shaw", createdAt: "2026-01-01",
};
export const siteDepotVacated: ClientSite = {
  id: "site-depot", organisationId: "demo-nzi-console", clientId: "bushy-tails", name: "Depot",
  addressLines: ["7 Dock Rd"], postcode: "AB3 4EF", latitude: 53.4, longitude: -2.2,
  geocodeSource: "os", geocodePrecision: "rooftop", activeFrom: "2020-01-01", vacatedDate: "2026-07-01",
  archived: false, createdBy: "A. Shaw", createdAt: "2026-01-01",
};
export const apportionedElectricityRows: ScopeRowReadModel[] = [
  baseRow({ id: "row-elec-hq", scope: "2", sourceLabel: "Grid electricity", reportLabel: "Electricity",
    categoryPath: ["Scope 2", "Purchased energy"], unit: "kWh", quantity: 60000, applyPct: 60,
    siteId: siteHeadOffice.id, siteLabel: "Head office", sourceQuantity: 100000, sourceUnit: "kWh",
    monthlyActivity: months([5000,5000,5000,5000,5000,5000,5000,5000,5000,5000,5000,5000]) }),
  baseRow({ id: "row-elec-depot", scope: "2", sourceLabel: "Grid electricity", reportLabel: "Electricity",
    categoryPath: ["Scope 2", "Purchased energy"], unit: "kWh", quantity: 40000, applyPct: 40,
    siteId: siteDepotVacated.id, siteLabel: "Depot", sourceQuantity: 100000, sourceUnit: "kWh",
    monthlyActivity: months([6000,6000,6000,6000,6000,6000,null,null,null,null,null,null]) }),
];

// C. Per-employee commuting rolling up into an auto-generated scope row.
export const commutingGroup: EmissionSourceGroup = {
  id: "grp-commute", jobId: "712", name: "Employee commuting",
  datasetId: "defra-2024", factorId: "f-car-petrol", factorLabel: "Car (petrol)", unit: "km",
};
export const commutingSource: EmissionSource = {
  id: "src-emp-42", jobId: "712", groupId: commutingGroup.id, scope: "3", sourceType: "commuting",
  sourceSubtype: "car", siteId: "site-hq", sourceName: "J. Smith", assetIdentifier: "AB12 CDE",
  datasetId: commutingGroup.datasetId, factorId: commutingGroup.factorId, factorSource: "dataset", clientFactorId: null,
  quantity: 3000, unit: "km", applyPct: 100, dataSource: "Employee survey", dataConfidence: "M",
  monthlyActivity: months([250,250,250,250,250,250,250,250,250,250,250,250]),
  detail: { kind: "commuting", vehicleRegistration: "AB12 CDE", commuteMode: "car - petrol", distanceUnit: "km", wfhDaysPerYear: 104, wfhHoursPerDay: 7.5, employeeName: "J. Smith" },
  notes: null, calculatedTco2e: 0.51, enabled: true, submittedByPortal: true, reviewStatus: "approved", version: 1,
};
export const commutingAutoRow: ScopeRowReadModel = baseRow({
  id: "row-commute-auto", scope: "3", sourceLabel: "Employee commuting", reportLabel: "Employee commuting",
  categoryPath: ["Scope 3", "Employee commuting"], unit: "km",
  quantity: commutingSource.monthlyActivity.reduce((sum: number, slot: MonthlyActivitySlot) => sum + (slot.quantity ?? 0), 0),
  isAutoGenerated: true, autoPairKind: "commuting", sourceId: commutingSource.id, linkedRowId: null,
  monthlyActivity: commutingSource.monthlyActivity, calculatedTco2e: commutingSource.calculatedTco2e,
});
