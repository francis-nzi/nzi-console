import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { commandGrantForRole, type CommandContext, type StaffRole } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { CommandValidationError, updateReportNarrative, validateCrpReport } from "../src/postgresCommands";
import { appendReportVersionEdit, listReportVersionEdits } from "../src/reportVersionEdits";
import { VersionConflictError } from "../src/errors";
import { withTenantRead, withTenantWrite } from "../src/postgres";

/**
 * Client-review loop S3 (0217; BRIEF-reporting-S3-edit-history), against a real database as nzi_console_app:
 * - the table is append-only (SELECT and INSERT, never UPDATE or DELETE), forced-RLS and tenant-isolated;
 * - a staff narrative amend writes exactly one history row - actor, section, before -> after, principal staff, action amend, a time -
 *   in the SAME transaction: a refused or conflicting amend writes none;
 * - the rows of one save share a batch (the schema admits portal and restore rows; S4 and S7 write them);
 * - the read model lists a version's edits in order, with who, what, where and when;
 * - the history is keyed by the REPORT VERSION: a reopened round starts its own, and the job-level section history is not it.
 */
const ORG = "edit-org", OTHER_ORG = "edit-other-org", CLIENT = "edit-client", JOB = "edit-job";
const BODY = (words: string) => `<p>${words} <span data-token="total"></span> in <span data-token="reportingYear"></span>.</p>`;

describe("S3: the per-report-version edit history, against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let count = 0;
  const staff = (actor: string, role: StaffRole): CommandContext => {
    count += 1;
    return { organisationId: ORG, actorId: actor, principal: "staff", idempotencyKey: `edit-${count}`, correlationId: `corr-edit-${count}`, grant: commandGrantForRole(role, ORG, actor) };
  };
  const q = async (sql: string, params: unknown[] = []) => { const db = await database.admin(); try { return (await db.query(sql, params)).rows; } finally { await db.end(); } };
  const version = async (id: string) => Number((await q(`SELECT version FROM nzi_console.report_versions WHERE report_version_id = $1`, [id]))[0].version);
  const frozenBody = async (id: string, key: string) => ((await q(`SELECT narrative FROM nzi_console.report_versions WHERE report_version_id = $1`, [id]))[0].narrative as Array<{ key: string; bodyHtml: string }>).find((e) => e.key === key)!.bodyHtml;
  const edits = (id: string) => withTenantRead(database.pool, ORG, (db) => listReportVersionEdits(db, id));
  const amend = async (id: string, key: string, words: string, actor = "ada", role: StaffRole = "admin") =>
    updateReportNarrative(database.pool, { reportVersionId: id, expectedVersion: await version(id), sectionKey: key, change: "edit", bodyHtml: BODY(words) }, staff(actor, role));

  let snapshots = 0;
  const validated = async (): Promise<string> => {
    snapshots += 1;
    const snapshotId = `edit-snap-${snapshots}`;
    const payload = { jobNumber: "J009907", client: "Edit Co", reportingYear: 2025,
      measurements: [
        { rowId: `r-${snapshots}`, scope: "1", scopeCode: "1", siteId: null, siteLabel: null, sourceLabel: "Gas", tco2e: 10, qualityTier: "measured", factorSet: "demo" },
        { rowId: `g-${snapshots}`, scope: "3", scopeCode: "3.1", siteId: null, siteLabel: null, sourceLabel: "Goods", tco2e: 20, qualityTier: "estimated", factorSet: "demo",
          purchasedGoodsCategoryId: "pg", purchasedGoodsCategoryLabel: "Materials" }],
      target: { baselineYear: 2023, baselineTco2e: 40, interimYear: 2030, interimReductionPercent: 50, netZeroYear: 2045 },
      intensityTarget: { source: "client-target", metric: "turnover", metricLabel: "Turnover", denominatorUnit: "£m", reportingDenominator: 12.5, baselineYear: 2023, baselineIntensity: 6,
        interimYear: 2030, interimReductionPercent: 50, targetYear: 2045, targetReductionPercent: 100, netZeroYear: null, jobId: JOB, version: 1, updatedAt: "2026-01-01T00:00:00.000Z", updatedBy: "ada" },
      annualComparison: [{ year: 2024, values: [{ scope: "1", value: 12 }] }, { year: 2025, values: [{ scope: "1", value: 10 }] }] };
    await q(`INSERT INTO nzi_console.reviewed_crp_snapshots (organisation_id, snapshot_id, job_id, snapshot_version, job_version, data_hash, payload_json, created_by, approved_by, approved_at)
             VALUES ($1, $2, $3, $4, 1, $5, $6::jsonb, 'prep', 'rev', now())`, [ORG, snapshotId, JOB, snapshots, `sha256:${createHash("sha256").update(snapshotId).digest("hex")}`, JSON.stringify(payload)]);
    return (await validateCrpReport(database.pool, { reviewedSnapshotId: snapshotId, manifestVersion: 1 }, staff("rev", "reviewer"))).data.reportVersionId;
  };

  before(async () => {
    database = (await createDisposableDatabase("reportversionedits"))!;
    for (const org of [ORG, OTHER_ORG]) await q(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $1)`, [org]);
    await q(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name) VALUES ($1, 'ada', 'admin', 'active', 'Ada Admin'), ($1, 'rev', 'reviewer', 'active', 'Rev'), ($1, 'prep', 'admin', 'active', 'Prep'), ($1, 'viewer-1', 'viewer', 'active', 'Vee')`, [ORG]);
    await q(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status, currency) VALUES ($1, $2, 'Edit Co', 'active', 'GBP')`, [ORG, CLIENT]);
    await q(`INSERT INTO nzi_console.jobs (organisation_id, job_id, client_id, sequence, job_family, title, status, workflow_stage, reporting_year) VALUES ($1, $2, $3, 9907, 'crp', 'CRP', 'open', 'delivery', 2025)`, [ORG, JOB, CLIENT]);
    await q(`INSERT INTO nzi_console.job_emissions_config (organisation_id, job_id, reporting_from, reporting_to, country_code) VALUES ($1, $2, '2025-01-01', '2025-12-31', 'GB')`, [ORG, JOB]);
    await q(`INSERT INTO nzi_console.portal_users (organisation_id, portal_user_id, client_id, status, display_name) VALUES ($1, 'pu-edit', $2, 'active', 'Pat Portal')`, [ORG, CLIENT]);
  });
  after(async () => { await database?.end(); });

  it("is append-only: the app role may SELECT and INSERT, never UPDATE or DELETE; forced RLS with the tenant policy", async () => {
    const flags = (await q(`SELECT relrowsecurity AS rls, relforcerowsecurity AS forced FROM pg_class WHERE oid = 'nzi_console.report_version_edits'::regclass`))[0];
    assert.deepEqual(flags, { rls: true, forced: true });
    const privilege = async (kind: string) => (await q(`SELECT has_table_privilege('nzi_console_app', 'nzi_console.report_version_edits', $1) AS ok`, [kind]))[0].ok;
    assert.deepEqual([await privilege("SELECT"), await privilege("INSERT"), await privilege("UPDATE"), await privilege("DELETE"), await privilege("TRUNCATE")], [true, true, false, false, false]);
    const id = await validated();
    await amend(id, "executive-summary", "A first change.");
    await assert.rejects(withTenantWrite(database.pool, ORG, (db) => db.query(`UPDATE nzi_console.report_version_edits SET after_html = 'rewritten' WHERE report_version_id = $1`, [id])), /permission denied/);
    await assert.rejects(withTenantWrite(database.pool, ORG, (db) => db.query(`DELETE FROM nzi_console.report_version_edits WHERE report_version_id = $1`, [id])), /permission denied/);
    assert.equal((await edits(id)).length, 1, "the history is intact");
  });

  it("is tenant-isolated: another organisation reads none of it, and cannot write into this one's", async () => {
    const id = await validated();
    await amend(id, "executive-summary", "Tenant-scoped.");
    assert.equal((await withTenantRead(database.pool, OTHER_ORG, (db) => listReportVersionEdits(db, id))).length, 0);
    await assert.rejects(withTenantWrite(database.pool, OTHER_ORG, (db) => appendReportVersionEdit(db, { organisationId: ORG, reportVersionId: id, actorId: "x", principal: "staff", sectionKey: "executive-summary", action: "amend", beforeHtml: "a", afterHtml: "b" })), /row-level security|violates/);
  });

  it("a staff narrative amend writes exactly one row: actor, section, before -> after, principal staff, action amend, a timestamp", async () => {
    const id = await validated();
    const before = await frozenBody(id, "executive-summary");
    const start = Date.now();
    await amend(id, "executive-summary", "Our footprint was");
    const rows = await edits(id);
    assert.equal(rows.length, 1);
    const [row] = rows;
    assert.deepEqual([row!.seq, row!.actorId, row!.actorName, row!.principal, row!.sectionKey, row!.action], [1, "ada", "Ada Admin", "staff", "executive-summary", "amend"]);
    assert.equal(row!.beforeHtml, before, "before = the section's frozen body before the change");
    assert.equal(row!.afterHtml, await frozenBody(id, "executive-summary"), "after = the frozen body now");
    assert.notEqual(row!.beforeHtml, row!.afterHtml);
    assert.match(row!.afterHtml, /Our footprint was/);
    assert.ok(Math.abs(new Date(row!.at).getTime() - start) < 60_000, "stamped when it happened");
    assert.match(row!.batchId, /^[0-9a-f-]{36}$/);
    // Tokenised: the stored words carry token keys, never a figure.
    assert.match(row!.afterHtml, /data-token="total"/);
    assert.doesNotMatch(row!.afterHtml.replace(/<span data-token="[^"]*"><\/span>/g, ""), /\d/);
  });

  it("is written in the amend's own transaction: a refused or conflicting amend leaves no row, and the amend never lands without one", async () => {
    const id = await validated();
    // A stale version, a body that holds a typed figure, a role without report.edit: each refused before or inside the transaction.
    await assert.rejects(updateReportNarrative(database.pool, { reportVersionId: id, expectedVersion: 99, sectionKey: "executive-summary", change: "edit", bodyHtml: BODY("Stale.") }, staff("ada", "admin")), VersionConflictError);
    await assert.rejects(updateReportNarrative(database.pool, { reportVersionId: id, expectedVersion: await version(id), sectionKey: "executive-summary", change: "edit", bodyHtml: "<p>We emitted 13157 tonnes.</p>" }, staff("ada", "admin")), CommandValidationError);
    await assert.rejects(amend(id, "executive-summary", "Not allowed.", "viewer-1", "viewer"));
    assert.equal((await edits(id)).length, 0);
    assert.equal(await version(id), 1, "and nothing moved");
    // A failure AFTER the history insert rolls the amend back with it: the version pointer is the proof the two are one commit.
    const sentinel = await withTenantWrite(database.pool, ORG, async (db) => {
      await appendReportVersionEdit(db, { organisationId: ORG, reportVersionId: id, actorId: "ada", principal: "staff", sectionKey: "executive-summary", action: "amend", beforeHtml: "a", afterHtml: "b" });
      return "inserted-then-rolled-back";
    }).then(() => "committed").catch(() => "rolled-back");
    assert.equal(sentinel, "committed", "control: an insert in a committed transaction persists");
    await q(`DELETE FROM nzi_console.report_version_edits WHERE report_version_id = $1`, [id]);
    await assert.rejects(withTenantWrite(database.pool, ORG, async (db) => {
      await appendReportVersionEdit(db, { organisationId: ORG, reportVersionId: id, actorId: "ada", principal: "staff", sectionKey: "executive-summary", action: "amend", beforeHtml: "a", afterHtml: "b" });
      throw new Error("the surrounding transaction fails");
    }), /surrounding transaction fails/);
    assert.equal((await edits(id)).length, 0, "a history row cannot outlive a rolled-back transaction");
  });

  it("lists a version's edits in order with who, what, where and when - several amends, several sections", async () => {
    const id = await validated();
    await amend(id, "executive-summary", "First.");
    await amend(id, "background", "Second.", "prep", "admin");
    await amend(id, "executive-summary", "Third.");
    const rows = await edits(id);
    assert.deepEqual(rows.map((r) => r.seq), [1, 2, 3]);
    assert.deepEqual(rows.map((r) => r.sectionKey), ["executive-summary", "background", "executive-summary"]);
    assert.equal(rows[2]!.beforeHtml, rows[0]!.afterHtml, "the third change starts from where the first left it");
    assert.ok(rows.every((r) => r.principal === "staff" && r.action === "amend" && new Date(r.at).toString() !== "Invalid Date"));
    assert.equal(new Set(rows.map((r) => r.batchId)).size, 3, "each single-section amend is a batch of one");
  });

  it("the schema admits a multi-section batch, a portal principal and a restore - for S4 and S7 - and refuses anything else", async () => {
    const id = await validated();
    const batchId = "batch-portal-update-1";
    await withTenantWrite(database.pool, ORG, async (db) => {
      for (const sectionKey of ["executive-summary", "background"]) {
        await appendReportVersionEdit(db, { organisationId: ORG, reportVersionId: id, actorId: "pu-edit", principal: "portal", sectionKey, action: "edit", beforeHtml: "<p>before</p>", afterHtml: "<p>after</p>", batchId });
      }
      await appendReportVersionEdit(db, { organisationId: ORG, reportVersionId: id, actorId: "ada", principal: "staff", sectionKey: "background", action: "restore", beforeHtml: "<p>after</p>", afterHtml: "<p>before</p>" });
    });
    const rows = await edits(id);
    assert.deepEqual(rows.map((r) => [r.seq, r.principal, r.action]), [[1, "portal", "edit"], [2, "portal", "edit"], [3, "staff", "restore"]]);
    assert.deepEqual([rows[0]!.batchId, rows[1]!.batchId], [batchId, batchId], "one save, one batch");
    assert.notEqual(rows[2]!.batchId, batchId);
    for (const [field, value] of [["principal", "system"], ["action", "delete"]] as const) {
      await assert.rejects(q(`INSERT INTO nzi_console.report_version_edits (organisation_id, edit_id, report_version_id, seq, actor_id, principal, section_key, action, before_html, after_html, batch_id)
        VALUES ($1, $2, $3, 9, 'x', ${field === "principal" ? "$4" : "'staff'"}, 's', ${field === "action" ? "$4" : "'amend'"}, 'a', 'b', 'b1')`, [ORG, `bad-${field}`, id, value]), /check constraint/);
    }
    await assert.rejects(q(`INSERT INTO nzi_console.report_version_edits (organisation_id, edit_id, report_version_id, seq, actor_id, principal, section_key, action, before_html, after_html, batch_id)
      VALUES ($1, 'dup-seq', $2, 1, 'x', 'staff', 's', 'amend', 'a', 'b', 'b1')`, [ORG, id]), /unique|duplicate/, "(version, seq) is unique");
    assert.deepEqual([rows[0]!.actorName, rows[2]!.actorName], ["Pat Portal", "Ada Admin"], "a portal actor is named from the portal users, a staff actor from the memberships");
  });

  it("is keyed by the report version: two versions of one job keep separate histories, and the job-level section history is a different, shared record", async () => {
    const id = await validated();
    await amend(id, "executive-summary", "Round one wording.");
    await amend(id, "executive-summary", "Round one, again.");
    const other = await validated();
    await amend(other, "executive-summary", "A different version.");
    assert.deepEqual((await edits(id)).map((r) => [r.reportVersionId, r.seq]), [[id, 1], [id, 2]]);
    assert.deepEqual((await edits(other)).map((r) => [r.reportVersionId, r.seq]), [[other, 1]], "seq restarts per version");
    assert.equal(Number((await q(`SELECT count(*)::int AS n FROM nzi_console.report_section_versions WHERE job_id = $1 AND section_key = 'executive-summary'`, [JOB]))[0].n) >= 3,
      true, "report_section_versions holds the job-level working-section history for all of them - it cannot say which version changed");
  });
});
