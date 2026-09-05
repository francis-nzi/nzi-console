import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { calculateLcaAssessment, computeLcaAssessmentResult, VersionConflictError, withTenantRead } from "../src/index";

const context = (key: string) => ({ organisationId: "org-a", actorId: "consultant-a", principal: "staff" as const, idempotencyKey: key, correlationId: `corr-${key}` });

// A minimal but representative assessment: a mapped dataset-factor product
// line (A1, kg), a manual-factor product line (A1), an unmapped line (A1), a
// placeholder line (A3, excluded), and one transport line (A4) whose figure
// comes entirely from its two legs — one manual (per-km), one dataset
// (tonne.km).
type Line = { line_item_id: string; module_code: string; line_label: string; quantity: string; unit: string; is_placeholder: boolean; factor_source: string; dataset_id: string | null; factor_id: string | null; client_factor_id: string | null; factor_value: string | null; factor_unit: string | null; calculated_kgco2e?: string | null; transport_kgco2e?: string };
const LINES: Line[] = [
  { line_item_id: "li-tray", module_code: "A1", line_label: "rPET tray", quantity: "31.5", unit: "kg", is_placeholder: false, factor_source: "dataset", dataset_id: "ds-1", factor_id: "f-rpet", client_factor_id: null, factor_value: null, factor_unit: null },
  { line_item_id: "li-ink", module_code: "A1", line_label: "Label ink", quantity: "0.06", unit: "kg", is_placeholder: false, factor_source: "manual", dataset_id: null, factor_id: null, client_factor_id: null, factor_value: "3.1", factor_unit: "kgCO2e/kg" },
  { line_item_id: "li-adhesive", module_code: "A1", line_label: "Food-grade adhesive", quantity: "0.35", unit: "kg", is_placeholder: false, factor_source: "unmapped", dataset_id: null, factor_id: null, client_factor_id: null, factor_value: null, factor_unit: null },
  { line_item_id: "li-assembly", module_code: "A3", line_label: "— assembly —", quantity: "0", unit: "kg", is_placeholder: true, factor_source: "unmapped", dataset_id: null, factor_id: null, client_factor_id: null, factor_value: null, factor_unit: null },
  { line_item_id: "li-transport", module_code: "A4", line_label: "Inbound shipment", quantity: "31.5", unit: "kg", is_placeholder: false, factor_source: "unmapped", dataset_id: null, factor_id: null, client_factor_id: null, factor_value: null, factor_unit: null },
];
type Leg = { leg_id: string; line_item_id: string; distance_km: string; factor_source: string; dataset_id: string | null; factor_id: string | null; factor_value: string | null };
const LEGS: Leg[] = [
  { leg_id: "leg-1", line_item_id: "li-transport", distance_km: "42", factor_source: "manual", dataset_id: null, factor_id: null, factor_value: "0.05" },
  { leg_id: "leg-2", line_item_id: "li-transport", distance_km: "19600", factor_source: "dataset", dataset_id: "ds-freight", factor_id: "f-sea", factor_value: null },
];

const TRAY_KG = 31.5 * 1.68;                       // per-kg dataset factor
const INK_KG = 0.06 * 3.1;                          // manual kgCO2e/kg
const LEG1_KG = 42 * 0.05;                          // manual, per-km (mass-independent)
const LEG2_KG = (31.5 / 1000) * 19600 * 0.015;     // dataset tonne.km, mass from the parent line
const TRANSPORT_KG = LEG1_KG + LEG2_KG;

function calcPool(opts: { expectedVersion?: number; functionalUnitValue?: number; confirmedQuantity?: number | null; assessmentType?: string } = {}) {
  const { expectedVersion = 5, functionalUnitValue = 1000, confirmedQuantity = 31.5, assessmentType = "product" } = opts;
  const lineState = new Map(LINES.map((line) => [line.line_item_id, { ...line, calculated_kgco2e: null as string | null }]));
  const legState = new Map(LEGS.map((leg) => [leg.leg_id, { ...leg, calculated_kgco2e: null as string | null }]));
  const writes: Array<{ sql: string; values?: readonly unknown[] }> = [];
  const client = {
    async query(sql: string, values?: readonly unknown[]) {
      writes.push({ sql, values });
      if (sql.includes("FROM nzi_console.command_idempotency")) return { rows: [] };
      if (sql.startsWith("SELECT version FROM nzi_console.lca_assessments a JOIN")) return { rows: [{ version: expectedVersion }] };
      if (sql.includes("SELECT line_item_id,module_code,line_label,quantity::text,unit,factor_source,dataset_id,factor_id,client_factor_id,factor_value::text,factor_unit,is_placeholder")) return { rows: [...lineState.values()] };
      if (sql.startsWith("UPDATE nzi_console.lca_line_items SET calculated_kgco2e=NULL WHERE")) {
        for (const id of (values as [string, string[]])[1]) { const l = lineState.get(id); if (l) l.calculated_kgco2e = null; }
        return { rows: [] };
      }
      if (sql.startsWith("UPDATE nzi_console.lca_line_items SET calculated_kgco2e=$3")) {
        const [, lineItemId, kgco2e] = values as [string, string, number | null];
        const line = lineState.get(lineItemId);
        if (line) line.calculated_kgco2e = kgco2e == null ? null : String(kgco2e);
        return { rows: [] };
      }
      if (sql.includes("FROM nzi_console.lca_transport_legs WHERE organisation_id=$1 AND line_item_id=ANY")) return { rows: [...legState.values()] };
      if (sql.startsWith("UPDATE nzi_console.lca_transport_legs SET calculated_kgco2e=")) {
        const [, legId, kgco2e] = values as [string, string, number | null];
        const leg = legState.get(legId);
        if (leg) leg.calculated_kgco2e = kgco2e == null ? null : String(kgco2e);
        return { rows: [] };
      }
      if (sql.startsWith("UPDATE nzi_console.lca_line_items SET transport_kgco2e=")) {
        const [, lineItemId] = values as [string, string];
        const line = lineState.get(lineItemId);
        const legs = [...legState.values()].filter((leg) => leg.line_item_id === lineItemId);
        if (line) line.transport_kgco2e = String(legs.reduce((sum, leg) => sum + Number(leg.calculated_kgco2e ?? 0), 0));
        return { rows: [] };
      }
      if (sql.includes("SELECT functional_unit_value::text,confirmed_quantity::text,assessment_type FROM nzi_console.lca_assessments")) return { rows: [{ functional_unit_value: String(functionalUnitValue), confirmed_quantity: confirmedQuantity == null ? null : String(confirmedQuantity), assessment_type: assessmentType }] };
      if (sql.includes("SELECT line_item_id,module_code,line_label,quantity::text,unit,is_placeholder,calculated_kgco2e::text,transport_kgco2e::text")) {
        return { rows: [...lineState.values()].map((line) => ({ ...line, transport_kgco2e: line.transport_kgco2e ?? "0" })) };
      }
      if (sql.includes("SELECT f.kgco2e_per_unit::text,f.activity_unit FROM nzi_console.emission_factors")) {
        const factorId = (values as unknown[])[3];
        if (factorId === "f-rpet") return { rows: [{ kgco2e_per_unit: "1.68", activity_unit: "kg" }] };
        if (factorId === "f-sea") return { rows: [{ kgco2e_per_unit: "0.015", activity_unit: "tonne.km" }] };
        return { rows: [] };
      }
      if (sql.startsWith("UPDATE nzi_console.lca_assessments SET total_tco2e=")) return { rows: [{ version: expectedVersion + 1 }] };
      return { rows: [] };
    },
    release() {},
  };
  return { pool: { connect: async () => client } as never, writes, lineState, legState };
}

describe("calculateLcaAssessment (Track C / L4 — the calc engine, live-parity)", () => {
  it("resolves dataset + manual product line items; leaves unmapped/placeholder/transport lines alone", async () => {
    const state = calcPool();
    const result = await calculateLcaAssessment(state.pool, { jobId: "job-1", assessmentId: "assess-1", expectedVersion: 5 }, context("calc-1"));
    assert.equal(Number(state.lineState.get("li-tray")!.calculated_kgco2e), TRAY_KG);
    assert.ok(Math.abs(Number(state.lineState.get("li-ink")!.calculated_kgco2e) - INK_KG) < 1e-9);
    assert.equal(state.lineState.get("li-adhesive")!.calculated_kgco2e, null);
    assert.equal(state.lineState.get("li-assembly")!.calculated_kgco2e, null);
    assert.equal(state.lineState.get("li-transport")!.calculated_kgco2e, null, "a transport line is never quantity×factor");
    assert.equal(result.data.version, 6);
  });

  it("computes each leg by its factor's denominator unit and sums them onto the parent line", async () => {
    const state = calcPool();
    await calculateLcaAssessment(state.pool, { jobId: "job-1", assessmentId: "assess-1", expectedVersion: 5 }, context("calc-2"));
    assert.ok(Math.abs(Number(state.legState.get("leg-1")!.calculated_kgco2e) - LEG1_KG) < 1e-9, "manual per-km leg");
    assert.ok(Math.abs(Number(state.legState.get("leg-2")!.calculated_kgco2e) - LEG2_KG) < 1e-9, "dataset tonne.km leg, mass from the parent");
    assert.ok(Math.abs(Number(state.lineState.get("li-transport")!.transport_kgco2e) - TRANSPORT_KG) < 1e-9);
  });

  it("resets review to pending and bumps the assessment version", async () => {
    const state = calcPool();
    await calculateLcaAssessment(state.pool, { jobId: "job-1", assessmentId: "assess-1", expectedVersion: 5 }, context("calc-3"));
    const update = state.writes.find((w) => w.sql.startsWith("UPDATE nzi_console.lca_assessments SET total_tco2e="));
    assert.ok(update?.sql.includes("review_status='pending'"));
    assert.ok(update?.sql.includes("version=version+1"));
  });

  it("a stale expectedVersion is a version conflict", async () => {
    await assert.rejects(() => calculateLcaAssessment(calcPool({ expectedVersion: 5 }).pool, { jobId: "job-1", assessmentId: "assess-1", expectedVersion: 4 }, context("calc-stale")), VersionConflictError);
  });
});

describe("computeLcaAssessmentResult (Track C / L4 — §4 no functional-unit scaling)", () => {
  it("total is the plain sum of absolute line emissions ÷ 1000, with per-FU as a separate division", async () => {
    const state = calcPool({ functionalUnitValue: 1000, confirmedQuantity: 31.5 });
    await calculateLcaAssessment(state.pool, { jobId: "job-1", assessmentId: "assess-1", expectedVersion: 5 }, context("calc-result-1"));
    const result = await withTenantRead(state.pool, "org-a", (db) => computeLcaAssessmentResult(db, "org-a", "assess-1"));

    const a1T = (TRAY_KG + INK_KG) / 1000;
    const a4T = TRANSPORT_KG / 1000;
    const total = a1T + a4T;
    assert.ok(Math.abs(result.moduleBreakdown.find((e) => e.moduleCode === "A1")!.tco2e - a1T) < 1e-9);
    assert.ok(Math.abs(result.moduleBreakdown.find((e) => e.moduleCode === "A4")!.tco2e - a4T) < 1e-9);
    assert.ok(Math.abs(result.totalTco2e - total) < 1e-9, "NOT scaled by functionalUnitValue");
    assert.ok(Math.abs(result.perFunctionalUnitTco2e - total / 1000) < 1e-9, "per-FU is total ÷ FU quantity");
    assert.equal(result.hotspots[0]!.lineItemId, "li-tray");
  });

  it("§5 — mass reconciliation is the A1 module basis, material assessments only", async () => {
    const state = calcPool({ confirmedQuantity: 31.5 });
    await calculateLcaAssessment(state.pool, { jobId: "job-1", assessmentId: "assess-1", expectedVersion: 5 }, context("calc-mass-1"));
    const material = await withTenantRead(state.pool, "org-a", (db) => computeLcaAssessmentResult(db, "org-a", "assess-1"));
    // A1 lines: tray 31.5 + ink 0.06 + adhesive 0.35 = 31.91; transport line (A4) is NOT counted.
    assert.ok(Math.abs(material.massReconciliation.capturedMassKg - (31.5 + 0.06 + 0.35)) < 1e-9);
    assert.equal(material.massReconciliation.confirmedMassKg, 31.5);
    assert.ok(material.massReconciliation.deltaPct !== null && material.massReconciliation.deltaPct > 0);

    const service = await withTenantRead(calcPool({ assessmentType: "service" }).pool, "org-a", (db) => computeLcaAssessmentResult(db, "org-a", "assess-1"));
    assert.equal(service.massReconciliation.confirmedMassKg, null, "service assessments have no mass reconciliation");
    assert.equal(service.massReconciliation.capturedMassKg, 0);
  });
});
