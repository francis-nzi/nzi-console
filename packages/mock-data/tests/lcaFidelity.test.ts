import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LcaAssessment } from "@nzi/contracts";
import {
  lcaFidelityAssessments,
  massReconciliationSnapshot,
  modelRegister6L,
  modelRegister9L,
  pcfDiagnosticUnit,
  rpetTrayComponent,
  corrugatedBoxComponent,
} from "../src/lcaFidelity";

const total = (assessment: LcaAssessment) =>
  assessment.lines
    .filter((line) => !line.isPlaceholder && line.calculatedKgco2e != null)
    .reduce((sum, line) => sum + (line.calculatedKgco2e ?? 0) + line.transportKgco2e, 0);

describe("LCA/PCF worst-case fixtures (MODEL_FIDELITY_JOB_FAMILIES §2)", () => {
  it("is a Model Register: two assessments on one job, distinct variants", () => {
    assert.equal(modelRegister6L.jobId, "714");
    assert.equal(modelRegister9L.jobId, "714");
    assert.notEqual(modelRegister6L.id, modelRegister9L.id);
    assert.equal(modelRegister6L.reviewStatus, "approved");
    assert.equal(modelRegister6L.reviewedVersion, 3);
    assert.equal(modelRegister9L.reviewStatus, "pending");
    assert.equal(modelRegister9L.reviewedVersion, null);
  });

  it("review status is bound to a reviewed version (NZC-055)", () => {
    for (const assessment of lcaFidelityAssessments) {
      assert.equal(assessment.reviewStatus === "pending", assessment.reviewedVersion === null);
    }
  });

  it("carries a multi-leg geocoded transport journey whose cache is the leg sum", () => {
    const transportLine = modelRegister6L.lines.find((line) => line.moduleCode === "A4")!;
    assert.equal(transportLine.transportLegs.length, 3);
    assert.deepEqual(transportLine.transportLegs.map((leg) => leg.mode), ["road_hgv", "sea", "road_hgv"]);
    const legSum = transportLine.transportLegs.reduce((sum, leg) => sum + (leg.calculatedKgco2e ?? 0), 0);
    assert.equal(Math.round(legSum * 10) / 10, transportLine.transportKgco2e);
    assert.ok(transportLine.transportLegs.every((leg, index) => leg.legOrder === index));
  });

  it("has an unmapped line, a gap-filled proxy line and a placeholder excluded from the total", () => {
    const byId = new Map(modelRegister6L.lines.map((line) => [line.id.replace("6l-", ""), line]));
    assert.equal(byId.get("adhesive")!.factorSource, "unmapped");
    assert.equal(byId.get("adhesive")!.calculatedKgco2e, null);
    assert.equal(byId.get("label-ink")!.isGapFilled, true);
    assert.equal(byId.get("label-ink")!.dataQuality, "proxy");
    assert.equal(byId.get("assembly")!.isPlaceholder, true);
    // the placeholder contributes nothing to the derived total
    assert.ok(total(modelRegister6L) > 0);
  });

  it("PCF preset: ISO 14067, cradle-to-gate, A1–A3, and keeps the label (NZC-039/052)", () => {
    assert.equal(pcfDiagnosticUnit.isPcf, true);
    assert.equal(pcfDiagnosticUnit.standard, "ISO 14067");
    assert.equal(pcfDiagnosticUnit.lifecycleBoundary, "cradle_to_gate");
    assert.deepEqual(pcfDiagnosticUnit.includedModules, ["A1", "A2", "A3"]);
    assert.match(pcfDiagnosticUnit.name, /Product Carbon Footprint/);
  });

  it("component library has one client-scoped and one global entry (NZC-053)", () => {
    assert.equal(rpetTrayComponent.clientId, "verdant");
    assert.equal(corrugatedBoxComponent.clientId, null);
  });

  it("result snapshot is content-addressed and shows the mass-reconciliation gap", () => {
    assert.match(massReconciliationSnapshot.dataHash, /^sha256:[0-9a-f]{64}$/);
    assert.equal(massReconciliationSnapshot.massReconciliation.confirmedMassKg, 31.5);
    assert.equal(massReconciliationSnapshot.massReconciliation.capturedMassKg, 28.9);
    assert.ok((massReconciliationSnapshot.massReconciliation.deltaPct ?? 0) < 0);
    assert.equal(massReconciliationSnapshot.moduleBreakdown.reduce((sum, m) => sum + m.tco2e, 0), 62.9);
  });
});
