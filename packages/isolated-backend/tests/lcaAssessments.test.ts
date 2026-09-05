import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CommandValidationError, createLcaAssessment, listLcaAssessments, updateLcaAssessment, VersionConflictError, withTenantRead } from "../src/index";

const context = (key: string) => ({ organisationId: "org-a", actorId: "consultant-a", principal: "staff" as const, idempotencyKey: key, correlationId: `corr-${key}` });

const input = {
  jobId: "job-lca-1", assessmentType: "product" as const, name: "6L variant", sku: "SKU-6L",
  functionalUnitValue: 1, functionalUnitUnit: "unit", lifecycleBoundary: "cradle_to_gate" as const,
  includedModules: ["A1", "A2", "A3"] as const,
};

function assessmentPool(opts: { jobFamily?: string | null; existingVersion?: number } = {}) {
  const writes: Array<{ sql: string; values?: readonly unknown[] }> = [];
  const client = {
    async query(sql: string, values?: readonly unknown[]) {
      writes.push({ sql, values });
      if (sql.includes("FROM nzi_console.command_idempotency")) return { rows: [] };
      if (sql.includes("SELECT job_family FROM")) return { rows: opts.jobFamily === undefined ? [{ job_family: "lca" }] : opts.jobFamily === null ? [] : [{ job_family: opts.jobFamily }] };
      if (sql.includes("SELECT client_id FROM nzi_console.jobs")) return { rows: [{ client_id: "client-a" }] };
      if (sql.includes("SELECT version FROM nzi_console.lca_assessments")) return { rows: opts.existingVersion ? [{ version: opts.existingVersion }] : [] };
      return { rows: [] };
    },
    release() {},
  };
  return { pool: { connect: async () => client } as never, writes };
}

describe("createLcaAssessment (Track C / NZC-055)", () => {
  it("creates a version-1 assessment for an LCA job", async () => {
    const state = assessmentPool();
    const result = await createLcaAssessment(state.pool, input as never, context("lca-create-1"));
    assert.equal(result.data.version, 1);
    assert.ok(result.data.assessmentId);
    const insert = state.writes.find((w) => w.sql.includes("INSERT INTO nzi_console.lca_assessments"));
    assert.ok(insert?.values?.includes("6L variant"));
    assert.ok(insert?.values?.includes("client-a"));
  });

  it("also accepts a pcf job (LCA/PCF share one model, NZC-052)", async () => {
    const state = assessmentPool({ jobFamily: "pcf" });
    const result = await createLcaAssessment(state.pool, input as never, context("lca-create-pcf"));
    assert.equal(result.data.version, 1);
  });

  it("rejects a non-LCA/PCF job", async () => {
    await assert.rejects(
      () => createLcaAssessment(assessmentPool({ jobFamily: "crp" }).pool, input as never, context("lca-wrong-family")),
      (error: unknown) => error instanceof CommandValidationError && error.issues.some((issue) => issue.code === "WRONG_FAMILY"),
    );
  });

  it("rejects a blank name, an invalid module code, and a non-positive functional unit value", async () => {
    await assert.rejects(() => createLcaAssessment(assessmentPool().pool, { ...input, name: "  " } as never, context("lca-bad-1")), CommandValidationError);
    await assert.rejects(() => createLcaAssessment(assessmentPool().pool, { ...input, includedModules: ["Z9"] } as never, context("lca-bad-2")), CommandValidationError);
    await assert.rejects(() => createLcaAssessment(assessmentPool().pool, { ...input, functionalUnitValue: 0 } as never, context("lca-bad-3")), CommandValidationError);
  });
});

describe("updateLcaAssessment (Track C / NZC-055)", () => {
  it("bumps the version on a matching expectedVersion", async () => {
    const state = assessmentPool({ existingVersion: 1 });
    const result = await updateLcaAssessment(state.pool, { ...input, assessmentId: "assess-1", expectedVersion: 1 } as never, context("lca-update-1"));
    assert.equal(result.data.version, 2);
  });

  it("a stale expectedVersion is a version conflict", async () => {
    const state = assessmentPool({ existingVersion: 2 });
    await assert.rejects(
      () => updateLcaAssessment(state.pool, { ...input, assessmentId: "assess-1", expectedVersion: 1 } as never, context("lca-update-stale")),
      VersionConflictError,
    );
  });

  it("rejects an unknown assessment", async () => {
    await assert.rejects(
      () => updateLcaAssessment(assessmentPool().pool, { ...input, assessmentId: "assess-missing", expectedVersion: 1 } as never, context("lca-update-missing")),
      (error: unknown) => error instanceof CommandValidationError && error.issues.some((issue) => issue.code === "NOT_FOUND"),
    );
  });
});

describe("listLcaAssessments (Track C)", () => {
  it("maps a row, deriving isPcf from standard + boundary, attaches each assessment's own lines (never another's), scenarios stay empty (no command creates any yet)", async () => {
    const client = {
      async query(sql: string) {
        if (sql.startsWith("BEGIN") || sql.startsWith("SET LOCAL") || sql.includes("set_config") || sql.startsWith("COMMIT")) return { rows: [] };
        if (sql.includes("FROM nzi_console.lca_assessments a")) {
          return { rows: [
            { assessment_id: "assess-pcf", job_id: "job-lca-1", job_number: "J000900", client_id: "client-a", assessment_type: "product", name: "Widget PCF", sku: null, functional_unit_value: "1", functional_unit_unit: "unit", confirmed_quantity: null, confirmed_quantity_unit: "kg", lifecycle_boundary: "cradle_to_gate", included_modules: ["A1", "A2", "A3"], standard: "ISO 14067", reference_year: 2026, geography: "GB", version: 1, review_status: "pending", reviewed_version: null, total_tco2e: "0" },
            { assessment_id: "assess-lca", job_id: "job-lca-1", job_number: "J000900", client_id: "client-a", assessment_type: "product", name: "Full LCA", sku: null, functional_unit_value: "1", functional_unit_unit: "unit", confirmed_quantity: null, confirmed_quantity_unit: "kg", lifecycle_boundary: "cradle_to_grave", included_modules: ["A1", "A2", "A3", "B1"], standard: "ISO 14040", reference_year: 2026, geography: "GB", version: 3, review_status: "approved", reviewed_version: 3, total_tco2e: "42.5" },
          ] };
        }
        if (sql.includes("FROM nzi_console.lca_line_items WHERE assessment_id=ANY")) {
          return { rows: [
            { line_item_id: "line-1", assessment_id: "assess-lca", component_id: null, module_code: "A1", line_label: "Cardboard box", material_category_id: null, quantity: "0.5", unit: "kg", origin_country: null, energy_kwh: null, end_of_life_route: null, factor_source: "unmapped", dataset_id: null, factor_id: null, client_factor_id: null, factor_value: null, factor_unit: null, factor_label: null, factor_match_confidence: null, data_quality: "secondary", is_gap_filled: false, gap_fill_method: null, is_placeholder: false, transport_kgco2e: "0", calculated_kgco2e: null, notes: "" },
          ] };
        }
        return { rows: [] };
      },
      release() {},
    };
    const rows = await withTenantRead({ connect: async () => client } as never, "org-a", (db) => listLcaAssessments(db, "job-lca-1"));
    assert.equal(rows.length, 2);
    assert.equal(rows.find((r) => r.id === "assess-pcf")!.lines.length, 0, "the PCF assessment has no lines of its own");
    assert.equal(rows.find((r) => r.id === "assess-lca")!.lines.length, 1);
    assert.equal(rows.find((r) => r.id === "assess-lca")!.lines[0]!.lineLabel, "Cardboard box");
    const pcf = rows.find((r) => r.id === "assess-pcf")!;
    assert.equal(pcf.isPcf, true);
    assert.deepEqual(pcf.lines, []);
    assert.deepEqual(pcf.scenarios, []);
    const lca = rows.find((r) => r.id === "assess-lca")!;
    assert.equal(lca.isPcf, false);
    assert.equal(lca.totalTco2e, 42.5);
    assert.equal(lca.reviewStatus, "approved");
  });
});
