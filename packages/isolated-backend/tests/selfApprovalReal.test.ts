import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { commandGrantForRole, type CapabilityGrant, type CommandContext, type StaffRole } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { approveReviewedCrpSnapshot, approveScopeRow, CommandValidationError, publishCrpReport, validateCrpReport } from "../src/postgresCommands";
import { SeparationOfDutiesError } from "../src/access";
import { withTenantWrite } from "../src/postgres";

/**
 * NZC-022 relaxed (#484) against a real database — the path the mock pool let through (FINDING-self-approval-db-constraint).
 * 0066's CHECK refused approved_by = created_by outright, so a self-approval the command allowed failed in Postgres. 0168 lets
 * the row carry the fact (`self_approved`) and admits approver = preparer only on a row so marked. Here, with the commands
 * running as nzi_console_app (so 0168's column grant is exercised too):
 * - REPORT_REQUIRE_INDEPENDENT_APPROVAL unset / true: the command refuses the preparer, and the CHECK still backstops a direct write;
 * - false: an Admin preparer approves (self_approved, audited), validates and publishes their own snapshot; a preparer without
 *   report.publish is still refused; a non-preparer's approval is never marked self-approved;
 * - the per-row approve, both states — it has no database guard of its own, which this proves rather than assumes.
 */
const ORG = "selfapp-org";
const CLIENT = "selfapp-client";
const JOB = "selfapp-job";

async function withFlag<T>(value: string | undefined, run: () => Promise<T>): Promise<T> {
  const before = process.env.REPORT_REQUIRE_INDEPENDENT_APPROVAL;
  if (value === undefined) delete process.env.REPORT_REQUIRE_INDEPENDENT_APPROVAL; else process.env.REPORT_REQUIRE_INDEPENDENT_APPROVAL = value;
  try { return await run(); } finally {
    if (before === undefined) delete process.env.REPORT_REQUIRE_INDEPENDENT_APPROVAL; else process.env.REPORT_REQUIRE_INDEPENDENT_APPROVAL = before;
  }
}
const isSod = (permission: string) => (error: unknown) => error instanceof SeparationOfDutiesError && error.permission === permission;
const isIssue = (code: string) => (error: unknown) => error instanceof CommandValidationError && error.issues.some((issue) => issue.code === code);
const isCheck = (constraint: string) => (error: unknown) =>
  (error as { code?: string }).code === "23514" && (error as { constraint?: string }).constraint === constraint;

describe("self-approval under the relaxed NZC-022, against a real database (0168)", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let count = 0;
  const context = (actor: string, role: StaffRole, capabilities?: CapabilityGrant[]): CommandContext => {
    count += 1;
    const grant = commandGrantForRole(role, ORG, actor);
    return { organisationId: ORG, actorId: actor, principal: "staff", idempotencyKey: `selfapp-${count}`, correlationId: `corr-selfapp-${count}`,
      grant: capabilities ? { ...grant, capabilities } : grant };
  };
  /** An Admin's grant less report.publish — may freeze and approve, but holds no self-approval capability. */
  const withoutRelease = () => commandGrantForRole("admin", ORG, "prep2").capabilities.filter((grant) => grant.capability !== "report.publish");
  const q = async (sql: string, params: unknown[] = []) => { const db = await database.admin(); try { return (await db.query(sql, params)).rows; } finally { await db.end(); } };
  const snapshotRow = async (id: string) => (await q(`SELECT created_by, approved_by, self_approved FROM nzi_console.reviewed_crp_snapshots WHERE snapshot_id = $1`, [id]))[0] as
    { created_by: string; approved_by: string | null; self_approved: boolean };
  const auditOf = async (action: string, entityId: string) =>
    (await q(`SELECT after_json FROM nzi_console.audit_events WHERE action = $1 AND entity_id = $2 ORDER BY occurred_at DESC LIMIT 1`, [action, entityId]))[0]?.after_json as Record<string, unknown> | undefined;

  let snapshots = 0;
  /** A reviewed snapshot frozen by `createdBy`, not yet approved, whose payload passes the CRP manifest. */
  const snapshot = async (createdBy: string): Promise<string> => {
    snapshots += 1;
    const snapshotId = `selfapp-snap-${snapshots}`;
    const payload = { jobNumber: "J009902", client: "Self Co", reportingYear: 2025,
      measurements: [
        { rowId: `r-${snapshots}`, scope: "1", scopeCode: "1", siteId: null, siteLabel: null, sourceLabel: "Gas", tco2e: 10, qualityTier: "measured", factorSet: "demo" },
        { rowId: `g-${snapshots}`, scope: "3", scopeCode: "3.1", siteId: null, siteLabel: null, sourceLabel: "Goods", tco2e: 20, qualityTier: "estimated", factorSet: "demo",
          purchasedGoodsCategoryId: "pg", purchasedGoodsCategoryLabel: "Materials" }],
      target: { baselineYear: 2023, baselineTco2e: 40, interimYear: 2030, interimReductionPercent: 50, netZeroYear: 2045 },
      intensityTarget: { source: "client-target", metric: "turnover", metricLabel: "Turnover", denominatorUnit: "£m", reportingDenominator: 12.5, baselineYear: 2023, baselineIntensity: 6,
        interimYear: 2030, interimReductionPercent: 50, targetYear: 2045, targetReductionPercent: 100, netZeroYear: null, jobId: JOB, version: 1, updatedAt: "2026-01-01T00:00:00.000Z", updatedBy: "francis" },
      annualComparison: [{ year: 2024, values: [{ scope: "1", value: 12 }] }, { year: 2025, values: [{ scope: "1", value: 10 }] }] };
    await q(`INSERT INTO nzi_console.reviewed_crp_snapshots (organisation_id, snapshot_id, job_id, snapshot_version, job_version, data_hash, payload_json, created_by)
             VALUES ($1, $2, $3, $4, 1, $5, $6::jsonb, $7)`, [ORG, snapshotId, JOB, snapshots, `sha256:${createHash("sha256").update(snapshotId).digest("hex")}`, JSON.stringify(payload), createdBy]);
    return snapshotId;
  };
  let rows = 0;
  /** A live scope row captured and calculated by `preparer`, ready for review (calculated, quality tier set, pending). */
  const scopeRow = async (preparer: string): Promise<string> => {
    rows += 1;
    const rowId = `selfapp-row-${rows}`;
    await q(`INSERT INTO nzi_console.job_scope_rows (organisation_id, scope_row_id, job_id, scope, source_label, report_label, level_1, level_2, quantity, unit, calculated_tco2e, quality_tier, provenance_json)
             VALUES ($1, $2, $3, '2', 'Electricity', 'Electricity', 'UK electricity', 'Grid', 500, 'kWh', 0.1, 'measured', $4::jsonb)`,
      [ORG, rowId, JOB, JSON.stringify({ capturedBy: preparer, calculatedBy: preparer })]);
    return rowId;
  };

  before(async () => {
    database = (await createDisposableDatabase("selfapproval"))!;
    await q(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $1)`, [ORG]);
    await q(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name) VALUES ($1, 'francis', 'admin', 'active', 'Francis'), ($1, 'rev', 'reviewer', 'active', 'Rev'), ($1, 'prep2', 'admin', 'active', 'Prep')`, [ORG]);
    await q(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status, currency) VALUES ($1, $2, 'Self Co', 'active', 'GBP')`, [ORG, CLIENT]);
    await q(`INSERT INTO nzi_console.jobs (organisation_id, job_id, client_id, sequence, job_family, title, status, workflow_stage, reporting_year) VALUES ($1, $2, $3, 9902, 'crp', 'CRP', 'open', 'delivery', 2025)`, [ORG, JOB, CLIENT]);
    await q(`INSERT INTO nzi_console.job_emissions_config (organisation_id, job_id, reporting_from, reporting_to, country_code) VALUES ($1, $2, '2025-01-01', '2025-12-31', 'GB')`, [ORG, JOB]);
  });
  after(async () => { await database?.end(); });

  it("0168: self_approved defaults false, and the CHECKs admit approver = preparer only on a row marked self-approved", async () => {
    const column = (await q(`SELECT data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'nzi_console' AND table_name = 'reviewed_crp_snapshots' AND column_name = 'self_approved'`))[0];
    assert.deepEqual(column, { data_type: "boolean", is_nullable: "NO", column_default: "false" });
    const defs = Object.fromEntries((await q(`SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'nzi_console.reviewed_crp_snapshots'::regclass AND contype = 'c'`))
      .map((row) => [row.conname, row.def]));
    assert.equal(defs.reviewed_crp_snapshots_independent_approval, "CHECK (((approved_by IS NULL) OR (approved_by <> created_by) OR self_approved))");
    assert.equal(defs.reviewed_crp_snapshots_self_approval_is_preparer, "CHECK (((NOT self_approved) OR ((approved_by IS NOT NULL) AND (approved_by = created_by))))");
    const privileges = (await q(`SELECT has_column_privilege('nzi_console_app', 'nzi_console.reviewed_crp_snapshots', 'self_approved', 'UPDATE') AS can`))[0];
    assert.equal(privileges.can, true, "the app role may write it, beside the other approval columns");
    assert.equal((await snapshotRow(await snapshot("francis"))).self_approved, false, "a new snapshot is not self-approved");
  });

  for (const flag of [undefined, "true"]) {
    it(`flag ${flag ?? "unset"}: the command refuses the preparer; a non-preparer approves, never marked self-approved`, () => withFlag(flag, async () => {
      const id = await snapshot("francis");
      await assert.rejects(approveReviewedCrpSnapshot(database.pool, { reviewedSnapshotId: id }, context("francis", "admin")), isSod("snapshot.review"));
      assert.deepEqual(await snapshotRow(id), { created_by: "francis", approved_by: null, self_approved: false });
      const approved = await approveReviewedCrpSnapshot(database.pool, { reviewedSnapshotId: id }, context("rev", "reviewer"));
      assert.equal("selfApproved" in approved.data, false);
      assert.deepEqual(await snapshotRow(id), { created_by: "francis", approved_by: "rev", self_approved: false });
      assert.equal("selfApproved" in ((await auditOf("reviewed_snapshot_approved", id)) ?? {}), false);
    }));
  }

  it("the database still backstops a direct write: approver = preparer unmarked, a marker on someone else's approval, a marker with no approval", async () => {
    const id = await snapshot("francis");
    const write = (set: string) => withTenantWrite(database.pool, ORG, (db) => db.query(`UPDATE nzi_console.reviewed_crp_snapshots SET ${set} WHERE snapshot_id = $1`, [id]));
    await assert.rejects(write(`approved_by = 'francis', approved_at = now()`), isCheck("reviewed_crp_snapshots_independent_approval"));
    await assert.rejects(write(`approved_by = 'rev', approved_at = now(), self_approved = true`), isCheck("reviewed_crp_snapshots_self_approval_is_preparer"));
    await assert.rejects(write(`self_approved = true`), isCheck("reviewed_crp_snapshots_self_approval_is_preparer"));
    assert.deepEqual(await snapshotRow(id), { created_by: "francis", approved_by: null, self_approved: false });
  });

  it("flag false: an Admin preparer approves, validates and publishes their own snapshot (J000663) — marked on the row and in the audit", () => withFlag("false", async () => {
    const id = await snapshot("francis");
    const approved = await approveReviewedCrpSnapshot(database.pool, { reviewedSnapshotId: id }, context("francis", "admin"));
    assert.equal(approved.data.selfApproved, true);
    assert.deepEqual(await snapshotRow(id), { created_by: "francis", approved_by: "francis", self_approved: true });
    assert.equal((await auditOf("reviewed_snapshot_approved", id))?.selfApproved, true);
    // Still one-shot.
    await assert.rejects(approveReviewedCrpSnapshot(database.pool, { reviewedSnapshotId: id }, context("francis", "admin")), isIssue("ALREADY_APPROVED"));

    const validated = await validateCrpReport(database.pool, { reviewedSnapshotId: id, manifestVersion: 1 }, context("francis", "admin"));
    assert.equal(validated.data.releasedByPreparer, true);
    const published = await publishCrpReport(database.pool, { reportVersionId: validated.data.reportVersionId, expectedStatus: "validated", manifestVersion: 1, reviewedSnapshotId: id, expectedVersion: 1 }, context("francis", "admin"));
    assert.equal(published.data.status, "published");
    assert.equal(published.data.releasedByPreparer, true);
    const version = (await q(`SELECT status, validated_by, published_by FROM nzi_console.report_versions WHERE report_version_id = $1`, [validated.data.reportVersionId]))[0];
    assert.deepEqual(version, { status: "published", validated_by: "francis", published_by: "francis" }, "report_versions has no preparer guard to trip");
    assert.equal((await auditOf("report_published", validated.data.reportVersionId))?.releasedByPreparer, true);
  }));

  it("flag false: still requires an approved snapshot before release, whoever releases", () => withFlag("false", async () => {
    const id = await snapshot("francis");
    await assert.rejects(validateCrpReport(database.pool, { reviewedSnapshotId: id, manifestVersion: 1 }, context("francis", "admin")), isIssue("SNAPSHOT_NOT_APPROVED"));
  }));

  it("flag false: a preparer without report.publish is refused, and the row is untouched; a non-preparer's approval is not marked", () => withFlag("false", async () => {
    const id = await snapshot("prep2");
    await assert.rejects(approveReviewedCrpSnapshot(database.pool, { reviewedSnapshotId: id }, context("prep2", "admin", withoutRelease())), isSod("snapshot.review"));
    assert.deepEqual(await snapshotRow(id), { created_by: "prep2", approved_by: null, self_approved: false });
    const approved = await approveReviewedCrpSnapshot(database.pool, { reviewedSnapshotId: id }, context("francis", "admin"));
    assert.equal("selfApproved" in approved.data, false);
    assert.deepEqual(await snapshotRow(id), { created_by: "prep2", approved_by: "francis", self_approved: false });
  }));

  it("per row, flag unset: whoever captured or calculated a row cannot approve it", () => withFlag(undefined, async () => {
    const rowId = await scopeRow("francis");
    await assert.rejects(approveScopeRow(database.pool, { jobId: JOB, rowIds: [rowId], expectedReviewVersion: 1, reviewerNote: "own row" }, context("francis", "admin")), isIssue("INDEPENDENT_REVIEW_REQUIRED"));
    const row = (await q(`SELECT review_status, reviewed_by FROM nzi_console.job_scope_rows WHERE scope_row_id = $1`, [rowId]))[0];
    assert.deepEqual(row, { review_status: "pending", reviewed_by: null });
  }));

  it("per row, flag false: an Admin approves the row they calculated — no database guard refuses it — marked in the audit", () => withFlag("false", async () => {
    const rowId = await scopeRow("francis");
    const approved = await approveScopeRow(database.pool, { jobId: JOB, rowIds: [rowId], expectedReviewVersion: 1, reviewerNote: "own row, relaxed" }, context("francis", "admin"));
    assert.equal(approved.data.selfApproved, true);
    const row = (await q(`SELECT review_status, reviewed_by FROM nzi_console.job_scope_rows WHERE scope_row_id = $1`, [rowId]))[0];
    assert.deepEqual(row, { review_status: "approved", reviewed_by: "francis" });
    const history = (await q(`SELECT decision, reviewer_id FROM nzi_console.scope_row_review_history WHERE scope_row_id = $1`, [rowId]));
    assert.deepEqual(history, [{ decision: "approved", reviewer_id: "francis" }]);
    assert.equal((await auditOf("scope_rows_approved", rowId))?.selfApproved, true);
    // A preparer without the self-approval capability is still refused per row.
    const other = await scopeRow("prep2");
    await assert.rejects(approveScopeRow(database.pool, { jobId: JOB, rowIds: [other], expectedReviewVersion: 1, reviewerNote: "own row" }, context("prep2", "admin", withoutRelease())), isIssue("INDEPENDENT_REVIEW_REQUIRED"));
  }));
});
