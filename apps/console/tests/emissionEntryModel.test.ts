import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { emissionCategoryTaxonomy, type EmissionCategory } from "@nzi/contracts";
import type { ScopeRowReadModel } from "@nzi/contracts";
import {
  buildEmissionEntryFields,
  categoryRowScope,
  emissionEntryActions,
  emissionEntryDraftToScopeRow,
  isRegistrationKind,
  isSpendKind,
  manualEntryHint,
  parseEntryNumber,
  scopeRowToEmissionEntryDraft,
  type EmissionEntryDraft,
} from "../app/jobs/emissionEntryModel";

const draft = (over: Partial<EmissionEntryDraft> = {}): EmissionEntryDraft => ({
  activity: "", quantity: "", unit: "", vatPercent: "", glCode: "", spendCategoryId: "",
  registration: "", manualMode: false, manualDetail: "", factorId: "", qualityTier: "Measured",
  dataConfidence: "M — Medium", note: "", monthlyOpen: false, monthly: {}, ...over,
});

const cat = (name: string): EmissionCategory => {
  const found = emissionCategoryTaxonomy.find(entry => entry.name === name);
  if (!found) throw new Error(`no taxonomy category ${name}`);
  return found;
};
const keys = (category: EmissionCategory, audience: "crm" | "portal", mode: "new" | "existing" = "new") =>
  buildEmissionEntryFields(category, audience, mode).map(field => field.key);

describe("buildEmissionEntryFields — one canonical order (NZC-046 §3)", () => {
  it("keeps site → activity → quantity → unit → monthly → note → documents for a plain manual category, both surfaces", () => {
    const gas = cat("Natural Gas");
    assert.deepEqual(keys(gas, "portal"), ["siteBanner", "activity", "quantity", "unit", "monthly", "note", "documents"]);
    assert.deepEqual(keys(gas, "crm"), [
      "siteBanner", "activity", "quantity", "unit", "monthly", "factor", "qualityTier", "dataConfidence", "note", "documents",
    ]);
  });

  it("quantity always comes immediately before unit, and monthly immediately after unit", () => {
    for (const category of emissionCategoryTaxonomy) {
      for (const audience of ["crm", "portal"] as const) {
        const order = keys(category, audience);
        assert.equal(order.indexOf("unit") - order.indexOf("quantity"), 1, `${category.name}/${audience}`);
        assert.equal(order.indexOf("monthly") - order.indexOf("unit"), 1, `${category.name}/${audience}`);
      }
    }
  });
});

describe("progressive disclosure — kind-specific fields only where they belong (§4)", () => {
  it("shows the spend details group only for Purchased Goods and Services et al., never elsewhere", () => {
    assert.ok(keys(cat("Purchased Goods and Services"), "crm").includes("spendDetails"));
    assert.ok(keys(cat("Investments"), "portal").includes("spendDetails"));
    assert.ok(!keys(cat("Natural Gas"), "crm").includes("spendDetails"));
    assert.ok(!keys(cat("Business Travel"), "crm").includes("spendDetails"));
  });

  it("shows the registration finder only for Company Vehicles, Business Travel and Employee Commuting", () => {
    const withFinder = emissionCategoryTaxonomy.filter(category => keys(category, "crm").includes("registrationFinder"));
    assert.deepEqual(withFinder.map(category => category.name).sort(), ["Business Travel", "Company Vehicles", "Employee Commuting"]);
  });

  it("relabels quantity/unit as net value / VAT % for spend categories only", () => {
    const spendFields = buildEmissionEntryFields(cat("Capital Goods"), "portal", "new");
    assert.equal(spendFields.find(field => field.key === "quantity")?.label, "Net value (£)");
    assert.equal(spendFields.find(field => field.key === "unit")?.label, "VAT %");
    const manualFields = buildEmissionEntryFields(cat("Waste in Operations"), "portal", "new");
    assert.equal(manualFields.find(field => field.key === "quantity")?.label, "Quantity");
    assert.equal(manualFields.find(field => field.key === "unit")?.label, "Unit");
  });

  it("registration manual hint tracks the kind", () => {
    assert.equal(manualEntryHint(cat("Company Vehicles")), "make · model · fuel");
    assert.equal(manualEntryHint(cat("Business Travel")), "air · rail · hotel");
    assert.equal(manualEntryHint(cat("Employee Commuting")), "mode · WFH days");
  });
});

describe("audience gating — the portal is a constrained mirror (§3)", () => {
  it("never exposes factor, quality tier, data confidence or lineage to the portal", () => {
    for (const category of emissionCategoryTaxonomy) {
      const portalKeys = keys(category, "portal", "existing");
      for (const hidden of ["factor", "qualityTier", "dataConfidence", "lineage"]) {
        assert.ok(!portalKeys.includes(hidden as never), `${category.name}: portal must not show ${hidden}`);
      }
    }
  });

  it("adds calculation lineage only for an existing CRM row", () => {
    assert.ok(!keys(cat("Natural Gas"), "crm", "new").includes("lineage"));
    assert.ok(keys(cat("Natural Gas"), "crm", "existing").includes("lineage"));
    assert.ok(!keys(cat("Natural Gas"), "portal", "existing").includes("lineage"));
  });

  it("labels the note 'Evidence note' on the portal and 'Notes' on the CRP", () => {
    const portal = buildEmissionEntryFields(cat("Natural Gas"), "portal", "new");
    const crm = buildEmissionEntryFields(cat("Natural Gas"), "crm", "new");
    assert.equal(portal.find(field => field.key === "note")?.label, "Evidence note");
    assert.equal(crm.find(field => field.key === "note")?.label, "Notes");
  });
});

describe("emissionEntryActions", () => {
  it("portal always offers Save draft + Submit for review", () => {
    assert.deepEqual(emissionEntryActions("portal", "new").map(action => action.key), ["saveDraft", "submit"]);
    assert.deepEqual(emissionEntryActions("portal", "existing").map(action => action.key), ["saveDraft", "submit"]);
  });

  it("CRP offers Save draft + Save entry for a new row, Reject + Approve for an existing one", () => {
    assert.deepEqual(emissionEntryActions("crm", "new").map(action => action.key), ["saveDraft", "save"]);
    assert.deepEqual(emissionEntryActions("crm", "existing").map(action => action.key), ["reject", "approve"]);
  });

  it("exactly one primary action per set", () => {
    for (const audience of ["crm", "portal"] as const) {
      for (const mode of ["new", "existing"] as const) {
        assert.equal(emissionEntryActions(audience, mode).filter(action => action.variant === "primary").length, 1);
      }
    }
  });
});

describe("kind predicates", () => {
  it("isSpendKind / isRegistrationKind agree with the taxonomy", () => {
    assert.ok(isSpendKind(cat("Purchased Goods and Services")));
    assert.ok(!isSpendKind(cat("Refrigerants")));
    assert.ok(isRegistrationKind(cat("Company Vehicles")));
    assert.ok(!isRegistrationKind(cat("Refrigerants")));
  });
});

describe("UX1c — draft ↔ scope row mapping", () => {
  const factors = [
    { id: "f-diesel", label: "Diesel — LGV", datasetId: "d-2024", datasetVersion: "2024 v1.2", factorSource: "dataset" as const },
    { id: "cf-epd", label: "Acme EPD 2025", datasetVersion: "v3", factorSource: "client" as const, clientFactorId: "cf-epd" },
  ];
  const months = ["2026-01", "2026-02", "2026-03"];

  it("parseEntryNumber strips separators and rejects negatives / blanks", () => {
    assert.equal(parseEntryNumber("1,240.50"), 1240.5);
    assert.equal(parseEntryNumber("  "), null);
    assert.equal(parseEntryNumber("-3"), null);
    assert.equal(parseEntryNumber("abc"), null);
  });

  it("categoryRowScope keeps Scope 3 granular and Scope 1/2 bare", () => {
    assert.equal(categoryRowScope(cat("Purchased Goods and Services")), "3.1");
    assert.equal(categoryRowScope(cat("Company Vehicles")), "1");
  });

  it("stamps category_code + site-as-context and resolves a dataset factor", () => {
    const row = emissionEntryDraftToScopeRow(
      draft({ activity: "AB12 CDE Ford Transit", registration: "AB12 CDE", quantity: "6,200", unit: "litres", factorId: "f-diesel", qualityTier: "Measured", dataConfidence: "H — High", note: "fuel card export" }),
      cat("Company Vehicles"),
      { id: "site-mcr", label: "Manchester operations" },
      factors,
      months,
    );
    assert.equal(row.scope, "1");
    assert.equal(row.categoryCode, "1.company-vehicles");
    assert.equal(row.siteId, "site-mcr");
    assert.equal(row.siteLabel, "Manchester operations");
    assert.equal(row.assetIdentifier, "AB12 CDE");
    assert.equal(row.quantity, 6200);
    assert.equal(row.unit, "litres");
    assert.equal(row.datasetId, "d-2024");
    assert.equal(row.factorVersion, "2024 v1.2");
    assert.equal(row.factorSource, "dataset");
    assert.equal(row.qualityTier, "measured");
    assert.equal(row.dataConfidence, "H");
  });

  it("maps a spend entry to Scope 3.1: net value → quantity GBP, VAT into the note, GL into column text, PG&S category kept", () => {
    const row = emissionEntryDraftToScopeRow(
      draft({ activity: "General procurement", quantity: "4,100,000", vatPercent: "20", glCode: "5200", spendCategoryId: "pgs-ops", factorId: "f-diesel", note: "Q1 ledger" }),
      cat("Purchased Goods and Services"),
      { id: null, label: null },
      factors,
      months,
    );
    assert.equal(row.scope, "3.1");
    assert.equal(row.categoryCode, "3.1");
    assert.equal(row.quantity, 4100000);
    assert.equal(row.unit, "GBP");
    assert.equal(row.purchasedGoodsCategoryId, "pgs-ops");
    assert.equal(row.columnText, "5200");
    assert.equal(row.notes, "Q1 ledger · VAT 20%");
    assert.equal(row.siteId, null);
  });

  it("carries a client factor as factorSource=client with no datasetId", () => {
    const row = emissionEntryDraftToScopeRow(draft({ activity: "Packaging", quantity: "62000", unit: "m²", factorId: "cf-epd" }), cat("Purchased Goods and Services"), { id: null, label: null }, factors, months);
    assert.equal(row.factorSource, "client");
    assert.equal(row.clientFactorId, "cf-epd");
    assert.equal(row.datasetId, null);
    assert.equal(row.isCustomEntry, true);
  });

  it("only writes monthly slots when the disclosure is open", () => {
    assert.deepEqual(emissionEntryDraftToScopeRow(draft({ quantity: "30" }), cat("Natural Gas"), { id: null, label: null }, factors, months).monthlyActivity, []);
    const withMonthly = emissionEntryDraftToScopeRow(draft({ monthlyOpen: true, monthly: { "2026-01": "10", "2026-02": "20" } }), cat("Natural Gas"), { id: null, label: null }, factors, months);
    assert.deepEqual(withMonthly.monthlyActivity, [{ month: "2026-01", quantity: 10 }, { month: "2026-02", quantity: 20 }, { month: "2026-03", quantity: null }]);
  });

  it("round-trips an existing row back into a draft for the drawer", () => {
    const existing = {
      id: "row-a", sourceLabel: "Grid electricity", quantity: 312000, unit: "kWh", assetIdentifier: null,
      factorId: "f-grid", qualityTier: "measured", dataConfidence: "M", notes: "half-hourly meter",
      purchasedGoodsCategoryId: null, columnText: null,
      monthlyActivity: [{ month: "2026-01", quantity: 26000 }],
    } as unknown as ScopeRowReadModel;
    const back = scopeRowToEmissionEntryDraft(existing);
    assert.equal(back.title, "Grid electricity");
    assert.equal(back.activity, "Grid electricity");
    assert.equal(back.quantity, "312000");
    assert.equal(back.qualityTier, "Measured");
    assert.equal(back.dataConfidence, "M — Medium");
    assert.equal(back.monthlyOpen, true);
    assert.equal(back.monthly?.["2026-01"], "26000");
  });
});
