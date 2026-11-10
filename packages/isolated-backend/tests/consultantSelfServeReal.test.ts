import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { commandGrantForRole, PERMISSION_MATRIX_VERSION, type CommandContext, type StaffRole } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { approveReviewedCrpSnapshot, validateCrpReport } from "../src/postgresCommands";
import { approveReportAsClient, finalApproveReport, sendReportToClientReview } from "../src/reportReviewLoop";
import { setOrganisationApprovalPolicy } from "../src/organisationSettings";
import { SeparationOfDutiesError } from "../src/access";
import { AuthorizationError } from "../src/auth";
import { readApprovalPolicy } from "../src/independentApproval";
import { withTenantRead } from "../src/postgres";

/**
 * The consultant CRM's self-serve release (matrix v12, 0216; RULING-consultant-report-capabilities), against a real database, through
 * the real commands as nzi_console_app:
 * - the consultant now holds snapshot.review and report.publish, so with a second person involved the whole path is theirs:
 *   approve the snapshot -> validate -> send to client review -> final-approve;
 * - independent approval ON (every organisation's default): a consultant still cannot approve or release their OWN work (NZC-022);
 * - OFF (NZI): the same consultant approves their own snapshot, validates and finally approves their own report, each recorded as a
 *   self-release in its audit event;
 * - a role holding neither capability (viewer, finance) is refused at every step, OFF as much as ON.
 */
const ORG = "cs-org", CLIENT = "cs-client", JOB = "cs-job";

describe("a consultant CRM approves and releases a report, under the independent-approval setting (v12)", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let count = 0;
  const staff = (actor: string, role: StaffRole, reason?: string): CommandContext => {
    count += 1;
    return { organisationId: ORG, actorId: actor, principal: "staff", idempotencyKey: `cs-${count}`, correlationId: `corr-cs-${count}`, grant: commandGrantForRole(role, ORG, actor), ...(reason ? { reason } : {}) };
  };
  const portal = (): CommandContext => { count += 1; return { organisationId: ORG, actorId: "pu-cs", principal: "portal", portal: { portalUserId: "pu-cs", clientId: CLIENT }, idempotencyKey: `cs-${count}`, correlationId: `corr-cs-${count}` }; };
  const q = async (sql: string, params: unknown[] = []) => { const db = await database.admin(); try { return (await db.query(sql, params)).rows; } finally { await db.end(); } };
  const setIndependent = async (required: boolean) => {
    const current = await withTenantRead(database.pool, ORG, (db) => readApprovalPolicy(db, ORG, {}));
    if (current.source === "organisation" && current.required === required) return;
    await setOrganisationApprovalPolicy(database.pool, { requireIndependentApproval: required, expectedVersion: current.source === "organisation" ? current.version : 0 }, staff("admin-1", "admin", "test setup"));
  };

  let snapshots = 0;
  /** An unapproved snapshot prepared by `createdBy` whose payload passes the CRP manifest. */
  const snapshot = async (createdBy: string): Promise<string> => {
    snapshots += 1;
    const snapshotId = `cs-snap-${snapshots}`;
    const payload = { jobNumber: "J009906", client: "Self Serve Co", reportingYear: 2025,
      measurements: [
        { rowId: `r-${snapshots}`, scope: "1", scopeCode: "1", siteId: null, siteLabel: null, sourceLabel: "Gas", tco2e: 10, qualityTier: "measured", factorSet: "demo" },
        { rowId: `g-${snapshots}`, scope: "3", scopeCode: "3.1", siteId: null, siteLabel: null, sourceLabel: "Goods", tco2e: 20, qualityTier: "estimated", factorSet: "demo",
          purchasedGoodsCategoryId: "pg", purchasedGoodsCategoryLabel: "Materials" }],
      target: { baselineYear: 2023, baselineTco2e: 40, interimYear: 2030, interimReductionPercent: 50, netZeroYear: 2045 },
      intensityTarget: { source: "client-target", metric: "turnover", metricLabel: "Turnover", denominatorUnit: "£m", reportingDenominator: 12.5, baselineYear: 2023, baselineIntensity: 6,
        interimYear: 2030, interimReductionPercent: 50, targetYear: 2045, targetReductionPercent: 100, netZeroYear: null, jobId: JOB, version: 1, updatedAt: "2026-01-01T00:00:00.000Z", updatedBy: "admin-1" },
      annualComparison: [{ year: 2024, values: [{ scope: "1", value: 12 }] }, { year: 2025, values: [{ scope: "1", value: 10 }] }] };
    await q(`INSERT INTO nzi_console.reviewed_crp_snapshots (organisation_id, snapshot_id, job_id, snapshot_version, job_version, data_hash, payload_json, created_by)
             VALUES ($1, $2, $3, $4, 1, $5, $6::jsonb, $7)`, [ORG, snapshotId, JOB, snapshots, `sha256:${createHash("sha256").update(snapshotId).digest("hex")}`, JSON.stringify(payload), createdBy]);
    return snapshotId;
  };
  const approve = (id: string, actor: string, role: StaffRole) => approveReviewedCrpSnapshot(database.pool, { reviewedSnapshotId: id }, staff(actor, role));
  const validate = (id: string, actor: string, role: StaffRole) => validateCrpReport(database.pool, { reviewedSnapshotId: id, manifestVersion: 1 }, staff(actor, role));
  const versionOf = async (id: string) => Number((await q(`SELECT version FROM nzi_console.report_versions WHERE report_version_id = $1`, [id]))[0].version);
  /** Send for review and have the client approve it, as the releasing actor. */
  const toClientApproved = async (reportVersionId: string, actor: string, role: StaffRole) => {
    await sendReportToClientReview(database.pool, { reportVersionId, expectedStatus: "validated", expectedVersion: await versionOf(reportVersionId) }, staff(actor, role));
    await approveReportAsClient(database.pool, { reportVersionId, expectedVersion: await versionOf(reportVersionId) }, portal());
  };
  const finalApprove = async (reportVersionId: string, snapshotId: string, actor: string, role: StaffRole) =>
    finalApproveReport(database.pool, { reportVersionId, expectedStatus: "client_approved", manifestVersion: 1, reviewedSnapshotId: snapshotId, expectedVersion: await versionOf(reportVersionId) }, staff(actor, role));
  const isSod = (permission: string) => (error: unknown) => error instanceof SeparationOfDutiesError && error.permission === permission;

  before(async () => {
    database = (await createDisposableDatabase("consultantselfserve"))!;
    await q(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $1)`, [ORG]);
    await q(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name) VALUES ($1, 'admin-1', 'admin', 'active', 'Admin'), ($1, 'crm', 'consultant', 'active', 'Crm'), ($1, 'crm2', 'consultant', 'active', 'Crm Two'), ($1, 'fin', 'finance', 'active', 'Fin'), ($1, 'view', 'viewer', 'active', 'View')`, [ORG]);
    await q(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status, currency, owner_user_id) VALUES ($1, $2, 'Self Serve Co', 'active', 'GBP', 'crm')`, [ORG, CLIENT]);
    await q(`INSERT INTO nzi_console.jobs (organisation_id, job_id, client_id, sequence, job_family, title, status, workflow_stage, reporting_year) VALUES ($1, $2, $3, 9906, 'crp', 'CRP', 'open', 'delivery', 2025)`, [ORG, JOB, CLIENT]);
    await q(`INSERT INTO nzi_console.job_emissions_config (organisation_id, job_id, reporting_from, reporting_to, country_code) VALUES ($1, $2, '2025-01-01', '2025-12-31', 'GB')`, [ORG, JOB]);
    await q(`INSERT INTO nzi_console.portal_users (organisation_id, portal_user_id, client_id, status) VALUES ($1, 'pu-cs', $2, 'active')`, [ORG, CLIENT]);
    await q(`INSERT INTO nzi_console.portal_access_grants (organisation_id, grant_id, client_id, portal_user_id, job_id) VALUES ($1, 'g-cs', $2, 'pu-cs', $3)`, [ORG, CLIENT, JOB]);
  });
  after(async () => { await database?.end(); });

  it("the matrix the database serves matches the code: the consultant holds both at scope 'all' in the latest version", async () => {
    const rows = await q(`SELECT capability, scope FROM nzi_console.staff_role_capabilities WHERE role_id = 'consultant' AND capability IN ('snapshot.review', 'report.publish')
      AND matrix_version = (SELECT max(matrix_version) FROM nzi_console.staff_capability_matrix_versions) ORDER BY capability`);
    assert.deepEqual(rows, [{ capability: "report.publish", scope: "all" }, { capability: "snapshot.review", scope: "all" }]);
    // The version the code is on (v12 when this was written; v13 added task.manage and left these two alone).
    assert.equal(Number((await q(`SELECT max(matrix_version)::int AS v FROM nzi_console.staff_capability_matrix_versions`))[0].v), PERMISSION_MATRIX_VERSION);
  });

  it("ON (the default): a consultant releases a report from another consultant's work - approve, validate, send, final-approve - but not from their own", async () => {
    await setIndependent(true);
    const mine = await snapshot("crm");
    await assert.rejects(approve(mine, "crm", "consultant"), isSod("snapshot.review"), "cannot approve their own snapshot");
    await approve(mine, "crm2", "consultant");
    await assert.rejects(validate(mine, "crm", "consultant"), isSod("report.publish"), "the preparer cannot validate it, even once it is approved");
    const validated = await validate(mine, "crm2", "consultant");
    assert.equal("releasedByPreparer" in validated.data, false, "a second person's release is an ordinary one");
    const id = validated.data.reportVersionId;
    await toClientApproved(id, "crm2", "consultant");
    await assert.rejects(finalApprove(id, mine, "crm", "consultant"), isSod("report.publish"), "nor give the final approval to their own report");
    const done = await finalApprove(id, mine, "crm2", "consultant");
    assert.deepEqual([done.data.status, done.data.final], ["published", true]);
    assert.equal("releasedByPreparer" in done.data, false);
  });

  it("OFF (NZI): the same consultant approves their own snapshot, validates and finally approves their own report - each audited as a self-release", async () => {
    await setIndependent(false);
    const mine = await snapshot("crm");
    const approved = await approve(mine, "crm", "consultant");
    assert.equal(approved.data.selfApproved, true);
    assert.deepEqual((await q(`SELECT created_by, approved_by, self_approved FROM nzi_console.reviewed_crp_snapshots WHERE snapshot_id = $1`, [mine]))[0], { created_by: "crm", approved_by: "crm", self_approved: true });
    const validated = await validate(mine, "crm", "consultant");
    assert.equal(validated.data.releasedByPreparer, true);
    const id = validated.data.reportVersionId;
    await toClientApproved(id, "crm", "consultant");
    const done = await finalApprove(id, mine, "crm", "consultant");
    assert.deepEqual([done.data.status, done.data.final, done.data.releasedByPreparer], ["published", true, true]);
    for (const [action, entity] of [["report_validated", id], ["report_final_approved", id]] as const) {
      assert.equal((await q(`SELECT after_json FROM nzi_console.audit_events WHERE action = $1 AND entity_id = $2`, [action, entity]))[0].after_json.releasedByPreparer, true, `${action} is marked`);
    }
    assert.equal((await q(`SELECT after_json FROM nzi_console.audit_events WHERE action = 'reviewed_snapshot_approved' AND entity_id = $1`, [mine]))[0].after_json.selfApproved, true, "the snapshot approval is marked");
  });

  it("a role holding neither capability (finance, viewer) is refused at every step, whichever way the setting is set", async () => {
    for (const required of [true, false]) {
      await setIndependent(required);
      const id = await snapshot("crm");
      await q(`UPDATE nzi_console.reviewed_crp_snapshots SET approved_by = 'crm2', approved_at = now() WHERE snapshot_id = $1`, [id]);
      const validated = await validate(id, "crm2", "consultant");
      const reportVersionId = validated.data.reportVersionId;
      for (const [actor, role] of [["fin", "finance"], ["view", "viewer"]] as const) {
        const other = await snapshot("crm");
        await assert.rejects(approve(other, actor, role), AuthorizationError, `${role} approve (independent ${required})`);
        await assert.rejects(validate(id, actor, role), AuthorizationError, `${role} validate`);
        await assert.rejects(sendReportToClientReview(database.pool, { reportVersionId, expectedStatus: "validated", expectedVersion: await versionOf(reportVersionId) }, staff(actor, role)), AuthorizationError, `${role} send`);
        assert.equal((await q(`SELECT approved_by FROM nzi_console.reviewed_crp_snapshots WHERE snapshot_id = $1`, [other]))[0].approved_by, null);
      }
      await toClientApproved(reportVersionId, "crm2", "consultant");
      for (const [actor, role] of [["fin", "finance"], ["view", "viewer"]] as const) await assert.rejects(finalApprove(reportVersionId, id, actor, role), AuthorizationError, `${role} final-approve`);
      assert.equal((await q(`SELECT status FROM nzi_console.report_versions WHERE report_version_id = $1`, [reportVersionId]))[0].status, "client_approved");
    }
  });
});
