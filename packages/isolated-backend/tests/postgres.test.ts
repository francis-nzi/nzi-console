import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { listClients, listJobs, listScopeRows, withTenantRead, type Queryable } from "../src/index";

describe("isolated Postgres adapter", () => {
  it("maps canonical client and family-job rows into their screen contracts", async () => {
    const db = {
      query: async (sql: string) => ({ rows: sql.includes("FROM nzi_console.clients")
        ? [{ client_id: "client-a", name: "Synthetic Client", status: "active", sector: "Services", location: "London, UK", owner_name: "A. Owner", member_since: 2026, latest_footprint_tco2e: "1418", yoy_percent: "-7.4", completeness_percent: 92, next_report_due_label: "31 Mar 2027", contact_name: "Synthetic Team", contact_role: "ESG", contact_email: "team@synthetic.invalid", open_jobs: "1", jobs: [{ number: "J000612", year: 2026, status: "Data entry" }] }]
        : [{ job_id: "job-a", client_id: "client-a", client_name: "Synthetic Client", sequence: 612, job_number: "J000612", job_family: "crp", title: "Synthetic CRP", reporting_year: 2026, status: "open", workflow_stage: "Data entry", owner_name: "A. Owner", start_date: "2026-01-01", due_date: "2026-03-31", quote_id: null, progress_percent: 66, detail_json: { kind: "crp", reportingPeriod: "2026", includedScopes: ["1", "2", "3"], reviewedRows: 10, totalRows: 15 } }] }),
    } as Queryable;
    assert.equal((await listClients(db))[0]?.latestFootprint, "1,418 tCO₂e");
    assert.equal((await listJobs(db))[0]?.header.number, "J000612");
  });

  it("sets the runtime role and tenant context inside a read-only transaction", async () => {
    const calls: Array<{ sql: string; values?: readonly unknown[] }> = [];
    const client = { query: async (sql: string, values?: readonly unknown[]) => { calls.push({ sql, values }); return { rows: [] }; }, release: () => undefined };
    const pool = { connect: async () => client };
    await withTenantRead(pool as never, "org-a", async () => "ok");
    assert.deepEqual(calls.map((call) => call.sql), ["BEGIN READ ONLY", "SET LOCAL ROLE nzi_console_app", "SELECT set_config('app.organisation_id', $1, true)", "COMMIT"]);
    assert.deepEqual(calls[2]?.values, ["org-a"]);
  });

  it("maps canonical scope-row evidence without treating missing calculation as zero", async () => {
    const db = { query: async () => ({ rows: [{ scope_row_id: "row-a", job_id: "job-a", scope: "3.1", source_label: "Purchased goods", quantity: "1250.5", unit: "GBP", dataset_id: "dataset-a", factor_id: "factor-a", factor_version: "2026 v1", factor_label: "Synthetic factor", quality_tier: "spend-based", calculated_tco2e: null, override_tco2e: null, override_reason: null, review_status: "pending", version: 3, enabled: true, provenance_json: { source: "synthetic" }, lineage_json: [{ title: "Captured", detail: "Synthetic" }] }] }) } as Queryable;
    const row = (await listScopeRows(db, "job-a"))[0]!;
    assert.equal(row.quantity, 1250.5); assert.equal(row.calculatedTco2e, null); assert.equal(row.qualityTier, "spend-based"); assert.equal(row.version, 3);
  });

  it("rolls back and releases the connection when a read fails", async () => {
    const calls: string[] = [];
    let released = false;
    const client = { query: async (sql: string) => { calls.push(sql); return { rows: [] }; }, release: () => { released = true; } };
    const pool = { connect: async () => client };
    await assert.rejects(() => withTenantRead(pool as never, "org-a", async () => { throw new Error("forced"); }));
    assert.equal(calls.at(-1), "ROLLBACK");
    assert.equal(released, true);
  });
});
