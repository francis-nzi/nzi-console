import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import type { EmissionCategory } from "@nzi/contracts";
import { emissionEntryDraftToScopeRow, entryFactorRefsFor, type EmissionEntryDraft } from "../app/jobs/emissionEntryModel";

/**
 * The capture form sends the command the factor's own id, not the form's option key (found in Stop 2b).
 *
 * The workspace keyed each factor option `<source>:<dataset or client factor>|<factor>` — unique across datasets,
 * which a select needs — and the quick-add mapping sent that key as `factorId`. So every CRM quick-add entry with
 * a picked factor was stored as `dataset:synthetic-gb-2026|electricity-demo`: never found by the unit check, and
 * refused by calculation (NOT_SELECTED). The row existed and could never be counted. Its tests used bare ids like
 * `f-grid`, which is why they passed: they never built the options the way the workspace does.
 *
 * So the options are built by one function the workspace and these tests share, and the command gets `factorId`.
 */

const WORKSPACE = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "app/jobs/CrpScopeWorkspace.tsx");

const options = entryFactorRefsFor([
  { factorSource: "dataset", datasetId: "synthetic-gb-2026", clientFactorId: null, factorId: "electricity-demo",
    label: "UK electricity — demonstration factor", activityUnit: "kWh", synthetic: true, scopes: ["2"], datasetVersion: "2026 demo v1" },
  { factorSource: "client", datasetId: null, clientFactorId: "cf-epd", factorId: "epd-panel",
    label: "Panel EPD", activityUnit: "m²", synthetic: false, scopes: ["3"], datasetVersion: null },
]);
const draft = (factorId: string): EmissionEntryDraft => ({
  activity: "Meter", quantity: "1000", unit: "kWh", vatPercent: "", glCode: "", spendCategoryId: "", registration: "",
  manualMode: false, manualDetail: "", factorId, qualityTier: "Measured", dataConfidence: "M — Medium",
  supplySource: "grid", factorOverrideReason: "", note: "", monthlyOpen: false, monthly: {},
});
const electricity = { code: "2.purchased-electricity", name: "Purchased electricity", scope: "2", kind: "manual" } as unknown as EmissionCategory;

describe("the capture form sends the factor's own id", () => {
  it("keys each option uniquely for the select, and keeps the factor's own id beside it", () => {
    assert.equal(options[0]!.id, "dataset:synthetic-gb-2026|electricity-demo");
    assert.equal(options[0]!.factorId, "electricity-demo");
    assert.equal(options[1]!.id, "client:cf-epd|epd-panel");
    assert.equal(options[1]!.factorId, "epd-panel");
  });

  it("sends a dataset factor as its own id, with its dataset beside it", () => {
    const command = emissionEntryDraftToScopeRow(draft(options[0]!.id), electricity, { id: null, label: null }, options, []);
    assert.equal(command.factorId, "electricity-demo", "the form's option key was sent as the factor id");
    assert.equal(command.datasetId, "synthetic-gb-2026");
    assert.equal(command.factorVersion, "2026 demo v1");
  });

  it("sends a client factor as its own id, with the client factor beside it", () => {
    const command = emissionEntryDraftToScopeRow(draft(options[1]!.id), electricity, { id: null, label: null }, options, []);
    assert.equal(command.factorId, "epd-panel");
    assert.equal(command.clientFactorId, "cf-epd");
    assert.equal(command.factorSource, "client");
  });

  it("is how the workspace builds its options — not a second, inline copy of the key", () => {
    const source = readFileSync(WORKSPACE, "utf8");
    assert.ok(source.includes("entryFactorRefsFor("), "the workspace does not build its options with entryFactorRefsFor");
    assert.ok(!/entryFactorRefs\s*=\s*factors\.map/.test(source), "the workspace still maps factors to options inline");
  });
});
