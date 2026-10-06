import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { commandGrantForRole, scopeRowIsDiscardable } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { deactivateScopeRow, discardScopeRow, listScopeRows, reactivateScopeRow, withTenantRead } from "../src/index";

/**
 * JW-14 against a real database: a console draft with no saved data is discarded (a true delete, audited); a row with
 * data is refused discard and is deactivated instead — reason required, figures and review kept — and reactivated; a
 * row imported from v7 is locked; a row another row is paired with is in use.
 */
describe("scope-row discard / deactivate / reactivate, against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  const ORG = "demo-nzi-console";
  const JOB = "job-rowstate";
  let database: DisposableDatabase;
  let db: pg.Client;
  let keys = 0;
  const context = (reason?: string) => {
    keys += 1;
    return { organisationId: ORG, actorId: "admin-rs", principal: "staff" as const, idempotencyKey: `rs-${keys}`,
      correlationId: `corr-rs-${keys}`, grant: commandGrantForRole("admin", ORG, "admin-rs"), ...(reason ? { reason } : {}) };
  };
  const row = async (id: string, columns: Record<string, unknown> = {}) => {
    const fields = { organisation_id: ORG, scope_row_id: id, job_id: JOB, scope: "2", source_label: id, report_label: id, level_1: "Scope 2", level_2: "x", category_code: "2.purchased-electricity", ...columns };
    const names = Object.keys(fields);
    await db.query(`INSERT INTO nzi_console.job_scope_rows (${names.join(",")}) VALUES (${names.map((_, i) => `$${i + 1}`).join(",")})`, Object.values(fields));
  };
  const stored = async (id: string) => (await db.query(`SELECT version, enabled, calculated_tco2e::float8 AS calculated, review_status FROM nzi_console.job_scope_rows WHERE scope_row_id = $1`, [id])).rows[0];
  const refusedWith = (code: string) => (error: any) => error.issues?.some((issue: any) => issue.code === code);

  before(async () => {
    database = (await createDisposableDatabase("rowstate"))!;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,$1)`, [ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    await db.query(`INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,'client-rs','Co','active')`, [ORG]);
    await db.query(`INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage,reporting_year,source_system,legacy_db_id)
                    VALUES ($1,$2,'client-rs',1,'crp','CRP','open','Data entry',2026,'nzi-pro-v7','rs-job')`, [ORG, JOB]);
    await row("draft");                                                     // the J000001 shape: no factor, no quantity
    await row("draft-with-factor", { factor_id: "uk-ghg-7_400_4000_5_1", dataset_id: "synthetic-gb-2026" }); // a JW-9 draft
    await row("has-quantity", { quantity: 120 });
    await row("calculated", { quantity: 120, calculated_tco2e: 0.0364 });
    await row("override-only", { override_tco2e: 2, override_reason: "supplier statement" }); // a figure with no quantity
    await row("paired-base");
    await row("paired-companion", { linked_row_id: "paired-base", is_auto_generated: true, auto_pair_kind: "td" });
    await row("v7-row-9", { origin: "migrated", source_system: "nzi-pro-v7", legacy_db_id: "9", calculated_tco2e: 1,
      migrated_record: { qty: 1, uom: "kWh", factor: 1, ghg_unit: "kg", original_id: "f", reported_tco2e: 1, data_source: "manual", enabled: true } });
  });
  after(async () => { await db?.end(); await database?.end(); });

  it("the shared rule: a factor alone is not saved data; a quantity, a figure, a review or v7 origin is", async () => {
    const rows = await withTenantRead(database.pool, ORG, (tenant) => listScopeRows(tenant, JOB));
    const discardable = Object.fromEntries(rows.map((r) => [r.id, scopeRowIsDiscardable(r)]));
    assert.deepEqual(discardable, { "calculated": false, "draft": true, "draft-with-factor": true, "has-quantity": false,
      "override-only": false, "paired-base": true, "paired-companion": true, "v7-row-9": false });
  });

  it("discards a draft with no saved data — gone, and the audit says so", async () => {
    const result = await discardScopeRow(database.pool, { jobId: JOB, rowId: "draft", expectedVersion: 1 }, context());
    assert.equal(result.data.discarded, true);
    assert.equal(await stored("draft"), undefined, "the row is gone");
    const audit = (await db.query(`SELECT action, entity_id FROM nzi_console.audit_events WHERE entity_id = 'draft'`)).rows;
    assert.deepEqual(audit.map((a) => a.action), ["scope_row_discarded"]);
    await discardScopeRow(database.pool, { jobId: JOB, rowId: "draft-with-factor", expectedVersion: 1 }, context());
    assert.equal(await stored("draft-with-factor"), undefined, "a draft carrying only a factor is still a draft");
  });

  it("refuses to discard a row with data, a v7 row, a paired row, or a stale version", async () => {
    await assert.rejects(() => discardScopeRow(database.pool, { jobId: JOB, rowId: "has-quantity", expectedVersion: 1 }, context()), refusedWith("ROW_HAS_DATA"));
    await assert.rejects(() => discardScopeRow(database.pool, { jobId: JOB, rowId: "calculated", expectedVersion: 1 }, context()), refusedWith("ROW_HAS_DATA"));
    await assert.rejects(() => discardScopeRow(database.pool, { jobId: JOB, rowId: "override-only", expectedVersion: 1 }, context()), refusedWith("ROW_HAS_DATA"));
    await assert.rejects(() => discardScopeRow(database.pool, { jobId: JOB, rowId: "v7-row-9", expectedVersion: 1 }, context()), refusedWith("ROW_LOCKED"));
    await assert.rejects(() => discardScopeRow(database.pool, { jobId: JOB, rowId: "paired-base", expectedVersion: 1 }, context()), refusedWith("ROW_IN_USE"));
    await assert.rejects(() => discardScopeRow(database.pool, { jobId: JOB, rowId: "paired-companion", expectedVersion: 1 }, context()), refusedWith("ROW_IN_USE"));
    await assert.rejects(() => discardScopeRow(database.pool, { jobId: JOB, rowId: "has-quantity", expectedVersion: 7 }, context()), /version|conflict/i);
    for (const id of ["has-quantity", "calculated", "v7-row-9", "paired-base", "paired-companion"]) assert.ok(await stored(id), `${id} kept`);
  });

  it("deactivates a row with data only with a reason — figures and review kept — and reactivates it", async () => {
    await assert.rejects(() => deactivateScopeRow(database.pool, { jobId: JOB, rowId: "calculated", expectedVersion: 1 }, context()), refusedWith("REQUIRED"));
    const off = await deactivateScopeRow(database.pool, { jobId: JOB, rowId: "calculated", expectedVersion: 1 }, context("entered twice"));
    assert.deepEqual([off.data.enabled, off.data.version], [false, 2]);
    assert.deepEqual(await stored("calculated"), { version: 2, enabled: false, calculated: 0.0364, review_status: "pending" }, "the calculation is kept");
    const reason = (await db.query(`SELECT reason FROM nzi_console.audit_events WHERE entity_id = 'calculated' AND action = 'scope_row_deactivated'`)).rows[0]?.reason;
    assert.equal(reason, "entered twice");
    await assert.rejects(() => deactivateScopeRow(database.pool, { jobId: JOB, rowId: "calculated", expectedVersion: 2 }, context("again")), refusedWith("ALREADY_INACTIVE"));
    const on = await reactivateScopeRow(database.pool, { jobId: JOB, rowId: "calculated", expectedVersion: 2 }, context());
    assert.deepEqual([on.data.enabled, on.data.version], [true, 3]);
    assert.equal((await stored("calculated")).calculated, 0.0364);
  });

  it("never deactivates a row imported from v7 here", async () => {
    await assert.rejects(() => deactivateScopeRow(database.pool, { jobId: JOB, rowId: "v7-row-9", expectedVersion: 1 }, context("history")), refusedWith("ROW_LOCKED"));
  });
});
