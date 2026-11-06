import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { commandGrantForRole, type CommandContext, type StaffRole } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { approveReviewedCrpSnapshot, CommandValidationError, publishCrpReport, validateCrpReport } from "../src/postgresCommands";
import { approveReportAsClient, finalApproveReport, sendReportToClientReview } from "../src/reportReviewLoop";
import { SeparationOfDutiesError } from "../src/access";
import { AuthorizationError } from "../src/auth";
import { VersionConflictError } from "../src/errors";
import { readApprovalPolicy, readApprovalPolicySafely } from "../src/independentApproval";
import { readOrganisationHistory, setOrganisationApprovalPolicy } from "../src/organisationSettings";
import { withTenantRead, withTenantWrite } from "../src/postgres";

/**
 * The organisation's approval policy (0215, BRIEF-independent-approval-toggle) against a real database — the write path a mock
 * pool cannot judge (#484 passed CI and failed in prod). The setting is the in-app form of REPORT_REQUIRE_INDEPENDENT_APPROVAL:
 * no row = required (unless the server variable relaxes it), a row wins in either direction, only `admin.settings` writes it,
 * every change is audited with old → new and the reason, and a policy that cannot be read is never read as "relaxed".
 */
const ORG = "policy-org";
const OTHER = "policy-other-org";
const CLIENT = "policy-client";
const JOB = "policy-job";

async function withFlag<T>(value: string | undefined, run: () => Promise<T>): Promise<T> {
  const before = process.env.REPORT_REQUIRE_INDEPENDENT_APPROVAL;
  if (value === undefined) delete process.env.REPORT_REQUIRE_INDEPENDENT_APPROVAL; else process.env.REPORT_REQUIRE_INDEPENDENT_APPROVAL = value;
  try { return await run(); } finally {
    if (before === undefined) delete process.env.REPORT_REQUIRE_INDEPENDENT_APPROVAL; else process.env.REPORT_REQUIRE_INDEPENDENT_APPROVAL = before;
  }
}
const isSod = (permission: string) => (error: unknown) => error instanceof SeparationOfDutiesError && error.permission === permission;
const isIssue = (code: string) => (error: unknown) => error instanceof CommandValidationError && error.issues.some((issue) => issue.code === code);

describe("the organisation approval policy, against a real database (0215)", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let count = 0;
  const context = (actor: string, role: StaffRole, reason?: string, organisationId = ORG): CommandContext => {
    count += 1;
    return { organisationId, actorId: actor, principal: "staff", idempotencyKey: `policy-${count}`, correlationId: `corr-policy-${count}`,
      grant: commandGrantForRole(role, organisationId, actor), ...(reason ? { reason } : {}) };
  };
  const q = async (sql: string, params: unknown[] = []) => { const db = await database.admin(); try { return (await db.query(sql, params)).rows; } finally { await db.end(); } };
  const policy = (org = ORG) => withTenantRead(database.pool, org, (db) => readApprovalPolicy(db, org));
  const setPolicy = (required: boolean, expectedVersion: number, actor = "francis", role: StaffRole = "admin", reason = "Two-person team for now") =>
    setOrganisationApprovalPolicy(database.pool, { requireIndependentApproval: required, expectedVersion }, context(actor, role, reason));
  const snapshotRow = async (id: string) => (await q(`SELECT created_by, approved_by, self_approved FROM nzi_console.reviewed_crp_snapshots WHERE snapshot_id = $1`, [id]))[0] as
    { created_by: string; approved_by: string | null; self_approved: boolean };

  let snapshots = 0;
  const snapshot = async (createdBy: string): Promise<string> => {
    snapshots += 1;
    const snapshotId = `policy-snap-${snapshots}`;
    const payload = { jobNumber: "J009903", client: "Policy Co", reportingYear: 2025,
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

  before(async () => {
    database = (await createDisposableDatabase("approvalpolicy"))!;
    for (const org of [ORG, OTHER]) await q(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $1)`, [org]);
    await q(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name) VALUES ($1, 'francis', 'admin', 'active', 'Francis'), ($1, 'crm', 'consultant', 'active', 'Crm'), ($1, 'rev', 'reviewer', 'active', 'Rev')`, [ORG]);
    await q(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status, currency) VALUES ($1, $2, 'Policy Co', 'active', 'GBP')`, [ORG, CLIENT]);
    await q(`INSERT INTO nzi_console.jobs (organisation_id, job_id, client_id, sequence, job_family, title, status, workflow_stage, reporting_year) VALUES ($1, $2, $3, 9903, 'crp', 'CRP', 'open', 'delivery', 2025)`, [ORG, JOB, CLIENT]);
    await q(`INSERT INTO nzi_console.job_emissions_config (organisation_id, job_id, reporting_from, reporting_to, country_code) VALUES ($1, $2, '2025-01-01', '2025-12-31', 'GB')`, [ORG, JOB]);
    await q(`INSERT INTO nzi_console.portal_users (organisation_id, portal_user_id, client_id, status) VALUES ($1, 'pu-policy', $2, 'active')`, [ORG, CLIENT]);
    await q(`INSERT INTO nzi_console.portal_access_grants (organisation_id, grant_id, client_id, portal_user_id, job_id) VALUES ($1, 'g-policy', $2, 'pu-policy', $3)`, [ORG, CLIENT, JOB]);
  });
  after(async () => { await database?.end(); });

  it("defaults to required: no organisation has a row, so nothing is relaxed until someone says so", () => withFlag(undefined, async () => {
    assert.equal((await q(`SELECT count(*)::int AS n FROM nzi_console.organisation_approval_policy WHERE organisation_id <> 'net-zero-international'`))[0].n, 0);
    assert.deepEqual(await policy(), { required: true, source: "server", version: 0, updatedBy: null, updatedAt: null });
  }));

  it("the table is tenant-isolated, forced-RLS, and the app role can read, insert and update but never delete", async () => {
    const flags = (await q(`SELECT relrowsecurity AS rls, relforcerowsecurity AS forced FROM pg_class WHERE oid = 'nzi_console.organisation_approval_policy'::regclass`))[0];
    assert.deepEqual(flags, { rls: true, forced: true });
    const privileges = (await q(`SELECT has_table_privilege('nzi_console_app', 'nzi_console.organisation_approval_policy', 'SELECT') AS s, has_table_privilege('nzi_console_app', 'nzi_console.organisation_approval_policy', 'INSERT') AS i,
      has_table_privilege('nzi_console_app', 'nzi_console.organisation_approval_policy', 'UPDATE') AS u, has_table_privilege('nzi_console_app', 'nzi_console.organisation_approval_policy', 'DELETE') AS d`))[0];
    assert.deepEqual(privileges, { s: true, i: true, u: true, d: false });
    await assert.rejects(withTenantWrite(database.pool, ORG, (db) => db.query(`DELETE FROM nzi_console.organisation_approval_policy`)), /permission denied/);
    await assert.rejects(withTenantWrite(database.pool, ORG, (db) => db.query(`INSERT INTO nzi_console.organisation_approval_policy (organisation_id, require_independent_approval, updated_by) VALUES ($1, false, 'x')`, [OTHER])), /row-level security/);
  });

  it("only admin.settings may set it: a consultant (the CRM) and a reviewer are refused, and nothing is written", async () => {
    for (const [actor, role] of [["crm", "consultant"], ["rev", "reviewer"]] as const) {
      await assert.rejects(setPolicy(false, 0, actor, role), (error: unknown) => error instanceof AuthorizationError && error.permission === "admin.settings");
    }
    assert.equal((await q(`SELECT count(*)::int AS n FROM nzi_console.organisation_approval_policy WHERE organisation_id <> 'net-zero-international'`))[0].n, 0);
  });

  it("with it ON (no row): a preparer is refused approving their own snapshot; the server variable still relaxes it as before", async () => {
    const id = await snapshot("francis");
    await withFlag(undefined, () => assert.rejects(approveReviewedCrpSnapshot(database.pool, { reviewedSnapshotId: id }, context("francis", "admin")), isSod("snapshot.review")));
    await withFlag("true", () => assert.rejects(approveReviewedCrpSnapshot(database.pool, { reviewedSnapshotId: id }, context("francis", "admin")), isSod("snapshot.review")));
    assert.deepEqual(await snapshotRow(id), { created_by: "francis", approved_by: null, self_approved: false });
    // The backstop, unchanged: with no policy row the server variable "false" relaxes it.
    await withFlag("false", async () => {
      const approved = await approveReviewedCrpSnapshot(database.pool, { reviewedSnapshotId: id }, context("francis", "admin"));
      assert.equal(approved.data.selfApproved, true);
    });
  });

  it("a reason is required, the version is pinned, and the first write is version 0", async () => {
    await assert.rejects(setPolicy(false, 0, "francis", "admin", ""), isIssue("REQUIRED"));
    await assert.rejects(setPolicy(false, 3), (error: unknown) => error instanceof VersionConflictError);
    await assert.rejects(setOrganisationApprovalPolicy(database.pool, { requireIndependentApproval: "no" as unknown as boolean, expectedVersion: 0 }, context("francis", "admin", "x")), isIssue("INVALID"));
    assert.equal((await q(`SELECT count(*)::int AS n FROM nzi_console.organisation_approval_policy WHERE organisation_id <> 'net-zero-international'`))[0].n, 0);
  });

  it("an Admin turns it OFF: audited with who, old → new and the reason; the history lists it; the preparer then approves, validates and publishes their own work", () => withFlag(undefined, async () => {
    const result = await setPolicy(false, 0);
    assert.deepEqual(result.data, { organisationId: ORG, version: 1, changed: ["approvalPolicy"], requireIndependentApproval: false });
    const stored = await policy();
    assert.equal(stored.required, false);
    assert.equal(stored.source, "organisation");
    assert.equal(stored.version, 1);
    assert.equal(stored.updatedBy, "francis");

    const event = (await q(`SELECT actor_id, reason, before_json, after_json FROM nzi_console.audit_events WHERE action = 'organisation.approvalPolicy.set' AND entity_id = $1 ORDER BY occurred_at DESC LIMIT 1`, [ORG]))[0];
    assert.equal(event.actor_id, "francis");
    assert.equal(event.reason, "Two-person team for now");
    assert.deepEqual(event.before_json, { requireIndependentApproval: true });
    assert.equal(event.after_json.requireIndependentApproval, false);
    const history = await withTenantRead(database.pool, ORG, (db) => readOrganisationHistory(db, ORG));
    assert.ok(history.some((entry) => entry.action === "organisation.approvalPolicy.set" && entry.reason === "Two-person team for now"), "the organisation history shows it");

    const id = await snapshot("francis");
    const approved = await approveReviewedCrpSnapshot(database.pool, { reviewedSnapshotId: id }, context("francis", "admin"));
    assert.equal(approved.data.selfApproved, true);
    assert.deepEqual(await snapshotRow(id), { created_by: "francis", approved_by: "francis", self_approved: true });
    const validated = await validateCrpReport(database.pool, { reviewedSnapshotId: id, manifestVersion: 1 }, context("francis", "admin"));
    assert.equal(validated.data.releasedByPreparer, true);
    const published = await publishCrpReport(database.pool, { reportVersionId: validated.data.reportVersionId, expectedStatus: "validated", manifestVersion: 1, reviewedSnapshotId: id, expectedVersion: 1 }, context("francis", "admin"));
    assert.equal(published.data.status, "published");
    assert.equal(published.data.releasedByPreparer, true);
    const audit = (await q(`SELECT after_json FROM nzi_console.audit_events WHERE action = 'report_published' AND entity_id = $1`, [validated.data.reportVersionId]))[0];
    assert.equal(audit.after_json.releasedByPreparer, true, "still audited as a self-release");
  }));

  it("OFF still gives nothing to a preparer without the release capability (the CRM gap), and the same value twice is NO_CHANGE", () => withFlag(undefined, async () => {
    const id = await snapshot("crm");
    await assert.rejects(approveReviewedCrpSnapshot(database.pool, { reviewedSnapshotId: id }, context("crm", "consultant")), (error: unknown) => error instanceof AuthorizationError);
    assert.deepEqual(await snapshotRow(id), { created_by: "crm", approved_by: null, self_approved: false });
    await assert.rejects(setPolicy(false, 1), isIssue("NO_CHANGE"));
  }));

  it("turning it back ON enforces again at once, and the policy overrides a server variable set to false", () => withFlag("false", async () => {
    const result = await setPolicy(true, 1, "francis", "admin", "Hired a second reviewer");
    assert.equal(result.data.version, 2);
    const event = (await q(`SELECT before_json, after_json, reason FROM nzi_console.audit_events WHERE action = 'organisation.approvalPolicy.set' AND entity_id = $1 ORDER BY occurred_at DESC LIMIT 1`, [ORG]))[0];
    assert.deepEqual(event.before_json, { requireIndependentApproval: false });
    assert.equal(event.after_json.requireIndependentApproval, true);
    assert.equal(event.reason, "Hired a second reviewer");
    const id = await snapshot("francis");
    await assert.rejects(approveReviewedCrpSnapshot(database.pool, { reviewedSnapshotId: id }, context("francis", "admin")), isSod("snapshot.review"));
    assert.deepEqual(await snapshotRow(id), { created_by: "francis", approved_by: null, self_approved: false });
    // A non-preparer still approves normally.
    const approved = await approveReviewedCrpSnapshot(database.pool, { reviewedSnapshotId: id }, context("rev", "reviewer"));
    assert.equal("selfApproved" in approved.data, false);
  }));

  it("fail-closed: when the policy cannot be read the display answers required, and a command never proceeds as relaxed", async () => {
    // Relaxed first, so a mistaken fall-through to "off" would show.
    await withFlag(undefined, () => setPolicy(false, 2, "francis", "admin", "Back to a small team"));
    const id = await snapshot("francis");
    const failing = { query: async () => { throw new Error("connection lost"); } };
    assert.deepEqual(await readApprovalPolicySafely(failing, ORG), { required: true, source: "unreadable", version: 0, updatedBy: null, updatedAt: null });
    // Unreadable by the app role: its SELECT is revoked (and restored below), so the policy read throws.
    await q(`REVOKE SELECT ON nzi_console.organisation_approval_policy FROM nzi_console_app`);
    try {
      await withFlag("false", async () => {
        await assert.rejects(approveReviewedCrpSnapshot(database.pool, { reviewedSnapshotId: id }, context("francis", "admin")));
        const safe = await withTenantRead(database.pool, ORG, (db) => readApprovalPolicySafely(db, ORG));
        assert.equal(safe.required, true);
        assert.equal(safe.source, "unreadable");
      });
    } finally {
      await q(`GRANT SELECT ON nzi_console.organisation_approval_policy TO nzi_console_app`);
    }
    assert.deepEqual(await snapshotRow(id), { created_by: "francis", approved_by: null, self_approved: false });
  });

  it("one organisation's policy never reaches another's", async () => {
    assert.equal((await withTenantRead(database.pool, OTHER, (db) => readApprovalPolicy(db, OTHER, {}))).source, "server");
    assert.equal((await withTenantRead(database.pool, OTHER, (db) => readApprovalPolicy(db, OTHER, {}))).required, true);
  });

  // S2: the same setting gates the end of the client-review loop. Whoever prepared the snapshot may give the final approval only while
  // independent approval is off; the SELF_APPROVAL_CAPABILITY (report.publish) check stays either way.
  describe("report.finalApprove reads the setting", () => {
    const portalContext = (user: string): CommandContext => { count += 1; return { organisationId: ORG, actorId: user, principal: "portal", portal: { portalUserId: user, clientId: CLIENT }, idempotencyKey: `policy-${count}`, correlationId: `corr-policy-${count}` }; };
    /** Put the organisation's policy at `required`, whatever it was (a no-change set is refused). */
    const ensure = async (required: boolean, reason: string) => {
      const current = await policy();
      if (current.source === "organisation" && current.required === required) return;
      await setPolicy(required, current.source === "organisation" ? current.version : 0, "francis", "admin", reason);
    };
    /** A client-approved round on a snapshot "francis" prepared and "rev" approved (so validate and send are independent either way). */
    const clientApprovedRound = async () => {
      const id = await snapshot("francis");
      await q(`UPDATE nzi_console.reviewed_crp_snapshots SET approved_by = 'rev', approved_at = now() WHERE snapshot_id = $1`, [id]);
      const validated = await validateCrpReport(database.pool, { reviewedSnapshotId: id, manifestVersion: 1 }, context("rev", "reviewer"));
      const reportVersionId = validated.data.reportVersionId;
      const version = async () => Number((await q(`SELECT version FROM nzi_console.report_versions WHERE report_version_id = $1`, [reportVersionId]))[0].version);
      await sendReportToClientReview(database.pool, { reportVersionId, expectedStatus: "validated", expectedVersion: await version() }, context("rev", "reviewer"));
      await approveReportAsClient(database.pool, { reportVersionId, expectedVersion: await version() }, portalContext("pu-policy"));
      return {
        reportVersionId,
        finalApprove: async (actor: string, role: StaffRole) => finalApproveReport(database.pool, { reportVersionId, expectedStatus: "client_approved", manifestVersion: 1, reviewedSnapshotId: id, expectedVersion: await version() }, context(actor, role)),
        status: async () => (await q(`SELECT status FROM nzi_console.report_versions WHERE report_version_id = $1`, [reportVersionId]))[0].status as string,
      };
    };

    it("ON (the default): the snapshot's preparer is refused the final approval and the round stays client_approved; someone else may give it", () => withFlag(undefined, async () => {
      await ensure(true, "Back on for the final-approval test");
      const round = await clientApprovedRound();
      await assert.rejects(round.finalApprove("francis", "admin"), isSod("report.publish"));
      assert.equal(await round.status(), "client_approved");
      const done = await round.finalApprove("rev", "reviewer");
      assert.deepEqual([done.data.status, done.data.final], ["published", true]);
      assert.equal("releasedByPreparer" in done.data, false);
    }));

    it("OFF: the same preparer may give the final approval - audited as a self-release - but a role without the release capability still may not", () => withFlag(undefined, async () => {
      await ensure(false, "One CRM prepares and finally approves");
      const round = await clientApprovedRound();
      const done = await round.finalApprove("francis", "admin");
      assert.deepEqual([done.data.status, done.data.final, done.data.releasedByPreparer], ["published", true, true]);
      const audit = (await q(`SELECT after_json FROM nzi_console.audit_events WHERE action = 'report_final_approved' AND entity_id = $1`, [round.reportVersionId]))[0];
      assert.equal(audit.after_json.releasedByPreparer, true, "still audited");
      const second = await clientApprovedRound();
      await assert.rejects(second.finalApprove("crm", "consultant"), AuthorizationError, "the CRM role holds no report.publish: the capability check stays");
    }));

    it("fail-closed at the final approval: an unreadable setting refuses it even when the server variable says false", async () => {
      await ensure(false, "Relaxed, so a mistaken fall-through would show");
      const round = await clientApprovedRound();
      await q(`REVOKE SELECT ON nzi_console.organisation_approval_policy FROM nzi_console_app`);
      try { await withFlag("false", () => assert.rejects(round.finalApprove("francis", "admin"))); }
      finally { await q(`GRANT SELECT ON nzi_console.organisation_approval_policy TO nzi_console_app`); }
      assert.equal(await round.status(), "client_approved");
    });
  });

  it("NZI's operational setting is OFF: migration 0215 seeds the live organisation relaxed, and no other organisation", async () => {
    const rows = await q(`SELECT organisation_id, require_independent_approval, version, updated_by FROM nzi_console.organisation_approval_policy WHERE updated_by = 'migration:0215'`);
    assert.deepEqual(rows, [{ organisation_id: "net-zero-international", require_independent_approval: false, version: 1, updated_by: "migration:0215" }]);
    const nzi = await withTenantRead(database.pool, "net-zero-international", (db) => readApprovalPolicy(db, "net-zero-international"));
    assert.deepEqual([nzi.required, nzi.source], [false, "organisation"]);
  });

  it("an organisation that never set it defaults to ON", () => withFlag(undefined, async () => {
    const other = await withTenantRead(database.pool, OTHER, (db) => readApprovalPolicy(db, OTHER));
    assert.deepEqual([other.required, other.source], [true, "server"]);
  }));
});
