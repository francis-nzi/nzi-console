import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { commandGrantForRole, crmQueue, roleCapabilityGrants, type CommandContext, type StaffRole } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./database";
import { validateCrpReport } from "../../src/postgresCommands";
import { approveReportAsClient, postReportMessageAsClient, sendReportToClientReview, updateReportAsClient } from "../../src/reportReviewLoop";
import { addStaffReportComment, listStaffReportThreads } from "../../src/portalReview";
import { listReportStatusRegister } from "../../src/reportStatusRegister";
import { withTenantRead } from "../../src/postgres";
import type { StaffPrincipal } from "../../src/auth";

/**
 * Client-review loop S6, against a real database: whose turn a round open for review is, and how many reports wait on the team. All derived -
 * the register reads the client's latest act (an edit, a message) against the team's (a reply, an edit, sending the round); nothing is stored.
 */
const ORG = "rcq-org", CLIENT = "rcq-client", JOB_A = "rcq-job-a", JOB_B = "rcq-job-b";
const BODY = (words: string) => `<p>${words} <span data-token="total"></span> in <span data-token="reportingYear"></span>.</p>`;
const pause = () => new Promise((resolve) => setTimeout(resolve, 25));
const adviser = { organisationId: ORG, userId: "ada", sessionId: "s", issuedAt: 1, expiresAt: 2, role: "admin", matrixVersion: 1, capabilities: roleCapabilityGrants("admin") } as unknown as StaffPrincipal;

describe("S6: the CRM's review-loop queue, derived from the records, against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let count = 0;
  const staff = (actor: string, role: StaffRole): CommandContext => { count += 1; return { organisationId: ORG, actorId: actor, principal: "staff", idempotencyKey: `rcq-${count}`, correlationId: `corr-rcq-${count}`, grant: commandGrantForRole(role, ORG, actor) }; };
  const portal = (user = "rq-1"): CommandContext => { count += 1; return { organisationId: ORG, actorId: user, principal: "portal", portal: { portalUserId: user, clientId: CLIENT }, idempotencyKey: `rcq-${count}`, correlationId: `corr-rcq-${count}` }; };
  const q = async (sql: string, params: unknown[] = []) => { const db = await database.admin(); try { return (await db.query(sql, params)).rows; } finally { await db.end(); } };
  const version = async (id: string) => Number((await q(`SELECT version FROM nzi_console.report_versions WHERE report_version_id = $1`, [id]))[0]!.version);
  const register = () => withTenantRead(database.pool, ORG, (db) => listReportStatusRegister(db));
  const stageOf = async (jobId: string) => (await register()).find((row) => row.jobId === jobId)!.stage;
  const inbox = async (id: string) => (await listStaffReportThreads(database.pool, adviser)).find((thread) => thread.reportVersionId === id);

  let snapshots = 0;
  const sent = async (jobId: string) => {
    snapshots += 1;
    const snapshotId = `rcq-snap-${snapshots}`;
    const payload = { jobNumber: "J009911", client: "Queue Co", reportingYear: 2025,
      measurements: [
        { rowId: `r-${snapshots}`, scope: "1", scopeCode: "1", siteId: null, siteLabel: null, sourceLabel: "Gas", tco2e: 10, qualityTier: "measured", factorSet: "demo" },
        { rowId: `g-${snapshots}`, scope: "3", scopeCode: "3.1", siteId: null, siteLabel: null, sourceLabel: "Goods", tco2e: 20, qualityTier: "estimated", factorSet: "demo", purchasedGoodsCategoryId: "pg", purchasedGoodsCategoryLabel: "Materials" }],
      target: { baselineYear: 2023, baselineTco2e: 40, interimYear: 2030, interimReductionPercent: 50, netZeroYear: 2045 },
      intensityTarget: { source: "client-target", metric: "turnover", metricLabel: "Turnover", denominatorUnit: "£m", reportingDenominator: 12.5, baselineYear: 2023, baselineIntensity: 6,
        interimYear: 2030, interimReductionPercent: 50, targetYear: 2045, targetReductionPercent: 100, netZeroYear: null, jobId, version: 1, updatedAt: "2026-01-01T00:00:00.000Z", updatedBy: "ada" },
      annualComparison: [{ year: 2024, values: [{ scope: "1", value: 12 }] }, { year: 2025, values: [{ scope: "1", value: 10 }] }] };
    await q(`INSERT INTO nzi_console.reviewed_crp_snapshots (organisation_id, snapshot_id, job_id, snapshot_version, job_version, data_hash, payload_json, created_by, approved_by, approved_at)
             VALUES ($1, $2, $3, $4, 1, $5, $6::jsonb, 'prep', 'rev', now())`, [ORG, snapshotId, jobId, snapshots, `sha256:${createHash("sha256").update(snapshotId).digest("hex")}`, JSON.stringify(payload)]);
    const id = (await validateCrpReport(database.pool, { reviewedSnapshotId: snapshotId, manifestVersion: 1 }, staff("rev", "reviewer"))).data.reportVersionId;
    await sendReportToClientReview(database.pool, { reportVersionId: id, expectedStatus: "validated", expectedVersion: await version(id) }, staff("rev", "reviewer"));
    return id;
  };

  before(async () => {
    database = (await createDisposableDatabase("reportcrmqueue"))!;
    await q(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $1)`, [ORG]);
    await q(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name) VALUES ($1, 'ada', 'admin', 'active', 'Ada'), ($1, 'rev', 'reviewer', 'active', 'Rev'), ($1, 'prep', 'admin', 'active', 'Prep')`, [ORG]);
    await q(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status, currency) VALUES ($1, $2, 'Queue Co', 'active', 'GBP')`, [ORG, CLIENT]);
    await q(`INSERT INTO nzi_console.portal_users (organisation_id, portal_user_id, client_id, status, display_name) VALUES ($1, 'rq-1', $2, 'active', 'Quinn')`, [ORG, CLIENT]);
    for (const [job, seq] of [[JOB_A, 9911], [JOB_B, 9912]] as const) {
      await q(`INSERT INTO nzi_console.jobs (organisation_id, job_id, client_id, sequence, job_family, title, status, workflow_stage, reporting_year) VALUES ($1, $2, $3, $4, 'crp', 'CRP', 'open', 'delivery', 2025)`, [ORG, job, CLIENT, seq]);
      await q(`INSERT INTO nzi_console.job_emissions_config (organisation_id, job_id, reporting_from, reporting_to, country_code) VALUES ($1, $2, '2025-01-01', '2025-12-31', 'GB')`, [ORG, job]);
      await q(`INSERT INTO nzi_console.portal_access_grants (organisation_id, grant_id, client_id, portal_user_id, job_id) VALUES ($1, $2, $3, 'rq-1', $4)`, [ORG, `g-${job}`, CLIENT, job]);
    }
  });
  after(async () => { await database?.end(); });

  it("whose turn it is follows the latest act on the round: the client's edit or message makes it the team's turn; the team's reply hands it back; approving makes it the final approval", async () => {
    const id = await sent(JOB_A);
    assert.equal(await stageOf(JOB_A), "awaiting-client", "just sent: the team acted last");
    assert.deepEqual([(await inbox(id))!.crmTurn, (await inbox(id))!.status], [false, "in_client_review"]);

    await pause();
    await updateReportAsClient(database.pool, { reportVersionId: id, expectedVersion: await version(id), edits: [{ sectionKey: "executive-summary", bodyHtml: BODY("Our story:") }] }, portal());
    assert.equal(await stageOf(JOB_A), "client-responded", "a client edit alone is enough");
    assert.equal((await inbox(id))!.crmTurn, true);

    await pause();
    await addStaffReportComment(database.pool, adviser, { jobId: JOB_A, reportVersionId: id, body: "Thanks - done." });
    assert.equal(await stageOf(JOB_A), "awaiting-client", "the team replied after the client");
    assert.equal((await inbox(id))!.crmTurn, false);

    await pause();
    await postReportMessageAsClient(database.pool, { reportVersionId: id, body: "One more thing." }, portal());
    assert.equal(await stageOf(JOB_A), "client-responded", "a client message after the reply");
    assert.equal((await inbox(id))!.crmTurn, true);

    await pause();
    await addStaffReportComment(database.pool, adviser, { jobId: JOB_A, reportVersionId: id, body: "Noted." });
    assert.equal(await stageOf(JOB_A), "awaiting-client");

    await approveReportAsClient(database.pool, { reportVersionId: id, expectedVersion: await version(id) }, portal());
    assert.equal(await stageOf(JOB_A), "awaiting-final-approval");
    assert.deepEqual([(await inbox(id))!.crmTurn, (await inbox(id))!.status], [true, "client_approved"]);
  });

  it("the queue counts only the rounds where it is the team's turn - per job and across jobs; a round awaiting the client is not counted", async () => {
    const rows = await register();
    const a = rows.find((row) => row.jobId === JOB_A)!;
    assert.equal(a.stage, "awaiting-final-approval");
    assert.deepEqual(crmQueue(rows), { total: 1, byStage: { "client-responded": 0, "changes-requested": 0, "awaiting-final-approval": 1 } });

    const b = await sent(JOB_B);
    assert.equal(await stageOf(JOB_B), "awaiting-client");
    assert.equal(crmQueue(await register()).total, 1, "a round awaiting the client adds nothing");

    await pause();
    await postReportMessageAsClient(database.pool, { reportVersionId: b, body: "Quick question." }, portal());
    assert.deepEqual(crmQueue(await register()), { total: 2, byStage: { "client-responded": 1, "changes-requested": 0, "awaiting-final-approval": 1 } });
    assert.deepEqual(crmQueue((await register()).filter((row) => row.jobId === JOB_B)), { total: 1, byStage: { "client-responded": 1, "changes-requested": 0, "awaiting-final-approval": 0 } }, "per job");

    await pause();
    await addStaffReportComment(database.pool, adviser, { jobId: JOB_B, reportVersionId: b, body: "Answered." });
    assert.equal(crmQueue(await register()).total, 1, "answered: back with the client");
  });

  it("the inbox puts the team's turn first, and a staff-side read writes nothing", async () => {
    const before = (await q(`SELECT (SELECT count(*) FROM nzi_console.report_versions) AS v, (SELECT count(*) FROM nzi_console.audit_events) AS a, (SELECT count(*) FROM nzi_console.report_version_edits) AS e`))[0]!;
    const threads = await listStaffReportThreads(database.pool, adviser);
    assert.equal(threads[0]!.crmTurn, true, "what needs the team is listed first");
    assert.deepEqual(threads.map((thread) => thread.crmTurn), [...threads.map((thread) => thread.crmTurn)].sort((x, y) => Number(y) - Number(x)));
    await register();
    const after = (await q(`SELECT (SELECT count(*) FROM nzi_console.report_versions) AS v, (SELECT count(*) FROM nzi_console.audit_events) AS a, (SELECT count(*) FROM nzi_console.report_version_edits) AS e`))[0]!;
    assert.deepEqual(after, before, "reading the queue changed nothing");
  });
});
