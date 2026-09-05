import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CommandValidationError, computeLcaScenarioResult, createLcaScenario, deleteLcaScenario,
  deleteLcaScenarioMultiplier, scenarioMultiplierFor, setLcaScenarioMultiplier,
  updateLcaScenario, withTenantRead,
} from "../src/index";

const context = (key: string) => ({ organisationId: "org-a", actorId: "consultant-a", principal: "staff" as const, idempotencyKey: key, correlationId: `corr-${key}` });

describe("scenarioMultiplierFor (Track C / L5, §9)", () => {
  const rules = [
    { moduleCode: "A1", materialCategoryId: null, componentId: null, multiplier: 0.9 },       // module wildcard
    { moduleCode: "A1", materialCategoryId: "mc-poly", componentId: null, multiplier: 0.7 },  // category
    { moduleCode: "A1", materialCategoryId: null, componentId: "cmp-tray", multiplier: 0.5 }, // component
  ];
  it("returns 1.0 when no rule matches the module", () => {
    assert.equal(scenarioMultiplierFor(rules, { moduleCode: "A3", materialCategoryId: "mc-poly", componentId: null }), 1.0);
  });
  it("uses the module wildcard when only the module matches", () => {
    assert.equal(scenarioMultiplierFor(rules, { moduleCode: "A1", materialCategoryId: "mc-other", componentId: null }), 0.9);
  });
  it("prefers the category rule over the wildcard", () => {
    assert.equal(scenarioMultiplierFor(rules, { moduleCode: "A1", materialCategoryId: "mc-poly", componentId: null }), 0.7);
  });
  it("prefers the component rule over category and wildcard", () => {
    assert.equal(scenarioMultiplierFor(rules, { moduleCode: "A1", materialCategoryId: "mc-poly", componentId: "cmp-tray" }), 0.5);
  });
});

function scenarioPool(opts: { assessmentFound?: boolean; scenarioFound?: boolean; existingMultiplier?: boolean } = {}) {
  const { assessmentFound = true, scenarioFound = true, existingMultiplier = false } = opts;
  const writes: Array<{ sql: string; values?: readonly unknown[] }> = [];
  const client = {
    async query(sql: string, values?: readonly unknown[]) {
      writes.push({ sql, values });
      if (sql.includes("FROM nzi_console.command_idempotency")) return { rows: [] };
      if (sql.includes("FROM nzi_console.lca_assessments a JOIN")) return { rows: assessmentFound ? [{ ok: 1 }] : [] };
      if (sql.includes("SELECT 1 FROM nzi_console.lca_scenarios WHERE organisation_id=$1 AND assessment_id=$2 AND scenario_id=$3")) return { rows: scenarioFound ? [{ ok: 1 }] : [] };
      if (sql.includes("SELECT 1 FROM nzi_console.lca_scenarios WHERE organisation_id=$1 AND assessment_id=$2 AND is_baseline")) return { rows: [] };
      if (sql.includes("SELECT multiplier_id FROM nzi_console.lca_scenario_multipliers")) return { rows: existingMultiplier ? [{ multiplier_id: "mul-existing" }] : [] };
      if (sql.startsWith("DELETE FROM nzi_console.lca_scenarios")) return { rows: scenarioFound ? [{ scenario_id: "scn-1" }] : [] };
      if (sql.startsWith("DELETE FROM nzi_console.lca_scenario_multipliers")) return { rows: existingMultiplier ? [{ multiplier_id: "mul-1" }] : [] };
      return { rows: [] };
    },
    release() {},
  };
  return { pool: { connect: async () => client } as never, writes };
}

describe("scenario CRUD (Track C / L5)", () => {
  it("creates a scenario under an assessment", async () => {
    const state = scenarioPool();
    const result = await createLcaScenario(state.pool, { jobId: "job-1", assessmentId: "assess-1", name: "Lightweight tray" }, context("scn-create-1"));
    assert.ok(result.data.scenarioId);
    assert.ok(state.writes.some((w) => w.sql.startsWith("INSERT INTO nzi_console.lca_scenarios")));
  });
  it("rejects a create on an unknown assessment and a blank name", async () => {
    await assert.rejects(() => createLcaScenario(scenarioPool({ assessmentFound: false }).pool, { jobId: "job-1", assessmentId: "missing", name: "x" }, context("scn-miss")), (e: unknown) => e instanceof CommandValidationError && e.issues.some((i) => i.code === "NOT_FOUND"));
    await assert.rejects(() => createLcaScenario(scenarioPool().pool, { jobId: "job-1", assessmentId: "assess-1", name: " " }, context("scn-blank")), CommandValidationError);
  });
  it("updates and deletes a scenario, rejecting an unknown one", async () => {
    await updateLcaScenario(scenarioPool().pool, { jobId: "job-1", assessmentId: "assess-1", scenarioId: "scn-1", name: "Renamed" }, context("scn-upd"));
    const del = await deleteLcaScenario(scenarioPool().pool, { jobId: "job-1", assessmentId: "assess-1", scenarioId: "scn-1" }, context("scn-del"));
    assert.equal(del.data.scenarioId, "scn-1");
    await assert.rejects(() => deleteLcaScenario(scenarioPool({ scenarioFound: false }).pool, { jobId: "job-1", assessmentId: "assess-1", scenarioId: "gone" }, context("scn-del-miss")), CommandValidationError);
  });
});

describe("scenario multiplier rules (Track C / L5)", () => {
  it("inserts a new rule and updates an existing one for the same target", async () => {
    const fresh = scenarioPool();
    await setLcaScenarioMultiplier(fresh.pool, { jobId: "job-1", assessmentId: "assess-1", scenarioId: "scn-1", moduleCode: "A1", multiplier: 0.85 }, context("mul-set-1"));
    assert.ok(fresh.writes.some((w) => w.sql.startsWith("INSERT INTO nzi_console.lca_scenario_multipliers")));
    const repeat = scenarioPool({ existingMultiplier: true });
    await setLcaScenarioMultiplier(repeat.pool, { jobId: "job-1", assessmentId: "assess-1", scenarioId: "scn-1", moduleCode: "A1", multiplier: 0.7 }, context("mul-set-2"));
    assert.ok(repeat.writes.some((w) => w.sql.startsWith("UPDATE nzi_console.lca_scenario_multipliers")));
  });
  it("rejects a negative multiplier, an invalid module, and both category+component set", async () => {
    await assert.rejects(() => setLcaScenarioMultiplier(scenarioPool().pool, { jobId: "job-1", assessmentId: "assess-1", scenarioId: "scn-1", moduleCode: "A1", multiplier: -1 }, context("mul-bad-1")), CommandValidationError);
    await assert.rejects(() => setLcaScenarioMultiplier(scenarioPool().pool, { jobId: "job-1", assessmentId: "assess-1", scenarioId: "scn-1", moduleCode: "Z9" as never, multiplier: 1 }, context("mul-bad-2")), CommandValidationError);
    await assert.rejects(() => setLcaScenarioMultiplier(scenarioPool().pool, { jobId: "job-1", assessmentId: "assess-1", scenarioId: "scn-1", moduleCode: "A1", materialCategoryId: "mc", componentId: "cmp", multiplier: 1 }, context("mul-bad-3")), CommandValidationError);
  });
  it("deletes a rule, rejecting an unknown one", async () => {
    const del = await deleteLcaScenarioMultiplier(scenarioPool({ existingMultiplier: true }).pool, { jobId: "job-1", assessmentId: "assess-1", scenarioId: "scn-1", multiplierId: "mul-1" }, context("mul-del"));
    assert.equal(del.data.multiplierId, "mul-1");
    await assert.rejects(() => deleteLcaScenarioMultiplier(scenarioPool().pool, { jobId: "job-1", assessmentId: "assess-1", scenarioId: "scn-1", multiplierId: "gone" }, context("mul-del-miss")), CommandValidationError);
  });
});

describe("computeLcaScenarioResult (Track C / L5 — applies multipliers then re-summarises)", () => {
  function comparePool() {
    const client = {
      async query(sql: string) {
        if (sql.includes("SELECT functional_unit_value::text,confirmed_quantity::text,assessment_type")) return { rows: [{ functional_unit_value: "1", confirmed_quantity: null, assessment_type: "product" }] };
        if (sql.includes("SELECT line_item_id,module_code,line_label,quantity::text,unit,factor_source,dataset_id,factor_id,client_factor_id,factor_value::text,factor_unit,is_placeholder,material_category_id,component_id")) {
          return { rows: [
            { line_item_id: "li-tray", module_code: "A1", line_label: "rPET tray", quantity: "10", unit: "kg", factor_source: "manual", dataset_id: null, factor_id: null, client_factor_id: null, factor_value: "2", factor_unit: "kgCO2e/kg", is_placeholder: false, material_category_id: "mc-poly", component_id: null },
            { line_item_id: "li-ink", module_code: "A1", line_label: "Ink", quantity: "1", unit: "kg", factor_source: "manual", dataset_id: null, factor_id: null, client_factor_id: null, factor_value: "3", factor_unit: "kgCO2e/kg", is_placeholder: false, material_category_id: "mc-chem", component_id: null },
          ] };
        }
        return { rows: [] };
      },
      release() {},
    };
    return { connect: async () => client } as never;
  }

  it("baseline (no rules) = plain sum; a category rule scales only its lines", async () => {
    const baseline = await withTenantRead(comparePool(), "org-a", (db) => computeLcaScenarioResult(db, "org-a", "job-1", "assess-1", []));
    // tray 10×2 = 20 kg, ink 1×3 = 3 kg → 23 kg → 0.023 t
    assert.ok(Math.abs(baseline.totalTco2e - 0.023) < 1e-9);

    const scaled = await withTenantRead(comparePool(), "org-a", (db) => computeLcaScenarioResult(db, "org-a", "job-1", "assess-1", [
      { moduleCode: "A1", materialCategoryId: "mc-poly", componentId: null, multiplier: 0.5 },
    ]));
    // tray halved: 10 kg, ink unchanged 3 kg → 13 kg → 0.013 t
    assert.ok(Math.abs(scaled.totalTco2e - 0.013) < 1e-9);
  });
});


