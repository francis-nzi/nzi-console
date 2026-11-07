import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { commandGrantForRole, validateCommand, type CommandContext, type ReportNarrativeElement, type StaffRole } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { CommandValidationError, validateCrpReport } from "../src/postgresCommands";
import { approveReportAsClient, finalApproveReport, reopenReport, restoreReportVersion, sendReportToClientReview, updateReportAsClient } from "../src/reportReviewLoop";
import { listReportVersionChain, previewPriorVersion } from "../src/reportVersionChain";
import { listReportVersionEdits } from "../src/reportVersionEdits";
import { AuthorizationError } from "../src/auth";
import { VersionConflictError } from "../src/errors";
import { withTenantRead } from "../src/postgres";

/**
 * Client-review loop S7 (report.restoreVersion), against a real database, through the real S1/S4 commands as nzi_console_app:
 * reopen -> the client edits -> the CRM restores an earlier round's WORDS into the round in flight.
 * - the earlier version's wording is carried onto the sections this round draws and re-frozen; one version bump; a `restore` history row per
 *   changed section (before -> after) in one batch; the plan, the snapshot and every other column are untouched; the earlier round is untouched;
 * - the target allow-list (validated / in_client_review only); the source must be a closed version of the same job and scope, not this one;
 * - the version pin; all or nothing; nothing to restore moves nothing; who may (report.publish);
 * - the chain lists in order and an earlier version previews read-only.
 */
const ORG = "rvr-org", CLIENT = "rvr-client";
const BODY = (words: string) => `<p>${words} <span data-token="total"></span> in <span data-token="reportingYear"></span>.</p>`;

describe("S7: restoring an earlier version's wording into the round in flight, against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let count = 0;
  const staff = (actor: string, role: StaffRole): CommandContext => { count += 1; return { organisationId: ORG, actorId: actor, principal: "staff", idempotencyKey: `rvr-${count}`, correlationId: `corr-rvr-${count}`, grant: commandGrantForRole(role, ORG, actor) }; };
  const portal = (user = "rv-1"): CommandContext => { count += 1; return { organisationId: ORG, actorId: user, principal: "portal", portal: { portalUserId: user, clientId: CLIENT }, idempotencyKey: `rvr-${count}`, correlationId: `corr-rvr-${count}` }; };
  const q = async (sql: string, params: unknown[] = []) => { const db = await database.admin(); try { return (await db.query(sql, params)).rows; } finally { await db.end(); } };
  const row = async (id: string) => (await q(`SELECT * FROM nzi_console.report_versions WHERE report_version_id = $1`, [id]))[0]!;
  const version = async (id: string) => Number((await row(id)).version);
  const narrative = async (id: string) => (await row(id)).narrative as ReportNarrativeElement[];
  const body = async (id: string, key: string) => (await narrative(id)).find((e) => e.key === key)!.bodyHtml;
  const edits = (id: string) => withTenantRead(database.pool, ORG, (db) => listReportVersionEdits(db, id));
  const restore = async (id: string, from: string, expectedVersion?: number, role: StaffRole = "reviewer") =>
    restoreReportVersion(database.pool, { reportVersionId: id, fromReportVersionId: from, expectedVersion: expectedVersion ?? await version(id) }, staff("rev", role));
  const clientEdit = async (id: string, sections: Array<[string, string]>) =>
    updateReportAsClient(database.pool, { reportVersionId: id, expectedVersion: await version(id), edits: sections.map(([sectionKey, bodyHtml]) => ({ sectionKey, bodyHtml })) }, portal());
  const refusedWith = (code: string) => (error: unknown) => error instanceof CommandValidationError && error.issues.some((issue) => issue.code === code);

  let snapshots = 0;
  const approvedSnapshot = async (jobId: string): Promise<string> => {
    snapshots += 1;
    const snapshotId = `rvr-snap-${snapshots}`;
    const payload = { jobNumber: "J009913", client: "Restore Co", reportingYear: 2025,
      measurements: [
        { rowId: `r-${snapshots}`, scope: "1", scopeCode: "1", siteId: null, siteLabel: null, sourceLabel: "Gas", tco2e: 10, qualityTier: "measured", factorSet: "demo" },
        { rowId: `g-${snapshots}`, scope: "3", scopeCode: "3.1", siteId: null, siteLabel: null, sourceLabel: "Goods", tco2e: 20, qualityTier: "estimated", factorSet: "demo", purchasedGoodsCategoryId: "pg", purchasedGoodsCategoryLabel: "Materials" }],
      target: { baselineYear: 2023, baselineTco2e: 40, interimYear: 2030, interimReductionPercent: 50, netZeroYear: 2045 },
      intensityTarget: { source: "client-target", metric: "turnover", metricLabel: "Turnover", denominatorUnit: "£m", reportingDenominator: 12.5, baselineYear: 2023, baselineIntensity: 6,
        interimYear: 2030, interimReductionPercent: 50, targetYear: 2045, targetReductionPercent: 100, netZeroYear: null, jobId, version: 1, updatedAt: "2026-01-01T00:00:00.000Z", updatedBy: "ada" },
      annualComparison: [{ year: 2024, values: [{ scope: "1", value: 12 }] }, { year: 2025, values: [{ scope: "1", value: 10 }] }] };
    await q(`INSERT INTO nzi_console.reviewed_crp_snapshots (organisation_id, snapshot_id, job_id, snapshot_version, job_version, data_hash, payload_json, created_by, approved_by, approved_at)
             VALUES ($1, $2, $3, $4, 1, $5, $6::jsonb, 'prep', 'rev', now())`, [ORG, snapshotId, jobId, snapshots, `sha256:${createHash("sha256").update(snapshotId).digest("hex")}`, JSON.stringify(payload)]);
    return snapshotId;
  };
  const validated = async (jobId: string) => { const snapshotId = await approvedSnapshot(jobId); return { snapshotId, id: (await validateCrpReport(database.pool, { reviewedSnapshotId: snapshotId, manifestVersion: 1 }, staff("rev", "reviewer"))).data.reportVersionId }; };
  const send = async (id: string) => sendReportToClientReview(database.pool, { reportVersionId: id, expectedStatus: "validated", expectedVersion: await version(id) }, staff("rev", "reviewer"));
  /** Round 1 issued (published, final) -> reopened as round 2 in_client_review, carrying round 1's words. */
  let jobs = 0;
  const freshJob = async (): Promise<string> => {
    jobs += 1;
    const job = `rvr-job-${jobs}`;
    await q(`INSERT INTO nzi_console.jobs (organisation_id, job_id, client_id, sequence, job_family, title, status, workflow_stage, reporting_year) VALUES ($1, $2, $3, $4, 'crp', 'CRP', 'open', 'delivery', 2025)`, [ORG, job, CLIENT, 9100 + jobs]);
    await q(`INSERT INTO nzi_console.job_emissions_config (organisation_id, job_id, reporting_from, reporting_to, country_code) VALUES ($1, $2, '2025-01-01', '2025-12-31', 'GB')`, [ORG, job]);
    await q(`INSERT INTO nzi_console.portal_access_grants (organisation_id, grant_id, client_id, portal_user_id, job_id) VALUES ($1, $2, $3, 'rv-1', $4)`, [ORG, `g-${job}`, CLIENT, job]);
    return job;
  };
  const secondRound = async (jobId?: string) => {
    jobId ??= await freshJob();
    const first = await validated(jobId);
    await send(first.id);
    await approveReportAsClient(database.pool, { reportVersionId: first.id, expectedVersion: await version(first.id) }, portal());
    await finalApproveReport(database.pool, { reportVersionId: first.id, expectedStatus: "client_approved", manifestVersion: 1, reviewedSnapshotId: first.snapshotId, expectedVersion: await version(first.id) }, staff("rev", "reviewer"));
    const second = (await reopenReport(database.pool, { reportVersionId: first.id, expectedStatus: "published", expectedVersion: await version(first.id) }, { ...staff("rev", "reviewer"), reason: "Client asked for another round." })).data.reportVersionId as string;
    return { first, second, jobId };
  };

  before(async () => {
    database = (await createDisposableDatabase("reportversionrestore"))!;
    await q(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $1)`, [ORG]);
    await q(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name) VALUES ($1, 'ada', 'admin', 'active', 'Ada'), ($1, 'rev', 'reviewer', 'active', 'Rev'), ($1, 'prep', 'admin', 'active', 'Prep'), ($1, 'vw', 'viewer', 'active', 'View')`, [ORG]);
    await q(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status, currency) VALUES ($1, $2, 'Restore Co', 'active', 'GBP')`, [ORG, CLIENT]);
    await q(`INSERT INTO nzi_console.portal_users (organisation_id, portal_user_id, client_id, status, display_name) VALUES ($1, 'rv-1', $2, 'active', 'Rae')`, [ORG, CLIENT]);
  });
  after(async () => { await database?.end(); });

  it("restoring copies the earlier round's wording into the round in flight: re-frozen, ONE version bump, a restore row per changed section in one batch - the plan, the snapshot and the earlier round untouched", async () => {
    const { first, second, jobId } = await secondRound();
    const issued = { exec: await body(first.id, "executive-summary"), background: await body(first.id, "background"), net: await body(first.id, "net-zero-commitment") };
    assert.equal(await body(second, "executive-summary"), issued.exec, "reopen carried round 1's words");
    await clientEdit(second, [["executive-summary", BODY("Round two wording:")], ["background", BODY("Reworked background:")]]);
    assert.equal(await body(second, "executive-summary"), BODY("Round two wording:"));

    const before = await row(second);
    const firstBefore = await row(first.id);
    const sectionRows = Number((await q(`SELECT count(*)::int AS n FROM nzi_console.report_section_versions WHERE job_id = $1`, [jobId]))[0].n);
    const result = await restore(second, first.id);
    assert.deepEqual(result.data.changedSections, ["executive-summary", "background"], "only the sections that differ");
    assert.equal(result.data.fromRevision, 1);
    const after = await row(second);
    assert.equal(after.version, before.version + 1, "one version bump");
    assert.equal(result.data.version, after.version);
    assert.equal(after.status, "in_client_review", "restoring does not change the round's status");
    assert.deepEqual([await body(second, "executive-summary"), await body(second, "background"), await body(second, "net-zero-commitment")], [issued.exec, issued.background, issued.net]);
    // Words only: nothing else on the row moved.
    for (const column of ["section_plan", "reviewed_snapshot_id", "data_hash", "manifest_version", "scope_key", "revision", "supersedes_report_version_id", "signee_name", "issuer_display_name"]) {
      assert.deepEqual(after[column], before[column], `${column} must not move`);
    }
    assert.deepEqual((await narrative(second)).map((e) => e.key), (before.narrative as ReportNarrativeElement[]).map((e) => e.key), "the current plan's order and membership stand");

    const rows = (await edits(second)).filter((edit) => edit.action === "restore");
    assert.deepEqual(rows.map((r) => [r.principal, r.action, r.actorId, r.sectionKey]), [["staff", "restore", "rev", "executive-summary"], ["staff", "restore", "rev", "background"]]);
    assert.deepEqual([rows[0]!.beforeHtml, rows[0]!.afterHtml, rows[1]!.beforeHtml, rows[1]!.afterHtml], [BODY("Round two wording:"), issued.exec, BODY("Reworked background:"), issued.background]);
    assert.equal(rows[0]!.batchId, rows[1]!.batchId, "one restore is one batch");
    assert.equal(rows[0]!.batchId, result.data.batchId);
    assert.ok(rows[0]!.at, "timestamped");
    assert.equal((await q(`SELECT count(*)::int AS n FROM nzi_console.audit_events WHERE entity_id = $1 AND action = 'report_version_restored' AND principal_type = 'staff'`, [second]))[0].n, 1);
    assert.deepEqual(await row(first.id), firstBefore, "the earlier round is never edited");
    assert.equal(Number((await q(`SELECT count(*)::int AS n FROM nzi_console.report_section_versions WHERE job_id = $1`, [jobId]))[0].n), sectionRows, "the job's working sections are not touched: this corrects THIS round");

    // Nothing left to restore: nothing is written and the version does not move.
    const again = await restore(second, first.id);
    assert.deepEqual([again.data.changedSections, again.data.batchId, await version(second)], [[], null, after.version]);
    assert.equal((await edits(second)).filter((edit) => edit.action === "restore").length, 2);
  });

  it("only the current round may be rolled back, and only while the CRM may still amend it: validated and in_client_review allowed; client_approved, published and superseded refused, worded", async () => {
    // A validated round beside an issued one (a re-issue in preparation) may be restored into. (Validating a newer snapshot while a round is
    // in flight replaces that round - the unlock rule - so this is shown on a job whose only earlier version is the issued one.)
    const issuedJob = await freshJob();
    const issued = await validated(issuedJob);
    await send(issued.id);
    await approveReportAsClient(database.pool, { reportVersionId: issued.id, expectedVersion: await version(issued.id) }, portal());
    await finalApproveReport(database.pool, { reportVersionId: issued.id, expectedStatus: "client_approved", manifestVersion: 1, reviewedSnapshotId: issued.snapshotId, expectedVersion: await version(issued.id) }, staff("rev", "reviewer"));
    const reissue = await validated(issuedJob);
    const toValidated = await restore(reissue.id, issued.id);
    assert.ok(Array.isArray(toValidated.data.changedSections), "a validated round is allowed");
    assert.equal((await row(reissue.id)).status, "validated");

    const { first, second } = await secondRound();
    await clientEdit(second, [["executive-summary", BODY("Changed:")]]);

    await approveReportAsClient(database.pool, { reportVersionId: second, expectedVersion: await version(second) }, portal());
    await assert.rejects(restore(second, first.id), (error: unknown) => refusedWith("PRECONDITION")(error) && /locked for edits/.test((error as CommandValidationError).issues[0]!.message));
    await finalApproveReport(database.pool, { reportVersionId: second, expectedStatus: "client_approved", manifestVersion: 1, reviewedSnapshotId: first.snapshotId, expectedVersion: await version(second) }, staff("rev", "reviewer"));
    await assert.rejects(restore(second, first.id), (error: unknown) => refusedWith("PRECONDITION")(error) && /published report is fixed/.test((error as CommandValidationError).issues[0]!.message));
    assert.equal((await row(first.id)).status, "superseded");
    await assert.rejects(restore(first.id, second), (error: unknown) => refusedWith("PRECONDITION")(error) && /superseded/.test((error as CommandValidationError).issues[0]!.message));
    assert.equal((await edits(first.id)).length, 0, "nothing written to a refused target");
  });

  it("the source must be a closed version of the same job and scope, and not the round itself: another job's, a missing one, the round itself are refused, and nothing is written", async () => {
    const { second } = await secondRound();
    const other = await secondRound();
    const startVersion = await version(second);
    await assert.rejects(restore(second, other.first.id), refusedWith("NOT_FOUND"), "another job's version");
    await assert.rejects(restore(second, "no-such-version"), refusedWith("NOT_FOUND"), "a missing version answers as another job's does");
    await assert.rejects(restore(second, second), refusedWith("INVALID"), "the round itself");
    assert.deepEqual([await version(second), (await edits(second)).length], [startVersion, 0]);
    assert.equal((await q(`SELECT count(*)::int AS n FROM nzi_console.audit_events WHERE action = 'report_version_restored' AND entity_id = $1`, [second]))[0].n, 0, "no restore audited");
  });

  it("the version pin: a stale expectedVersion is refused and nothing changes; the right one succeeds", async () => {
    const { first, second } = await secondRound();
    await clientEdit(second, [["executive-summary", BODY("Changed:")]]);
    const seen = await version(second);
    await clientEdit(second, [["background", BODY("Changed later:")]]); // the round moved on after the CRM opened it
    await assert.rejects(restore(second, first.id, seen), VersionConflictError);
    assert.equal(await body(second, "executive-summary"), BODY("Changed:"), "a stale restore changed nothing");
    assert.equal((await edits(second)).filter((edit) => edit.action === "restore").length, 0);
    await restore(second, first.id);
    assert.equal(await body(second, "executive-summary"), await body(first.id, "executive-summary"));
  });

  it("who may: report.publish holds it (reviewer, consultant, admin); a viewer is refused; it is not a portal command", async () => {
    const { first, second } = await secondRound();
    await clientEdit(second, [["executive-summary", BODY("Changed:")]]);
    await assert.rejects(restore(second, first.id, undefined, "viewer"), AuthorizationError);
    assert.equal((await edits(second)).filter((edit) => edit.action === "restore").length, 0);
    await restore(second, first.id, undefined, "consultant");
    const context = staff("rev", "reviewer");
    assert.deepEqual(validateCommand("report.restoreVersion", { reportVersionId: "a", fromReportVersionId: "b", expectedVersion: 1 }, context), []);
    assert.ok(validateCommand("report.restoreVersion", { reportVersionId: "a", fromReportVersionId: "a", expectedVersion: 1 }, context).some((issue) => issue.code === "INVALID"));
    assert.ok(validateCommand("report.restoreVersion", { reportVersionId: "a", fromReportVersionId: "", expectedVersion: 1 }, context).some((issue) => issue.field === "fromReportVersionId"));
    await assert.rejects(restoreReportVersion(database.pool, { reportVersionId: second, fromReportVersionId: first.id, expectedVersion: await version(second) }, portal()));
  });

  it("the chain lists the job and scope's versions oldest round first, marks which can be restored from, and an earlier version previews read-only - an issued one from its frozen document", async () => {
    const { first, second } = await secondRound();
    const chain = await withTenantRead(database.pool, ORG, (db) => listReportVersionChain(db, second));
    assert.deepEqual(chain.map((entry) => [entry.reportVersionId, entry.revision, entry.status, entry.current, entry.restorable]), [[first.id, 1, "published", false, true], [second, 2, "in_client_review", true, false]]);
    assert.equal(chain[1]!.supersedesReportVersionId, first.id);
    assert.ok(chain[0]!.finalApprovedAt && chain[0]!.publishedAt && chain[1]!.sentToReviewAt);
    assert.deepEqual((await withTenantRead(database.pool, ORG, (db) => listReportVersionChain(db, "no-such"))), []);
    // Other jobs' versions are not in this chain.
    const other = await secondRound();
    assert.ok(!chain.some((entry) => entry.reportVersionId === other.first.id));

    const preview = await withTenantRead(database.pool, ORG, (db) => previewPriorVersion(db, { organisationId: ORG, reportVersionId: second, fromReportVersionId: first.id }));
    assert.equal(preview!.status, "published");
    assert.equal(preview!.revision, 1);
    assert.ok(preview!.composition.narrative?.length);
    assert.equal(await withTenantRead(database.pool, ORG, (db) => previewPriorVersion(db, { organisationId: ORG, reportVersionId: second, fromReportVersionId: other.first.id })), null, "another job's version is not reachable");

    // A superseded round (reopened from client_approved) is composed now, read-only.
    const a = await validated(await freshJob());
    await send(a.id);
    await approveReportAsClient(database.pool, { reportVersionId: a.id, expectedVersion: await version(a.id) }, portal());
    await reopenReport(database.pool, { reportVersionId: a.id, expectedStatus: "client_approved", expectedVersion: await version(a.id) }, { ...staff("rev", "reviewer"), reason: "Another round." });
    const b = (await q(`SELECT report_version_id FROM nzi_console.report_versions WHERE supersedes_report_version_id = $1`, [a.id]))[0]!.report_version_id as string;
    const counts = async () => (await q(`SELECT (SELECT count(*) FROM nzi_console.report_versions) AS v, (SELECT count(*) FROM nzi_console.report_compositions) AS c, (SELECT count(*) FROM nzi_console.audit_events) AS a`))[0];
    const before = await counts();
    const superseded = await withTenantRead(database.pool, ORG, (db) => previewPriorVersion(db, { organisationId: ORG, reportVersionId: b, fromReportVersionId: a.id }));
    assert.equal(superseded!.status, "superseded");
    assert.ok(superseded!.composition.narrative?.length);
    assert.deepEqual(await counts(), before, "previewing stores nothing");
  });
});
