import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { emissionCategoryTaxonomy, type EmissionCategory } from "@nzi/contracts";
import {
  buildEmissionEntryFields,
  emissionEntryActions,
  isRegistrationKind,
  isSpendKind,
  manualEntryHint,
} from "../app/jobs/emissionEntryForm";

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
