import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { listReportStatusRegister } from "../src/reportStatusRegister";
import { withTenantRead } from "../src/postgres";

/**
 * R-ST1 (RULING-reporting-site-scope), against a real database: every live CRP job at its derived stage, from the records
 * already kept — no stored status. A job with no report version yet is listed at its stage, never dropped (never "0"); a
 * cancelled job, a non-CRP job and another organisation's job are not listed; imported v7 history is its own stage.
 */
const ORG = "rst-org";
const OTHER = "rst-other";

describe("the report pipeline register (R-ST1), against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  const q = async (sql: string, params: unknown[] = []) => { const db = await database.admin(); try { return (await db.query(sql, params)).rows; } finally { await db.end(); } };
  const job = (org: string, jobId: string, sequence: number, extra: { family?: string; status?: string; client?: string } = {}) => q(
    `INSERT INTO nzi_console.jobs (organisation_id, job_id, client_id, sequence, job_family, title, status, workflow_stage, reporting_year) VALUES ($1, $2, $3, $4, $5, 'Job', $6, 'delivery', 2025)`,
    [org, jobId, extra.client ?? "c-1", sequence, extra.family ?? "crp", extra.status ?? "open"]);
  const snapshot = (jobId: string, version: number, approved: boolean) => q(
    `INSERT INTO nzi_console.reviewed_crp_snapshots (organisation_id, snapshot_id, job_id, snapshot_version, job_version, data_hash, payload_json, created_by, approved_by, approved_at)
     VALUES ($1, $2, $3, $4, 1, $5, '{"reportingYear":2025,"measurements":[]}'::jsonb, 'prep', $6, $7)`,
    [ORG, `snap-${jobId}-${version}`, jobId, version, `sha256:${createHash("sha256").update(`${jobId}-${version}`).digest("hex")}`, approved ? "rev" : null, approved ? new Date() : null]);
  const version = (jobId: string, id: string, status: "validated" | "published") => q(
    `INSERT INTO nzi_console.report_versions (organisation_id, report_version_id, job_id, status, manifest_version, reviewed_snapshot_id, data_hash, validated_by)
     SELECT $1, $2, $3, $4, 1, s.snapshot_id, s.data_hash, 'rev' FROM nzi_console.reviewed_crp_snapshots s WHERE s.job_id = $3 ORDER BY s.snapshot_version DESC LIMIT 1`,
    [ORG, id, jobId, status]);
  const stages = async () => Object.fromEntries((await withTenantRead(database.pool, ORG, listReportStatusRegister)).map((row) => [row.jobId, row.reissueReady ? `${row.stage}+reissue` : row.stage]));

  before(async () => {
    database = (await createDisposableDatabase("reportstatus"))!;
    for (const org of [ORG, OTHER]) await q(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $1)`, [org]);
    await q(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name) VALUES ($1, 'owner-a', 'consultant', 'active', 'Owner A')`, [ORG]);
    await q(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status, owner_user_id) VALUES ($1, 'c-1', 'Owned Co', 'active', 'owner-a'), ($1, 'c-2', 'Other Co', 'active', NULL)`, [ORG]);
    await q(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status) VALUES ($1, 'c-1', 'Elsewhere', 'active')`, [OTHER]);
    await job(ORG, "prep", 9501);
    await job(ORG, "review", 9502); await snapshot("review", 1, false);
    await job(ORG, "validate", 9503); await snapshot("validate", 1, true);
    await job(ORG, "publish", 9504); await snapshot("publish", 1, true); await version("publish", "rv-publish", "validated");
    await job(ORG, "client", 9505, { client: "c-2" }); await snapshot("client", 1, true); await version("client", "rv-client", "published");
    await job(ORG, "cancelled", 9506, { status: "cancelled" });
    await job(ORG, "lca", 9507, { family: "lca" });
    await job(OTHER, "foreign", 9508);
  });
  after(async () => { await database?.end(); });

  it("lists every live CRP job at its derived stage — the ones without a version too, never as zero", async () => {
    assert.deepEqual(await stages(), {
      prep: "in-preparation", review: "awaiting-review", validate: "ready-to-validate", publish: "ready-to-publish", client: "awaiting-client",
    }, "cancelled, non-CRP and another organisation's jobs are not listed");
  });

  it("follows the client: a reply from the client last is 'changes requested'; an approval is 'client approved'", async () => {
    await q(`INSERT INTO nzi_console.portal_users (organisation_id, portal_user_id, client_id, status) VALUES ($1, 'pu-1', 'c-2', 'active')`, [ORG]);
    await q(`INSERT INTO nzi_console.portal_report_comments (organisation_id, comment_id, report_version_id, job_id, client_id, author_principal, author_id, author_display_name, body)
             VALUES ($1, 'm-1', 'rv-client', 'client', 'c-2', 'portal', 'pu-1', 'Client User', 'Please correct the site list.')`, [ORG]);
    assert.equal((await stages()).client, "changes-requested");
    await q(`INSERT INTO nzi_console.portal_report_approvals (organisation_id, approval_id, report_version_id, job_id, portal_user_id, client_id) VALUES ($1, 'ap-1', 'rv-client', 'client', 'pu-1', 'c-2')`, [ORG]);
    assert.equal((await stages()).client, "client-approved");
  });

  it("keeps the client's stage while a re-issue waits, and says the re-issue is ready", async () => {
    await snapshot("client", 2, true);
    await version("client", "rv-client-2", "validated");
    assert.equal((await stages()).client, "client-approved+reissue");
  });

  it("gives imported v7 history its own stage instead of 'in preparation'", async () => {
    await job(ORG, "v7", 9509);
    const record = { qty: 1000, uom: "kWh", factor: 0.2, ghg_unit: "kgCO2e", original_id: "7_400_4000_5_1", reported_tco2e: 0.2, data_source: "Company Data", enabled: true };
    await q(`INSERT INTO nzi_console.job_scope_rows (organisation_id,scope_row_id,job_id,scope,source_label,report_label,level_1,level_2,quantity,unit,
               calculated_tco2e,review_status,enabled,origin,migrated_record,source_system,legacy_db_id)
             VALUES ($1,'v7-row','v7','1','Natural gas','Natural gas','Fuels','Gaseous fuels',1000,'kWh',0.2,'pending',true,'migrated',$2::jsonb,'nzi-pro-v7','v7-row')`, [ORG, JSON.stringify(record)]);
    assert.equal((await stages()).v7, "v7-record");
  });

  it("carries the client's owner for the 'My clients' view", async () => {
    const rows = await withTenantRead(database.pool, ORG, listReportStatusRegister);
    assert.equal(rows.find((row) => row.jobId === "prep")?.ownerUserId, "owner-a");
    assert.equal(rows.find((row) => row.jobId === "client")?.ownerUserId, null);
  });
});
