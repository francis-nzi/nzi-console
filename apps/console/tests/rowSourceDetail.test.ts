import assert from "node:assert/strict";
import { it } from "node:test";
import type { ScopeRowReadModel } from "@nzi/contracts";
import { rowSourceDetail } from "../app/jobs/rowSourceDetail";

const row = (overrides: Partial<ScopeRowReadModel> = {}): ScopeRowReadModel => ({
  id: "row-a", jobId: "job-a", scope: "1", sourceLabel: "Gas", reportLabel: "Gas", notes: null,
  categoryPath: ["Scope 1", "Direct emissions"], monthlyActivity: [], quantity: 10, unit: "kWh",
  datasetId: "d", factorId: "f", factorVersion: "v1", factorLabel: "Gas factor", qualityTier: "measured",
  calculatedTco2e: 1, overrideTco2e: null, overrideReason: null, reviewStatus: "approved",
  reviewedRowVersion: 1, reviewedBy: "r", reviewedAt: "2026-08-29", reviewerNote: null, version: 2,
  enabled: true, provenance: {}, lineage: [], ...overrides,
});

it("adapts to a vehicle row — reads the frozen vehicle record from provenance.detail", () => {
  const detail = rowSourceDetail(row({
    scope: "1", categoryCode: "1.company-vehicles", assetIdentifier: "KU69 AAA",
    provenance: { detail: { kind: "vehicle", vehicleRegistration: "KU69 AAA", make: "Volkswagen", model: "Transporter", fuel: "Diesel" } },
  }));
  assert.equal(detail.title, "Vehicle detail");
  assert.equal(detail.kind, "vehicle");
  assert.deepEqual(detail.fields.map((f) => f.label), ["Registration", "Make", "Model", "Fuel"]);
  assert.equal(detail.fields.find((f) => f.label === "Make")?.value, "Volkswagen");
});

it("adapts to a spend / PG&S row — net / VAT / GL / category / reference, PG&S label wins over the frozen category", () => {
  const detail = rowSourceDetail(row({
    scope: "3.1", assetIdentifier: "14/03/2025", purchasedGoodsCategoryLabel: "CEDA sector average",
    provenance: { spendDetail: { kind: "spend", netValue: 4100000, vatPercent: 20, glCode: "7504", category: "old label" } },
  }));
  assert.equal(detail.title, "Spend detail (PG&S)");
  assert.equal(detail.kind, "spend");
  assert.equal(detail.fields.find((f) => f.label === "PG&S category")?.value, "CEDA sector average");
  assert.equal(detail.fields.find((f) => f.label === "Net value")?.value, "4100000");
  assert.equal(detail.fields.find((f) => f.label === "Invoice date / reference")?.value, "14/03/2025");
});

it("falls back to a generic source detail and drops empty fields", () => {
  const bare = rowSourceDetail(row({ scope: "2", assetIdentifier: null, columnText: null }));
  assert.equal(bare.kind, "generic");
  assert.deepEqual(bare.fields, []);
  const withRef = rowSourceDetail(row({ scope: "2", assetIdentifier: "Meter 4", columnText: "Electricity" }));
  assert.deepEqual(withRef.fields.map((f) => `${f.label}=${f.value}`), ["ID / reference=Meter 4", "Report column heading=Electricity"]);
});

it("adapts to a business-travel row — mode / leg / carrier / passengers (data-entry UX review item 5)", () => {
  const detail = rowSourceDetail(row({
    scope: "3.6", categoryCode: "3.6", assetIdentifier: "A. Traveller",
    provenance: { detail: { kind: "travel", travelMode: "Flight — long haul", origin: "London Heathrow", destination: "New York JFK", carrier: "BA", passengers: 1 } },
  }));
  assert.equal(detail.title, "Travel detail");
  assert.equal(detail.kind, "travel");
  assert.equal(detail.fields.find((f) => f.label === "Leg")?.value, "London Heathrow → New York JFK");
  assert.equal(detail.fields.find((f) => f.label === "Mode")?.value, "Flight — long haul");
  assert.equal(detail.fields.find((f) => f.label === "Traveller / ref")?.value, "A. Traveller");
});

it("a scope 3.1 row with no frozen detail still shows the PG&S section (category + reference)", () => {
  const detail = rowSourceDetail(row({ scope: "3.1", purchasedGoodsCategoryLabel: "Freight", assetIdentifier: "INV-9" }));
  assert.equal(detail.kind, "spend");
  assert.deepEqual(detail.fields.map((f) => f.label), ["PG&S category", "Invoice date / reference"]);
});
