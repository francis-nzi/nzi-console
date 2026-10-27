// Data entry D1 (27 Oct): the shared drawer's Activity | Spend toggle. Only the basis block swaps; the common fields keep their
// place; spend is offered where a spend factor is; a spend entry may be recorded under any category; the default and the client's
// last choice decide where the drawer opens. The model is pure, so it is tested here; the write is proved in dataEntryD1Real.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { emissionCategoryTaxonomy, renderInputSpec, type EmissionCategory } from "@nzi/contracts";
import {
  draftBasis, emissionEntryDraftToScopeRow, factorsForBasis, fieldsForBasis, nativeEntryBasis, openingCurrency, quickAddSaveIssue,
  scopeRowToEmissionEntryDraft, spendCurrencies, type EmissionEntryDraft, type EntryFactorRef,
} from "../app/jobs/emissionEntryModel";
import { ADMIN_ITEMS } from "../app/admin/adminNav";
import { seededSpec, specFor } from "./support/entryRenderMatrix";

const here = dirname(fileURLToPath(import.meta.url));
const source = (path: string) => readFileSync(resolve(here, "..", path), "utf8");
const cat = (code: string): EmissionCategory => emissionCategoryTaxonomy.find(entry => entry.code === code)!;
const keys = (fields: Array<{ key: string }>) => fields.map(field => field.key);
const draft = (over: Partial<EmissionEntryDraft> = {}): EmissionEntryDraft => ({
  activity: "", quantity: "", unit: "", vatPercent: "", glCode: "", spendCategoryId: "", registration: "", manualMode: false, manualDetail: "",
  factorId: "", qualityTier: "Spend-based", dataConfidence: "M — Medium", supplySource: "", factorOverrideReason: "", note: "", monthlyOpen: false,
  monthly: {}, ...over,
});
const COMMON = ["siteBanner", "monthly", "qualityTier", "dataConfidence", "note", "documents", "lineage"];
const common = (fields: Array<{ key: string }>) => keys(fields).filter(key => COMMON.includes(key));

const refs: EntryFactorRef[] = [
  { id: "dataset:d|rail-km", factorId: "rail-km", label: "Rail · km", unit: "km", datasetId: "d", datasetVersion: "v1", factorSource: "dataset", scope: "3" },
  { id: "dataset:d|travel-gbp", factorId: "travel-gbp", label: "Travel spend · GBP", unit: "GBP", datasetId: "d", datasetVersion: "v1", factorSource: "dataset", scope: "3" },
  { id: "dataset:d|travel-eur", factorId: "travel-eur", label: "Travel spend · EUR", unit: "EUR", datasetId: "d", datasetVersion: "v1", factorSource: "dataset", scope: "3" },
];

describe("R1 — only the basis block swaps", () => {
  it("at its native basis every category renders exactly as the spec does — the 160 pinned renders are untouched", () => {
    for (const spec of seededSpec()) {
      const category = cat(spec.categoryCode);
      for (const audience of ["crm", "portal"] as const) for (const mode of ["new", "existing"] as const) for (const lean of [false, true]) {
        const rendered = renderInputSpec(spec, audience, mode, lean);
        assert.deepEqual(fieldsForBasis(rendered, category, nativeEntryBasis(category)), rendered, `${spec.categoryCode} ${audience} ${mode} ${lean}`);
      }
    }
  });

  it("Spend on Company Vehicles: the finder and usage go, the value is money, the spend details join — the common fields stay put", () => {
    const activity = renderInputSpec(specFor("1.company-vehicles"), "crm", "new", false);
    const spend = fieldsForBasis(activity, cat("1.company-vehicles"), "spend");
    assert.ok(!keys(spend).includes("registrationFinder") && !keys(spend).includes("usageType"));
    assert.deepEqual(keys(spend).slice(keys(spend).indexOf("quantity"), keys(spend).indexOf("quantity") + 2), ["quantity", "spendDetails"]);
    assert.equal(spend.find(field => field.key === "quantity")!.label, "Spend value");
    assert.deepEqual(common(spend), common(activity), "site, period, quality, notes, documents, lineage: same fields, same order");
  });

  it("Spend on Purchased Electricity drops the supply answer (it belongs to the activity); Activity on PG&S drops the spend details", () => {
    const electricity = fieldsForBasis(renderInputSpec(specFor("2.purchased-electricity"), "crm", "new", false), cat("2.purchased-electricity"), "spend");
    assert.ok(!keys(electricity).includes("supplySource"));
    const pgs = renderInputSpec(specFor("3.1"), "crm", "new", false);
    const pgsActivity = fieldsForBasis(pgs, cat("3.1"), "activity");
    assert.ok(!keys(pgsActivity).includes("spendDetails"));
    assert.equal(pgsActivity.find(field => field.key === "quantity")!.label, "Quantity");
    assert.deepEqual(common(pgsActivity), common(pgs));
  });
});

describe("R2/R3 — spend factors, currency, and the write", () => {
  it("a spend factor is one priced per a currency; each basis picks from its own, spend in the entry's currency", () => {
    assert.deepEqual(factorsForBasis(refs, "activity").map(ref => ref.factorId), ["rail-km"]);
    assert.deepEqual(factorsForBasis(refs, "spend").map(ref => ref.factorId), ["travel-gbp", "travel-eur"]);
    assert.deepEqual(factorsForBasis(refs, "spend", "EUR").map(ref => ref.factorId), ["travel-eur"]);
    assert.deepEqual(spendCurrencies(refs), ["EUR", "GBP"]);
    assert.equal(openingCurrency(refs, "GBP"), "GBP", "the client's currency, where a spend factor is priced in it");
    assert.equal(openingCurrency(refs, "USD"), "EUR", "else the first that is — so the entry can be priced");
    assert.equal(openingCurrency([], "USD"), "USD");
  });

  it("a spend entry under Business Travel maps to a spend row there: its currency, VAT in the note, GL in the column, no PG&S category", () => {
    const fields = emissionEntryDraftToScopeRow(draft({ basis: "spend", currency: "EUR", activity: "Agency invoices", quantity: "1,200", vatPercent: "20",
      glCode: "7420", spendCategoryId: "pgs-x", factorId: "dataset:d|travel-eur", note: "Q1" }), cat("3.6"), { id: null, label: null }, refs, []);
    assert.equal(fields.scope, "3.6");
    assert.equal(fields.categoryCode, "3.6");
    assert.equal(fields.unit, "EUR");
    assert.equal(fields.entryBasis, "spend");
    assert.equal(fields.quantity, 1200);
    assert.equal(fields.notes, "Q1 · VAT 20%");
    assert.equal(fields.columnText, "7420");
    assert.equal(fields.purchasedGoodsCategoryId, null, "a PG&S sub-category is PG&S's own");
    assert.equal(fields.qualityTier, "spend-based");
  });

  it("an Activity entry on PG&S records its physical unit, not GBP; and a draft from before the toggle maps exactly as it did", () => {
    const activity = emissionEntryDraftToScopeRow(draft({ basis: "activity", unit: "km", quantity: "40", factorId: "dataset:d|rail-km", qualityTier: "Measured" }), cat("3.1"), { id: null, label: null }, refs, []);
    assert.equal(activity.unit, "km");
    assert.equal(activity.entryBasis, "activity");
    const legacy = emissionEntryDraftToScopeRow(draft({ quantity: "10", factorId: "dataset:d|travel-gbp", spendCategoryId: "pgs-x" }), cat("3.1"), { id: null, label: null }, refs, []);
    assert.equal(legacy.unit, "GBP");
    assert.equal(legacy.purchasedGoodsCategoryId, "pgs-x");
    assert.ok(!("entryBasis" in legacy), "no toggle, no stated basis");
    assert.equal(draftBasis(draft(), cat("3.1")), "spend");
    assert.equal(draftBasis(draft(), cat("3.6")), "activity");
  });

  it("a row reopened reads its basis from its unit — a currency is spend, in that currency", () => {
    const row = (unit: string | null) => scopeRowToEmissionEntryDraft({ sourceLabel: "x", quantity: 1, unit, monthlyActivity: [] } as never);
    assert.deepEqual([row("GBP").basis, row("GBP").currency], ["spend", "GBP"]);
    assert.deepEqual([row("km").basis, row("km").currency], ["activity", undefined]);
    assert.equal(row(null).basis, undefined);
  });

  it("the save rule: a spend description is free text on any category; an activity must still be a listed factor", () => {
    const options = refs.map(ref => ({ id: ref.id, label: ref.label }));
    assert.equal(quickAddSaveIssue(draft({ basis: "spend", activity: "Agency invoices", factorId: "dataset:d|travel-gbp" }), options, cat("3.6"), "crm"), null);
    assert.match(quickAddSaveIssue(draft({ basis: "activity", activity: "Agency invoices", factorId: "dataset:d|rail-km" }), options, cat("3.6"), "crm") ?? "", /isn't one of/);
  });
});

describe("the wiring", () => {
  const form = source("app/jobs/EmissionEntryForm.tsx");
  it("the toggle is the first control — before the spec's fields — and Spend is disabled with a note where no spend factor is", () => {
    assert.ok(form.indexOf('className="nz-ef-basis"') > 0 && form.indexOf('className="nz-ef-basis"') < form.indexOf("{fields.map(field =>"));
    assert.match(form, /option === "spend" && !spendAvailable/);
    assert.match(form, /Spend isn&rsquo;t available here/);
    assert.match(form, /fieldsForBasis\(renderInputSpec\(spec, audience, mode, leanCapture\), category, basis\)/);
  });
  it("switching sets the basis block aside and restores it; the common fields are not in the block", () => {
    assert.match(form, /stashed\.current\[from\] = /);
    for (const key of ["site", "note", "monthly", "monthlyOpen", "dataConfidence"]) assert.ok(!new RegExp(`BASIS_BLOCK_FIELDS = \\[[^\\]]*"${key}"`).test(form), `${key} is common`);
  });
  it("currency and VAT are on the spend block only", () => {
    const spendBranch = form.slice(form.indexOf('field.key === "quantity" && spend'), form.indexOf(') : field.key === "quantity" ? ('));
    assert.match(spendBranch, /Currency/);
    assert.match(spendBranch, /VAT %/);
    const activityBranch = form.slice(form.indexOf(') : field.key === "quantity" ? ('), form.indexOf('case "unit-select"'));
    assert.ok(!/VAT|Currency/.test(activityBranch));
  });
  it("both surfaces read the job's basis settings; the portal's bucket flow is locked to its source's basis", () => {
    assert.match(source("app/jobs/CrpScopeWorkspace.tsx"), /\/entry-basis`/);
    assert.match(source("app/jobs/CrpScopeWorkspace.tsx"), /entryBasis=\{entryBasis\}/);
    assert.match(source("app/portal/jobs/[jobId]/data/PortalDataView.tsx"), /\$\{base\}\/entry-basis`/);
    assert.match(source("app/portal/PortalCategoryEntry.tsx"), /basisLocked=\{bucket\.entryKind === "spend" \? "spend" : "activity"\}/);
  });
  it("the portal's read sends settings only — no staff identity", () => {
    const route = source("app/api/portal/jobs/[jobId]/entry-basis/route.ts");
    assert.match(route, /assertPortalJobAccess/);
    assert.ok(!/chosen_by|updated_by|chosenBy|updatedBy/.test(source("../../packages/isolated-backend/src/entryBasis.ts").slice(source("../../packages/isolated-backend/src/entryBasis.ts").indexOf("export async function readJobEntryBasis"), source("../../packages/isolated-backend/src/entryBasis.ts").indexOf("export type EntryBasisDefaultResult"))));
  });
  it("Admin: the Data entry page is under Carbon data, admin.settings, and the route runs the gated command", () => {
    const item = ADMIN_ITEMS.find(entry => entry.id === "data-entry")!;
    assert.equal(item.capability, "admin.settings");
    assert.equal(item.href, "/admin/data-entry");
    assert.match(source("app/api/isolated/entry-basis-defaults/route.ts"), /requireCommandPrincipal\(request, "admin\.entryBasis\.update"\)/);
  });
});
