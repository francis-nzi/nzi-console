import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { calculateLcaAssessment, computeLcaAssessmentResult, VersionConflictError, withTenantRead } from "../src/index";

const context = (key: string) => ({ organisationId: "org-a", actorId: "consultant-a", principal: "staff" as const, idempotencyKey: key, correlationId: `corr-${key}` });

// A minimal but representative assessment: a mapped dataset-factor product
// line (A1), a manual-factor product line (A1), an unmapped line (A1), a
// placeholder line (A3, excluded throughout), and one transport line (A4)
// with two legs — one manual, one dataset.
type Line = { line_item_id: string; module_code: string; line_label: string; quantity: string; unit: string; is_placeholder: boolean; factor_source: string; dataset_id: string | null; factor_id: string | null; client_factor_id: string | null; factor_value: string | null; calculated_kgco2e?: string | null; transport_kgco2e?: string };
const LINES: Line[] = [
  { line_item_id: "li-tray", module_code: "A1", line_label: "rPET tray", quantity: "31.5", unit: "kg", is_placeholder: false, factor_source: "dataset", dataset_id: "ds-1", factor_id: "f-rpet", client_factor_id: null, factor_value: null },
  { line_item_id: "li-ink", module_code: "A1", line_label: "Label ink", quantity: "0.06", unit: "kg", is_placeholder: false, factor_source: "manual", dataset_id: null, factor_id: null, client_factor_id: null, factor_value: "3.1" },
  { line_item_id: "li-adhesive", module_code: "A1", line_label: "Food-grade adhesive", quantity: "0.35", unit: "kg", is_placeholder: false, factor_source: "unmapped", dataset_id: null, factor_id: null, client_factor_id: null, factor_value: null },
  { line_item_id: "li-assembly", module_code: "A3", line_label: "— assembly —", quantity: "0", unit: "kg", is_placeholder: true, factor_source: "unmapped", dataset_id: null, factor_id: null, client_factor_id: null, factor_value: null },
  { line_item_id: "li-transport", module_code: "A4", line_label: "Inbound shipment", quantity: "31.5", unit: "kg", is_placeholder: false, factor_source: "unmapped", dataset_id: null, factor_id: null, client_factor_id: null, factor_value: null },
];
type Leg = { leg_id: string; line_item_id: string; distance_km: string; factor_source: string; dataset_id: string | null; factor_id: string | null; factor_value: string | null };
const LEGS: Leg[] = [
  { leg_id: "leg-1", line_item_id: "li-transport", distance_km: "42", factor_source: "manual", dataset_id: null, factor_id: null, factor_value: "0.05" },
  { leg_id: "leg-2", line_item_id: "li-transport", distance_km: "19600", factor_source: "dataset", dataset_id: "ds-freight", factor_id: "f-sea", factor_value: null },
];

function calcPool(opts: { expectedVersion?: number; functionalUnitValue?: number; confirmedQuantity?: number | null } = {}) {
  const { expectedVersion = 5, functionalUnitValue = 1000, confirmedQuantity = 31.5 } = opts;
  const lineState = new Map(LINES.map((line) => [line.line_item_id, { ...line, calculated_kgco2e: null as string | null }]));
  const legState = new Map(LEGS.map((leg) => [leg.leg_id, { ...leg, calculated_kgco2e: null as string | null }]));
  const writes: Array<{ sql: string; values?: readonly unknown[] }> = [];
  const client = {
    async query(sql: string, values?: readonly unknown[]) {
      writes.push({ sql, values });
      if (sql.includes("FROM nzi_console.command_idempotency")) return { rows: [] };
      if (sql.startsWith("SELECT version FROM nzi_console.lca_assessments a JOIN")) return { rows: [{ version: expectedVersion }] };
      if (sql.includes("SELECT line_item_id,module_code,line_label,quantity::text,unit,factor_source,dataset_id,factor_id,client_factor_id,factor_value::text,is_placeholder")) return { rows: [...lineState.values()] };
      if (sql.startsWith("UPDATE nzi_console.lca_line_items SET calculated_kgco2e=")) {
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
      if (sql.includes("SELECT functional_unit_value::text,confirmed_quantity::text FROM nzi_console.lca_assessments")) return { rows: [{ functional_unit_value: String(functionalUnitValue), confirmed_quantity: confirmedQuantity == null ? null : String(confirmedQuantity) }] };
      if (sql.includes("SELECT line_item_id,module_code,line_label,quantity::text,unit,is_placeholder,calculated_kgco2e::text,transport_kgco2e::text")) {
        return { rows: [...lineState.values()].map((line) => ({ ...line, transport_kgco2e: line.transport_kgco2e ?? "0" })) };
      }
      if (sql.includes("SELECT f.kgco2e_per_unit::text,f.activity_unit FROM nzi_console.emission_factors")) {
        const factorId = (values as unknown[])[3];
        if (factorId === "f-rpet") return { rows: [{ kgco2e_per_unit: "1.68", activity_unit: "kg" }] };
        if (factorId === "f-sea") return { rows: [{ kgco2e_per_unit: "0.0003", activity_unit: "km" }] };
        return { rows: [] };
      }
      if (sql.startsWith("UPDATE nzi_console.lca_assessments SET total_tco2e=")) return { rows: [{ version: expectedVersion + 1 }] };
      return { rows: [] };
    },
    release() {},
  };
  return { pool: { connect: async () => client } as never, writes, lineState, legState };
}

describe("calculateLcaAssessment (Track C / L4 — the calc engine)", () => {
  it("resolves dataset, manual and unmapped line items; leaves unmapped/placeholder alone", async () => {
    const state = calcPool();
    const result = await calculateLcaAssessment(state.pool, { jobId: "job-1", assessmentId: "assess-1", expectedVersion: 5 }, context("calc-1"));

    assert.equal(state.lineState.get("li-tray")!.calculated_kgco2e, String(31.5 * 1.68));
    assert.equal(state.lineState.get("li-ink")!.calculated_kgco2e, String(0.06 * 3.1));
    assert.equal(state.lineState.get("li-adhesive")!.calculated_kgco2e, null, "unmapped stays uncalculated");
    assert.equal(state.lineState.get("li-assembly")!.calculated_kgco2e, null, "placeholder is never touched");
    assert.equal(result.data.version, 6);
  });

  it("resolves transport legs (manual x distance, dataset x distance) and sums them onto the parent line's transport total", async () => {
    const state = calcPool();
    await calculateLcaAssessment(state.pool, { jobId: "job-1", assessmentId: "assess-1", expectedVersion: 5 }, context("calc-2"));
    assert.equal(state.legState.get("leg-1")!.calculated_kgco2e, String(42 * 0.05));
    assert.equal(state.legState.get("leg-2")!.calculated_kgco2e, String(19600 * 0.0003));
    const expectedTransportTotal = 42 * 0.05 + 19600 * 0.0003;
    assert.equal(state.lineState.get("li-transport")!.transport_kgco2e, String(expectedTransportTotal));
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

describe("computeLcaAssessmentResult (Track C / L4)", () => {
  it("scales per-unit kg figures by functionalUnitValue, converts to tonnes, and reconciles mass", async () => {
    const state = calcPool({ functionalUnitValue: 1000, confirmedQuantity: 31.5 });
    await calculateLcaAssessment(state.pool, { jobId: "job-1", assessmentId: "assess-1", expectedVersion: 5 }, context("calc-result-1"));
    const result = await withTenantRead(state.pool, "org-a", (db) => computeLcaAssessmentResult(db, "org-a", "assess-1"));

    // rPET tray: 31.5kg x 1.68 = 52.92 kg/pack; x1000 packs / 1000 = 52.92 t.
    const trayT = (31.5 * 1.68 * 1000) / 1000;
    const inkT = (0.06 * 3.1 * 1000) / 1000;
    const transportT = ((42 * 0.05 + 19600 * 0.0003) * 1000) / 1000;
    const a1 = result.moduleBreakdown.find((entry) => entry.moduleCode === "A1");
    const a4 = result.moduleBreakdown.find((entry) => entry.moduleCode === "A4");
    assert.ok(a1 && Math.abs(a1.tco2e - (trayT + inkT)) < 1e-9);
    assert.ok(a4 && Math.abs(a4.tco2e - transportT) < 1e-9);
    assert.ok(Math.abs(result.totalTco2e - (trayT + inkT + transportT)) < 1e-9);

    // Hotspot #1 is the tray (by far the largest single contributor).
    assert.equal(result.hotspots[0]!.lineItemId, "li-tray");

    // Captured mass excludes the transport line's own quantity (already counted at the product module).
    assert.equal(result.massReconciliation.capturedMassKg, 31.5 + 0.06 + 0.35);
    assert.equal(result.massReconciliation.confirmedMassKg, 31.5);
    assert.ok(result.massReconciliation.deltaPct !== null && result.massReconciliation.deltaPct > 0, "captured slightly exceeds confirmed here");
  });
});
