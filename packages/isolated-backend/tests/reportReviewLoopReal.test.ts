import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { commandGrantForRole, validateCommand, type CommandContext, type ReportNarrativeElement, type StaffRole } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { CommandValidationError, publishCrpReport, updateReportNarrative, validateCrpReport } from "../src/postgresCommands";
import { approveReportAsClient, finalApproveReport, reopenReport, sendReportToClientReview } from "../src/reportReviewLoop";
import { updateReportSectionPlan } from "../src/reportSectionPlans";
import { listReportStatusRegister } from "../src/reportStatusRegister";
import { getReportComposition, previewReportComposition } from "../src/reportCompositions";
import { SeparationOfDutiesError } from "../src/access";
import { AuthorizationError } from "../src/auth";
import { ScopeConflictError, VersionConflictError } from "../src/errors";
import { withTenantRead } from "../src/postgres";

/**
 * Client-review loop S1 (RULING-reporting-client-review-state-model; migration 0214), against a real database, through the real
 * commands as the application role:
 * - the widened status CHECK, the loop's columns and the two new unique indexes exist, and an unknown status cannot be stored;
 * - validated → in_client_review → client_approved → published (final), each only from the right prior state and only by the
 *   right principal, each pinned to the version the caller saw;
 * - a client-approved or published report refuses the CRM's narrative amend, a validated or open one allows it (D4 / ruling);
 * - the document is composed live during review and stored nowhere until the final approval freezes it (D6);
 * - reopen is a NEW row (revision + 1) carrying the narrative; the earlier round is never edited (D2, §4.4);
 * - a job-data unlock supersedes the open round and carries the narrative into the new validated version (D7);
 * - the status register reads the stored status, so it and the version cannot disagree (Risk #3).
 */
const ORG = "loop-org", CLIENT = "loop-client", JOB = "loop-job", OTHER_CLIENT = "loop-other-client";
const BODY = (words: string) => `<p>${words} <span data-token="total"></span> in <span data-token="reportingYear"></span>.</p>`;

describe("S1: the client-review loop lifecycle, against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let count = 0;
  const staff = (actor: string, role: StaffRole): CommandContext => {
    count += 1;
    return { organisationId: ORG, actorId: actor, principal: "staff", idempotencyKey: `loop-${count}`, correlationId: `corr-loop-${count}`, grant: commandGrantForRole(role, ORG, actor) };
  };
  const portal = (portalUserId: string, clientId = CLIENT): CommandContext => {
    count += 1;
    return { organisationId: ORG, actorId: portalUserId, principal: "portal", portal: { portalUserId, clientId }, idempotencyKey: `loop-${count}`, correlationId: `corr-loop-${count}` };
  };
  const withReason = (context: CommandContext, reason = "Client asked for another round."): CommandContext => ({ ...context, reason });
  const q = async (sql: string, params: unknown[] = []) => { const db = await database.admin(); try { return (await db.query(sql, params)).rows; } finally { await db.end(); } };
  const row = async (id: string) => (await q(`SELECT * FROM nzi_console.report_versions WHERE report_version_id = $1`, [id]))[0]!;
  const version = async (id: string) => Number((await row(id)).version);
  const narrativeOf = async (id: string) => (await row(id)).narrative as ReportNarrativeElement[];
  const compositions = async (id: string) => Number((await q(`SELECT count(*)::int AS n FROM nzi_console.report_compositions WHERE report_version_id = $1`, [id]))[0]!.n);

  let snapshots = 0;
  /** An approved snapshot (prepared by "prep", approved by "rev") whose payload passes the CRP manifest. */
  const snapshot = async (): Promise<string> => {
    snapshots += 1;
    const snapshotId = `loop-snap-${snapshots}`;
    const payload = { jobNumber: "J009905", client: "Loop Co", reportingYear: 2025,
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
    return snapshotId;
  };

  const validate = (snapshotId: string) => validateCrpReport(database.pool, { reviewedSnapshotId: snapshotId, manifestVersion: 1 }, staff("rev", "reviewer"));
  /** A fresh snapshot, validated: the version a round starts from. */
  const validated = async () => { const snapshotId = await snapshot(); const result = await validate(snapshotId); return { snapshotId, id: result.data.reportVersionId }; };
  const send = async (id: string, actor = "rev", role: StaffRole = "reviewer") => sendReportToClientReview(database.pool, { reportVersionId: id, expectedStatus: "validated", expectedVersion: await version(id) }, staff(actor, role));
  const approve = async (id: string, user = "pu-1", expectedVersion?: number) => approveReportAsClient(database.pool, { reportVersionId: id, expectedVersion: expectedVersion ?? await version(id) }, portal(user));
  const finalApprove = async (id: string, snapshotId: string, actor = "rev", role: StaffRole = "reviewer") =>
    finalApproveReport(database.pool, { reportVersionId: id, expectedStatus: "client_approved", manifestVersion: 1, reviewedSnapshotId: snapshotId, expectedVersion: await version(id) }, staff(actor, role));
  const reopen = async (id: string, expectedStatus: "client_approved" | "published", reason?: string) =>
    reopenReport(database.pool, { reportVersionId: id, expectedStatus, expectedVersion: await version(id) }, reason === undefined ? withReason(staff("rev", "reviewer")) : withReason(staff("rev", "reviewer"), reason));
  const amend = async (id: string, words: string, actor = "ada", role: StaffRole = "admin") =>
    updateReportNarrative(database.pool, { reportVersionId: id, expectedVersion: await version(id), sectionKey: "executive-summary", change: "edit", bodyHtml: BODY(words) }, staff(actor, role));
  /** One whole loop to the final approval. */
  const toFinal = async () => { const v = await validated(); await send(v.id); await approve(v.id); await finalApprove(v.id, v.snapshotId); return v; };
  const refusedWith = (code: string) => (error: unknown) => error instanceof CommandValidationError && error.issues.some((issue) => issue.code === code);

  before(async () => {
    database = (await createDisposableDatabase("reportreviewloop"))!;
    await q(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $1)`, [ORG]);
    await q(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name) VALUES ($1, 'ada', 'admin', 'active', 'Ada'), ($1, 'rev', 'reviewer', 'active', 'Rev'), ($1, 'prep', 'admin', 'active', 'Prep'), ($1, 'con', 'consultant', 'active', 'Con')`, [ORG]);
    await q(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status, currency) VALUES ($1, $2, 'Loop Co', 'active', 'GBP'), ($1, $3, 'Other Co', 'active', 'GBP')`, [ORG, CLIENT, OTHER_CLIENT]);
    await q(`INSERT INTO nzi_console.jobs (organisation_id, job_id, client_id, sequence, job_family, title, status, workflow_stage, reporting_year) VALUES ($1, $2, $3, 9905, 'crp', 'CRP', 'open', 'delivery', 2025)`, [ORG, JOB, CLIENT]);
    await q(`INSERT INTO nzi_console.job_emissions_config (organisation_id, job_id, reporting_from, reporting_to, country_code) VALUES ($1, $2, '2025-01-01', '2025-12-31', 'GB')`, [ORG, JOB]);
    for (const [user, client] of [["pu-1", CLIENT], ["pu-2", CLIENT], ["pu-revoked", CLIENT], ["pu-nogrant", CLIENT], ["pu-other", OTHER_CLIENT]]) {
      await q(`INSERT INTO nzi_console.portal_users (organisation_id, portal_user_id, client_id, status) VALUES ($1, $2, $3, 'active')`, [ORG, user, client]);
    }
    for (const user of ["pu-1", "pu-2"]) await q(`INSERT INTO nzi_console.portal_access_grants (organisation_id, grant_id, client_id, portal_user_id, job_id) VALUES ($1, $2, $3, $4, $5)`, [ORG, `g-${user}`, CLIENT, user, JOB]);
    await q(`INSERT INTO nzi_console.portal_access_grants (organisation_id, grant_id, client_id, portal_user_id, job_id, revoked_at) VALUES ($1, 'g-rev', $2, 'pu-revoked', $3, now())`, [ORG, CLIENT, JOB]);
  });
  after(async () => { await database?.end(); });

  it("0214: the status CHECK is widened, the loop's columns exist, an unknown status cannot be stored, and the two open-round indexes are in place", async () => {
    const columns = (await q(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'nzi_console' AND table_name = 'report_versions'
      AND column_name IN ('sent_to_review_at','sent_to_review_by','client_approved_at','client_approved_by','final_approved_at','final_approved_by','revision','supersedes_report_version_id') ORDER BY 1`)).map((r) => r.column_name);
    assert.deepEqual(columns, ["client_approved_at", "client_approved_by", "final_approved_at", "final_approved_by", "revision", "sent_to_review_at", "sent_to_review_by", "supersedes_report_version_id"]);
    const v = await validated();
    await assert.rejects(q(`UPDATE nzi_console.report_versions SET status = 'locked' WHERE report_version_id = $1`, [v.id]), /report_versions_status_check/);
    await assert.rejects(q(`UPDATE nzi_console.report_versions SET status = 'client_approved' WHERE report_version_id = $1`, [v.id]), /report_versions_loop_order|report_versions_client_approved_pair/, "approved without having been sent");
    const indexes = (await q(`SELECT indexname FROM pg_indexes WHERE schemaname = 'nzi_console' AND tablename = 'report_versions' AND indexname LIKE 'report_version%' ORDER BY 1`)).map((r) => r.indexname);
    for (const name of ["report_version_open_round_snapshot_scope_unique", "report_version_one_open_round_per_job_scope", "report_version_validated_snapshot_scope_unique", "report_version_one_published_per_job_scope"]) assert.ok(indexes.includes(name), name);
  });

  it("the whole loop: validated → in_client_review → client_approved → published (final), pinned and stamped at each step", async () => {
    const v = await validated();
    assert.equal((await row(v.id)).revision, 1);
    const sent = await send(v.id);
    assert.equal(sent.data.status, "in_client_review");
    assert.equal(sent.data.recipients, 2, "two granted, active portal users; the revoked and the ungranted do not count");
    let r = await row(v.id);
    assert.deepEqual([r.status, r.sent_to_review_by, r.client_approved_at, r.final_approved_at], ["in_client_review", "rev", null, null]);
    assert.ok(r.sent_to_review_at);

    const approved = await approve(v.id, "pu-1");
    assert.equal(approved.data.status, "client_approved");
    r = await row(v.id);
    assert.deepEqual([r.status, r.client_approved_by, r.final_approved_at], ["client_approved", "pu-1", null]);
    assert.equal((await q(`SELECT count(*)::int AS n FROM nzi_console.portal_report_approvals WHERE report_version_id = $1 AND portal_user_id = 'pu-1'`, [v.id]))[0]!.n, 1, "the approval joins the record the CRM inbox reads");

    const final = await finalApprove(v.id, v.snapshotId);
    assert.equal(final.data.status, "published");
    assert.equal(final.data.final, true);
    r = await row(v.id);
    assert.deepEqual([r.status, r.final_approved_by, r.published_by], ["published", "rev", "rev"]);
    assert.ok(r.final_approved_at && r.published_at);
    assert.equal(await compositions(v.id), 1, "frozen at the final approval");
    for (const action of ["report_sent_to_client_review", "report_client_approved", "report_final_approved"]) {
      assert.equal((await q(`SELECT count(*)::int AS n FROM nzi_console.audit_events WHERE entity_id = $1 AND action = $2`, [v.id, action]))[0]!.n, 1, action);
    }
    assert.equal((await q(`SELECT principal_type FROM nzi_console.audit_events WHERE entity_id = $1 AND action = 'report_client_approved'`, [v.id]))[0]!.principal_type, "portal");
  });

  it("each transition is allowed only from its prior state", async () => {
    const v = await validated();
    await assert.rejects(approve(v.id, "pu-1", 1), refusedWith("PRECONDITION"), "the client cannot approve what was never sent");
    await assert.rejects(finalApproveReport(database.pool, { reportVersionId: v.id, expectedStatus: "client_approved", manifestVersion: 1, reviewedSnapshotId: v.snapshotId, expectedVersion: 1 }, staff("rev", "reviewer")), refusedWith("PRECONDITION"), "final approval of a validated report");
    await send(v.id);
    await assert.rejects(send(v.id), refusedWith("PRECONDITION"), "sent twice");
    await assert.rejects(finalApprove(v.id, v.snapshotId), refusedWith("PRECONDITION"), "final approval before the client has approved");
    await assert.rejects(reopen(v.id, "client_approved"), refusedWith("PRECONDITION"), "reopen of a round that is already open");
    await assert.rejects(publishCrpReport(database.pool, { reportVersionId: v.id, expectedStatus: "validated", manifestVersion: 1, reviewedSnapshotId: v.snapshotId, expectedVersion: await version(v.id) }, staff("rev", "reviewer")), refusedWith("PRECONDITION"), "the direct publish path cannot skip the review once sent");
    await approve(v.id);
    await assert.rejects(approve(v.id, "pu-2"), refusedWith("PRECONDITION"), "a second approval of an approved round");
    await finalApprove(v.id, v.snapshotId);
    await assert.rejects(finalApprove(v.id, v.snapshotId), refusedWith("PRECONDITION"), "final approval twice");
    await assert.rejects(send(v.id), refusedWith("PRECONDITION"), "a published report is not sent again — it is reopened");
  });

  it("every transition is pinned to the version the caller saw: a stale screen is refused, and a client approves only what they saw", async () => {
    const v = await validated();
    await assert.rejects(sendReportToClientReview(database.pool, { reportVersionId: v.id, expectedStatus: "validated", expectedVersion: 99 }, staff("rev", "reviewer")), VersionConflictError);
    await send(v.id);
    const seen = await version(v.id);
    await amend(v.id, "The CRM amended this after the client opened it.");
    await assert.rejects(approve(v.id, "pu-1", seen), VersionConflictError, "the narrative moved after the client loaded it");
    assert.equal((await row(v.id)).status, "in_client_review", "the stale approval changed nothing");
    await approve(v.id, "pu-1");
    await assert.rejects(finalApproveReport(database.pool, { reportVersionId: v.id, expectedStatus: "client_approved", manifestVersion: 1, reviewedSnapshotId: v.snapshotId, expectedVersion: 1 }, staff("rev", "reviewer")), VersionConflictError);
    await assert.rejects(finalApproveReport(database.pool, { reportVersionId: v.id, expectedStatus: "client_approved", manifestVersion: 2, reviewedSnapshotId: v.snapshotId, expectedVersion: await version(v.id) }, staff("rev", "reviewer")), refusedWith("EVIDENCE_MISMATCH"));
  });

  it("sending needs someone to send it to: no live portal grant on the job is refused", async () => {
    const v = await validated();
    await q(`UPDATE nzi_console.portal_access_grants SET revoked_at = now() WHERE job_id = $1 AND revoked_at IS NULL`, [JOB]);
    try {
      await assert.rejects(send(v.id), refusedWith("NO_PORTAL_ACCESS"));
      assert.equal((await row(v.id)).status, "validated");
    } finally {
      await q(`UPDATE nzi_console.portal_access_grants SET revoked_at = NULL WHERE grant_id IN ('g-pu-1', 'g-pu-2')`);
    }
  });

  it("who may do what: the client approval is a portal act under a live grant; the rest need report.publish", async () => {
    const v = await validated();
    await assert.rejects(send(v.id, "fin", "finance"), AuthorizationError, "finance does not hold report.publish (the consultant does, since matrix v12)");
    await send(v.id);
    await assert.rejects(approveReportAsClient(database.pool, { reportVersionId: v.id, expectedVersion: await version(v.id) }, staff("rev", "reviewer")), AuthorizationError, "staff cannot give the client's approval");
    for (const user of ["pu-nogrant", "pu-revoked"]) await assert.rejects(approve(v.id, user), AuthorizationError, `${user}: no live grant on the job`);
    await assert.rejects(approveReportAsClient(database.pool, { reportVersionId: v.id, expectedVersion: await version(v.id) }, portal("pu-other", OTHER_CLIENT)), AuthorizationError, "another client's user");
    assert.equal((await row(v.id)).status, "in_client_review", "none of those changed anything");
    await approve(v.id, "pu-2");
    assert.equal((await row(v.id)).client_approved_by, "pu-2", "D1: one granted user's approval is enough");
    await assert.rejects(finalApprove(v.id, v.snapshotId, "fin", "finance"), AuthorizationError);
    await assert.rejects(reopenReport(database.pool, { reportVersionId: v.id, expectedStatus: "client_approved", expectedVersion: await version(v.id) }, withReason(staff("fin", "finance"))), AuthorizationError);
  });

  it("the independent-approval gate holds at the final approval: the snapshot's preparer cannot give it", async () => {
    const v = await validated();
    await send(v.id);
    await approve(v.id);
    await assert.rejects(finalApprove(v.id, v.snapshotId, "prep", "admin"), SeparationOfDutiesError);
    assert.equal((await row(v.id)).status, "client_approved");
  });

  it("fail-safe: editing is an allow-list. The CRM may amend while validated or in review; once the client approves, or it is published, it is refused", async () => {
    const v = await validated();
    await amend(v.id, "Amended while validated.");
    await send(v.id);
    await amend(v.id, "Amended in client review.");
    assert.match((await narrativeOf(v.id)).find((e) => e.key === "executive-summary")!.bodyHtml, /Amended in client review/);
    await assert.rejects(updateReportSectionPlan(database.pool, { reportVersionId: v.id, expectedVersion: await version(v.id), sectionPlan: JSON.parse((await row(v.id)).section_plan ? JSON.stringify((await row(v.id)).section_plan) : "[]") }, staff("rev", "reviewer")), refusedWith("PRECONDITION"), "the order is set before it goes to the client");
    await approve(v.id);
    await assert.rejects(amend(v.id, "Too late."), (error: unknown) => error instanceof CommandValidationError && /locked for edits/.test(error.issues[0]!.message), "client_approved rejects the CRM's edit too — reopen first");
    await finalApprove(v.id, v.snapshotId);
    await assert.rejects(amend(v.id, "Fixed."), (error: unknown) => error instanceof CommandValidationError && /fixed as it was issued/.test(error.issues[0]!.message));
    assert.doesNotMatch(JSON.stringify(await narrativeOf(v.id)), /Too late|Fixed\./);
  });

  it("D6: the document is composed live during review and stored nowhere until the final approval freezes it", async () => {
    const v = await validated();
    const preview = (id: string) => withTenantRead(database.pool, ORG, (db) => previewReportComposition(db, { organisationId: ORG, reportVersionId: id }));
    await send(v.id);
    assert.equal((await preview(v.id))!.status, "in_client_review");
    assert.equal(await compositions(v.id), 0);
    await approve(v.id);
    const live = (await preview(v.id))!;
    assert.equal(live.status, "client_approved");
    assert.equal(await compositions(v.id), 0, "client approval freezes nothing");
    await finalApprove(v.id, v.snapshotId);
    assert.equal(await preview(v.id), null, "a published version is read back from its frozen composition, never re-composed");
    const frozen = (await withTenantRead(database.pool, ORG, (db) => getReportComposition(db, v.id)))!;
    assert.deepEqual(frozen.narrative, live.composition.narrative, "what was reviewed is what is frozen");
    assert.equal(await compositions(v.id), 1);
  });

  it("reopen from a published report: a NEW round (revision + 1) with the narrative carried; the published one stays live until the new round is finally approved", async () => {
    const v = await validated();
    await amend(v.id, "First round wording.");
    await send(v.id);
    await approve(v.id);
    await finalApprove(v.id, v.snapshotId);
    const before = await row(v.id);

    await assert.rejects(reopenReport(database.pool, { reportVersionId: v.id, expectedStatus: "published", expectedVersion: before.version }, staff("rev", "reviewer")), CommandValidationError, "a reason is required");
    const reopened = await reopen(v.id, "published");
    const next = reopened.data.reportVersionId as string;
    const after = await row(next);
    assert.deepEqual([after.status, after.revision, after.supersedes_report_version_id, after.job_id, after.scope_key, after.reviewed_snapshot_id], ["in_client_review", 2, v.id, JOB, "whole", v.snapshotId]);
    assert.deepEqual(after.narrative, before.narrative, "the words carry forward");
    assert.deepEqual([after.client_approved_at, after.final_approved_at, after.published_at], [null, null, null]);
    const untouched = await row(v.id);
    assert.deepEqual([untouched.status, untouched.version, untouched.narrative, untouched.final_approved_at?.toISOString()], ["published", before.version, before.narrative, before.final_approved_at.toISOString()], "the earlier round is never edited");
    assert.equal(reopened.data.earlierRound, "stays-live");
    assert.equal((await q(`SELECT count(*)::int AS n FROM nzi_console.audit_events WHERE entity_id = $1 AND action = 'report_reopened' AND reason = 'Client asked for another round.'`, [next]))[0]!.n, 1);

    // The register reads the stored status: the round is where the work is, the published version is still what the client holds.
    const stage = async () => (await withTenantRead(database.pool, ORG, (db) => listReportStatusRegister(db, { jobId: JOB })))[0]!;
    assert.deepEqual([(await stage()).stage, (await stage()).publishedVersionId], ["awaiting-client", v.id]);

    await amend(next, "Second round wording.");
    await approve(next, "pu-2");
    assert.equal((await stage()).stage, "awaiting-final-approval");
    await finalApprove(next, v.snapshotId);
    assert.deepEqual([(await row(v.id)).status, (await row(next)).status], ["superseded", "published"], "the new round replaces the old at its final approval");
    assert.match(JSON.stringify((await getReportComposition0(next)).narrative), /Second round wording/);
    assert.match(JSON.stringify((await getReportComposition0(v.id)).narrative), /First round wording/, "round 1's frozen document is exactly as issued");
  });
  const getReportComposition0 = async (id: string) => (await withTenantRead(database.pool, ORG, (db) => getReportComposition(db, id)))!;

  it("reopen from client_approved: the approved round is superseded at once, so only one round is ever open", async () => {
    const v = await validated();
    await send(v.id);
    await approve(v.id);
    const reopened = await reopen(v.id, "client_approved");
    assert.equal(reopened.data.earlierRound, "superseded");
    assert.deepEqual([(await row(v.id)).status, (await row(reopened.data.reportVersionId as string)).status], ["superseded", "in_client_review"]);
    await assert.rejects(reopen(v.id, "client_approved"), refusedWith("PRECONDITION"), "a superseded round cannot be reopened again");
    await assert.rejects(q(`UPDATE nzi_console.report_versions SET status = 'in_client_review' WHERE report_version_id = $1`, [v.id]), /report_version_one_open_round_per_job_scope|report_version_open_round_snapshot_scope_unique/, "two open rounds on one scope are impossible in the schema");
  });

  it("D7: a job-data unlock supersedes the open round and the new validated version carries its narrative; the figures come from the new snapshot", async () => {
    const first = await validated();
    await send(first.id);
    await amend(first.id, "Words the CRM settled on.");
    // A client's edit in review lives on the round (S4), not in the job's working store the resolver reads — so the carry, not the
    // resolver, is what keeps it. Simulated here as the round's frozen words diverging from the working section.
    await q(`UPDATE nzi_console.report_versions SET narrative = (SELECT jsonb_agg(CASE WHEN e->>'key' = 'executive-summary' THEN jsonb_set(e, '{bodyHtml}', to_jsonb($2::text)) ELSE e END ORDER BY o)
              FROM jsonb_array_elements(narrative) WITH ORDINALITY AS t(e, o)) WHERE report_version_id = $1`, [first.id, BODY("Words only the client wrote.")]);
    const settled = (await narrativeOf(first.id)).find((e) => e.key === "executive-summary")!;
    assert.match(settled.bodyHtml, /only the client wrote/);

    // The same snapshot is not a new snapshot: still the old conflict.
    await assert.rejects(validate(first.snapshotId), ScopeConflictError);
    assert.equal((await row(first.id)).status, "in_client_review");

    const unlockedSnapshot = await snapshot();
    const second = await validate(unlockedSnapshot);
    assert.equal(second.data.supersededReportVersionId, first.id);
    assert.ok(second.data.narrativeCarriedKeys!.includes("executive-summary"));
    assert.equal((await row(first.id)).status, "superseded");
    const carried = await row(second.data.reportVersionId);
    assert.equal(carried.status, "validated", "re-enters at validated");
    assert.equal(carried.reviewed_snapshot_id, unlockedSnapshot, "on the new snapshot");
    assert.deepEqual((carried.narrative as ReportNarrativeElement[]).find((e) => e.key === "executive-summary"), settled, "the words survive");
    assert.equal(carried.revision, 1, "a unlock is a new validation, not a reopen");
  });

  it("direct publish is untouched: validated → published carries no final stamp, and the old path still reads as it did", async () => {
    const v = await validated();
    await publishCrpReport(database.pool, { reportVersionId: v.id, expectedStatus: "validated", manifestVersion: 1, reviewedSnapshotId: v.snapshotId, expectedVersion: await version(v.id) }, staff("rev", "reviewer"));
    const r = await row(v.id);
    assert.deepEqual([r.status, r.final_approved_at, r.final_approved_by, r.sent_to_review_at], ["published", null, null, null]);
    const reopened = await reopen(v.id, "published");
    assert.equal((await row(reopened.data.reportVersionId as string)).revision, 2, "a directly-published report can also be taken round the loop");
  });

  it("the commands' contracts refuse a malformed request before any database work", () => {
    const context = staff("rev", "reviewer");
    assert.ok(validateCommand("report.sendToClientReview", { reportVersionId: "r", expectedStatus: "published" as "validated", expectedVersion: 1 }, context).length);
    assert.ok(validateCommand("report.finalApprove", { reportVersionId: "r", expectedStatus: "validated" as "client_approved", manifestVersion: 1, reviewedSnapshotId: "s", expectedVersion: 1 }, context).length);
    assert.ok(validateCommand("report.reopen", { reportVersionId: "r", expectedStatus: "client_approved", expectedVersion: 1 }, context).some((issue) => issue.code === "REQUIRED" && issue.field === "reason"));
    assert.ok(validateCommand("report.reopen", { reportVersionId: "r", expectedStatus: "in_client_review" as "published", expectedVersion: 1 }, { ...context, reason: "x" }).length);
    assert.deepEqual(validateCommand("report.clientApprove", { reportVersionId: "r", expectedVersion: 1 }, portal("pu-1")), []);
    assert.ok(validateCommand("report.clientApprove", { reportVersionId: "r", expectedVersion: 0 }, portal("pu-1")).length);
  });
});
