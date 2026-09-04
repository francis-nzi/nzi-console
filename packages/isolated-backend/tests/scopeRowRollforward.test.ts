import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CommandValidationError, listScopeRowRollforwardPreview, rollforwardScopeRows, withTenantRead } from "../src/index";

const context = (key: string) => ({ organisationId: "org-a", actorId: "consultant-a", principal: "staff" as const, idempotencyKey: key, correlationId: `corr-${key}` });

describe("rollforwardScopeRows (NZC-063)", () => {
  it("copies factor + hierarchy + site forward as a fresh pending row, re-pinning the prior dataset", async () => {
    const writes: Array<{ sql: string; values?: readonly unknown[] }> = [];
    const client = {
      async query(sql: string, values?: readonly unknown[]) {
        writes.push({ sql, values });
        if (sql.includes("FROM nzi_console.command_idempotency")) return { rows: [] };
        if (sql.includes("SELECT job_family FROM")) return { rows: [{ job_family: "crp" }] };
        if (sql.includes("client_id=(SELECT client_id FROM")) return { rows: [{ job_number: "J000700", reporting_year: 2025 }] };
        if (sql.includes("AND NOT EXISTS(SELECT 1 FROM nzi_console.job_scope_rows rf")) {
          return { rows: [{ scope_row_id: "prior-row-1", scope: "1", source_label: "Fleet diesel", report_label: "Fleet diesel", asset_identifier: "AB12 CDE", site_id: "site-mcr", category_code: "1.company-vehicles", purchased_goods_category_id: null, dataset_id: "ds-2025", factor_id: "f-diesel", factor_version: "2025.1", factor_label: "Diesel — LGV", factor_source: "dataset", client_factor_id: null, is_custom_entry: false, apply_pct: "100", unit: "litres", column_text: null }] };
        }
        if (sql.includes("SELECT 1 FROM nzi_console.job_dataset_selections WHERE organisation_id=$1 AND job_id=$2 AND dataset_id=$3")) return { rows: [] };
        if (sql.includes("SELECT 1 FROM nzi_console.emission_factor_datasets WHERE")) return { rows: [{ ok: 1 }] };
        if (sql.includes("FROM nzi_console.client_sites s JOIN")) return { rows: [{ ok: 1 }] };
        return { rows: [] };
      },
      release() {},
    };
    const result = await rollforwardScopeRows({ connect: async () => client } as never, { jobId: "job-2026", priorJobId: "job-2025", rowIds: ["prior-row-1"] }, context("rf-1"));
    assert.equal(result.data.rolledForward, 1);
    assert.equal(result.data.skipped, 0);
    assert.equal(result.data.priorJobNumber, "J000700");
    assert.equal(result.data.createdRowIds.length, 1);

    const pin = writes.find((w) => w.sql.includes("INSERT INTO nzi_console.job_dataset_selections"));
    assert.ok(pin?.values?.some((v) => String(v).includes("NZC-063")), "re-pins the prior dataset with an audited reason");

    const insert = writes.find((w) => w.sql.includes("INSERT INTO nzi_console.job_scope_rows"));
    assert.ok(insert?.sql.includes("rolled_forward_from_row_id"));
    assert.ok(insert?.values?.includes("prior-row-1"), "stamps the origin row id");
    assert.ok(insert?.values?.includes("ds-2025") && insert?.values?.includes("f-diesel"), "pins the prior factor + dataset");
    assert.ok(insert?.values?.includes("AB12 CDE"), "carries the asset identifier forward");
    assert.ok(insert?.values?.includes(null), "quantity is NULL — ready for this year's figure");
    const lineage = JSON.parse(String(insert?.values?.find((v) => typeof v === "string" && v.startsWith("[") && v.includes("Rolled forward"))));
    assert.ok(lineage.some((step: { title: string; detail: string }) => step.title === "Rolled forward" && step.detail.includes("J000700")));
  });

  it("skips a row that has already been rolled forward into this job", async () => {
    const client = {
      async query(sql: string) {
        if (sql.includes("FROM nzi_console.command_idempotency")) return { rows: [] };
        if (sql.includes("SELECT job_family FROM")) return { rows: [{ job_family: "crp" }] };
        if (sql.includes("client_id=(SELECT client_id FROM")) return { rows: [{ job_number: "J000700", reporting_year: 2025 }] };
        if (sql.includes("AND NOT EXISTS(SELECT 1 FROM nzi_console.job_scope_rows rf")) return { rows: [] }; // already rolled forward → excluded
        return { rows: [] };
      },
      release() {},
    };
    const result = await rollforwardScopeRows({ connect: async () => client } as never, { jobId: "job-2026", priorJobId: "job-2025", rowIds: ["prior-row-1"] }, context("rf-2"));
    assert.equal(result.data.rolledForward, 0);
    assert.equal(result.data.skipped, 1);
  });

  it("rejects an unknown or wrong-client prior job", async () => {
    const client = {
      async query(sql: string) {
        if (sql.includes("FROM nzi_console.command_idempotency")) return { rows: [] };
        if (sql.includes("SELECT job_family FROM")) return { rows: [{ job_family: "crp" }] };
        if (sql.includes("client_id=(SELECT client_id FROM")) return { rows: [] };
        return { rows: [] };
      },
      release() {},
    };
    await assert.rejects(
      () => rollforwardScopeRows({ connect: async () => client } as never, { jobId: "job-2026", priorJobId: "job-other-client", rowIds: ["prior-row-1"] }, context("rf-3")),
      (error: unknown) => error instanceof CommandValidationError && error.issues.some((issue) => issue.code === "NOT_FOUND"),
    );
  });
});

describe("listScopeRowRollforwardPreview (NZC-063)", () => {
  it("finds the prior CRP job for this client and flags a moved factor + already-rolled-forward row", async () => {
    const client = {
      async query(sql: string) {
        if (sql.startsWith("BEGIN") || sql.startsWith("SET LOCAL") || sql.includes("set_config") || sql.startsWith("COMMIT")) return { rows: [] };
        if (sql.includes("SELECT client_id,reporting_year,start_date FROM nzi_console.jobs")) return { rows: [{ client_id: "client-a", reporting_year: 2026, start_date: "2026-01-01" }] };
        if (sql.includes("EXISTS(SELECT 1 FROM nzi_console.job_scope_rows r WHERE")) return { rows: [{ job_id: "job-2025", job_number: "J000700", reporting_year: 2025 }] };
        if (sql.includes("r.scope_row_id AS prior_row_id")) {
          return { rows: [
            { prior_row_id: "row-moved", source_label: "Grid electricity", scope: "2", category_code: null, site_id: "site-hq", site_label: "HQ", factor_source: "dataset", factor_label: "UK grid average", pinned_version: "2025.1", current_version: "2026.1", dataset_in_selection: true, already_rolled_forward: false },
            { prior_row_id: "row-done", source_label: "Fleet diesel", scope: "1", category_code: "1.company-vehicles", site_id: null, site_label: null, factor_source: "dataset", factor_label: "Diesel — LGV", pinned_version: "2025.1", current_version: "2025.1", dataset_in_selection: true, already_rolled_forward: true },
          ] };
        }
        return { rows: [] };
      },
      release() {},
    };
    const preview = await withTenantRead({ connect: async () => client } as never, "org-a", (db) => listScopeRowRollforwardPreview(db, "job-2026"));
    assert.equal(preview.priorJob?.number, "J000700");
    assert.equal(preview.rows.length, 2);
    const moved = preview.rows.find((r) => r.priorRowId === "row-moved")!;
    assert.equal(moved.factorVersionMoved, true);
    assert.equal(moved.categoryLabel, "Purchased energy");
    const done = preview.rows.find((r) => r.priorRowId === "row-done")!;
    assert.equal(done.alreadyRolledForward, true);
    assert.equal(done.categoryLabel, "Company Vehicles");
  });

  it("returns no prior job when the client has no earlier CRP job with enabled rows", async () => {
    const client = {
      async query(sql: string) {
        if (sql.startsWith("BEGIN") || sql.startsWith("SET LOCAL") || sql.includes("set_config") || sql.startsWith("COMMIT")) return { rows: [] };
        if (sql.includes("SELECT client_id,reporting_year,start_date FROM nzi_console.jobs")) return { rows: [{ client_id: "client-a", reporting_year: 2026, start_date: "2026-01-01" }] };
        return { rows: [] };
      },
      release() {},
    };
    const preview = await withTenantRead({ connect: async () => client } as never, "org-a", (db) => listScopeRowRollforwardPreview(db, "job-2026"));
    assert.deepEqual(preview, { priorJob: null, rows: [] });
  });
});
