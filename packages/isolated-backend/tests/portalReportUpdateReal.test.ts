import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { commandGrantForRole, type CommandContext, type ReportNarrativeElement, type StaffRole } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { CommandValidationError, updateReportNarrative, validateCrpReport } from "../src/postgresCommands";
import { approveReportAsClient, finalApproveReport, sendReportToClientReview, updateReportAsClient } from "../src/reportReviewLoop";
import { getGrantedPortalReviewRound } from "../src/portalReportReview";
import { listReportVersionEdits } from "../src/reportVersionEdits";
import { AuthorizationError } from "../src/auth";
import { VersionConflictError } from "../src/errors";
import { withTenantRead } from "../src/postgres";

/**
 * Client-review loop S4 (portal.report.update), against a real database, through the real commands as nzi_console_app:
 * - a granted portal user edits narrative sections of an `in_client_review` round: each body re-freezes onto the version, ONE version
 *   bump for the batch, and the S3 history gets a `portal` / `edit` row per changed section sharing one batch (unchanged writes none);
 * - the client allow-list: refused in validated, client_approved, published and superseded, in the client's own words;
 * - the version pin; the tokenised no-money rule (a typed figure, money, an unknown token); only the sections the version draws;
 * - authorisation: no grant, a revoked grant, another client's user and a staff principal are each refused;
 * - the portal read: the round's live composition for the granted user only, the editable sections while open, stored nowhere.
 */
const ORG = "pru-org", CLIENT = "pru-client", OTHER_CLIENT = "pru-other-client", JOB = "pru-job";
const BODY = (words: string) => `<p>${words} <span data-token="total"></span> in <span data-token="reportingYear"></span>.</p>`;

describe("S4: the client's Update on a round open for review, against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let count = 0;
  const staff = (actor: string, role: StaffRole): CommandContext => {
    count += 1;
    return { organisationId: ORG, actorId: actor, principal: "staff", idempotencyKey: `pru-${count}`, correlationId: `corr-pru-${count}`, grant: commandGrantForRole(role, ORG, actor) };
  };
  const portal = (user: string, clientId = CLIENT): CommandContext => { count += 1; return { organisationId: ORG, actorId: user, principal: "portal", portal: { portalUserId: user, clientId }, idempotencyKey: `pru-${count}`, correlationId: `corr-pru-${count}` }; };
  const q = async (sql: string, params: unknown[] = []) => { const db = await database.admin(); try { return (await db.query(sql, params)).rows; } finally { await db.end(); } };
  const row = async (id: string) => (await q(`SELECT * FROM nzi_console.report_versions WHERE report_version_id = $1`, [id]))[0]!;
  const version = async (id: string) => Number((await row(id)).version);
  const frozen = async (id: string) => (await row(id)).narrative as ReportNarrativeElement[];
  const body = async (id: string, key: string) => (await frozen(id)).find((e) => e.key === key)!.bodyHtml;
  const edits = (id: string) => withTenantRead(database.pool, ORG, (db) => listReportVersionEdits(db, id));
  const update = async (id: string, sections: Array<[string, string]>, user = "pu-1", expectedVersion?: number) =>
    updateReportAsClient(database.pool, { reportVersionId: id, expectedVersion: expectedVersion ?? await version(id), edits: sections.map(([sectionKey, bodyHtml]) => ({ sectionKey, bodyHtml })) }, portal(user));
  const refusedWith = (code: string) => (error: unknown) => error instanceof CommandValidationError && error.issues.some((issue) => issue.code === code);

  let snapshots = 0;
  const approvedSnapshot = async (): Promise<string> => {
    snapshots += 1;
    const snapshotId = `pru-snap-${snapshots}`;
    const payload = { jobNumber: "J009908", client: "Update Co", reportingYear: 2025,
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
  const validated = async () => { const snapshotId = await approvedSnapshot(); return { snapshotId, id: (await validateCrpReport(database.pool, { reviewedSnapshotId: snapshotId, manifestVersion: 1 }, staff("rev", "reviewer"))).data.reportVersionId }; };
  const sent = async () => { const v = await validated(); await sendReportToClientReview(database.pool, { reportVersionId: v.id, expectedStatus: "validated", expectedVersion: await version(v.id) }, staff("rev", "reviewer")); return v; };

  before(async () => {
    database = (await createDisposableDatabase("portalreportupdate"))!;
    await q(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $1)`, [ORG]);
    await q(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name) VALUES ($1, 'ada', 'admin', 'active', 'Ada'), ($1, 'rev', 'reviewer', 'active', 'Rev'), ($1, 'prep', 'admin', 'active', 'Prep')`, [ORG]);
    await q(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status, currency) VALUES ($1, $2, 'Update Co', 'active', 'GBP'), ($1, $3, 'Other Co', 'active', 'GBP')`, [ORG, CLIENT, OTHER_CLIENT]);
    await q(`INSERT INTO nzi_console.jobs (organisation_id, job_id, client_id, sequence, job_family, title, status, workflow_stage, reporting_year) VALUES ($1, $2, $3, 9908, 'crp', 'CRP', 'open', 'delivery', 2025)`, [ORG, JOB, CLIENT]);
    await q(`INSERT INTO nzi_console.job_emissions_config (organisation_id, job_id, reporting_from, reporting_to, country_code) VALUES ($1, $2, '2025-01-01', '2025-12-31', 'GB')`, [ORG, JOB]);
    for (const [user, client, name] of [["pu-1", CLIENT, "Pat Portal"], ["pu-2", CLIENT, "Pia Portal"], ["pu-revoked", CLIENT, "Rex"], ["pu-nogrant", CLIENT, "Nia"], ["pu-other", OTHER_CLIENT, "Otto"]]) {
      await q(`INSERT INTO nzi_console.portal_users (organisation_id, portal_user_id, client_id, status, display_name) VALUES ($1, $2, $3, 'active', $4)`, [ORG, user, client, name]);
    }
    for (const user of ["pu-1", "pu-2"]) await q(`INSERT INTO nzi_console.portal_access_grants (organisation_id, grant_id, client_id, portal_user_id, job_id) VALUES ($1, $2, $3, $4, $5)`, [ORG, `g-${user}`, CLIENT, user, JOB]);
    await q(`INSERT INTO nzi_console.portal_access_grants (organisation_id, grant_id, client_id, portal_user_id, job_id, revoked_at) VALUES ($1, 'g-rev', $2, 'pu-revoked', $3, now())`, [ORG, CLIENT, JOB]);
  });
  after(async () => { await database?.end(); });

  it("a granted user's Update re-freezes each changed section, bumps the version ONCE, and records a portal edit per section in one batch", async () => {
    const v = await sent();
    const before = { exec: await body(v.id, "executive-summary"), background: await body(v.id, "background"), net: await body(v.id, "net-zero-commitment") };
    const startVersion = await version(v.id);
    const sectionRows = Number((await q(`SELECT count(*)::int AS n FROM nzi_console.report_section_versions WHERE job_id = $1`, [JOB]))[0].n);
    const result = await update(v.id, [["executive-summary", BODY("Our carbon story:")], ["background", BODY("Where we started:")], ["net-zero-commitment", before.net]]);
    assert.deepEqual(result.data.changedSections, ["executive-summary", "background"], "the unchanged section is not counted");
    assert.equal(await version(v.id), startVersion + 1, "one version bump for the whole batch");
    assert.equal(result.data.version, startVersion + 1);
    const narrative = await frozen(v.id);
    assert.equal(narrative.find((e) => e.key === "executive-summary")!.bodyHtml, BODY("Our carbon story:"));
    assert.equal(narrative.find((e) => e.key === "executive-summary")!.contentSource, "client-edited");
    assert.equal(narrative.find((e) => e.key === "net-zero-commitment")!.bodyHtml, before.net, "an unchanged section is untouched");
    assert.equal((await row(v.id)).status, "in_client_review");

    const rows = await edits(v.id);
    assert.equal(rows.length, 2, "an unchanged section writes no row");
    assert.deepEqual(rows.map((r) => [r.seq, r.principal, r.action, r.actorId, r.actorName, r.sectionKey]), [
      [1, "portal", "edit", "pu-1", "Pat Portal", "executive-summary"], [2, "portal", "edit", "pu-1", "Pat Portal", "background"]]);
    assert.deepEqual([rows[0]!.beforeHtml, rows[0]!.afterHtml, rows[1]!.beforeHtml, rows[1]!.afterHtml], [before.exec, BODY("Our carbon story:"), before.background, BODY("Where we started:")]);
    assert.equal(rows[0]!.batchId, rows[1]!.batchId, "one Update is one batch");
    assert.equal(rows[0]!.batchId, result.data.batchId);
    assert.equal(Number((await q(`SELECT count(*)::int AS n FROM nzi_console.report_section_versions WHERE job_id = $1`, [JOB]))[0].n), sectionRows, "the job's working sections are not touched: the client edits THIS round");
    assert.equal((await q(`SELECT count(*)::int AS n FROM nzi_console.audit_events WHERE entity_id = $1 AND action = 'portal_report_updated' AND principal_type = 'portal'`, [v.id]))[0].n, 1);

    // A second Update is its own batch, continuing the sequence.
    await update(v.id, [["executive-summary", BODY("Reworded again:")]]);
    const more = await edits(v.id);
    assert.deepEqual(more.map((r) => r.seq), [1, 2, 3]);
    assert.notEqual(more[2]!.batchId, more[0]!.batchId);
    assert.equal(more[2]!.beforeHtml, BODY("Our carbon story:"), "the next change starts from where the last left it");
  });

  it("an Update that changes nothing writes nothing and moves nothing", async () => {
    const v = await sent();
    const startVersion = await version(v.id);
    const result = await update(v.id, [["executive-summary", await body(v.id, "executive-summary")]]);
    assert.deepEqual([result.data.changedSections, result.data.batchId, await version(v.id), (await edits(v.id)).length], [[], null, startVersion, 0]);
  });

  it("only a round open for review may be edited: validated, client_approved, published and superseded are refused, in the client's words, and nothing is written", async () => {
    const unsent = await validated();
    await assert.rejects(update(unsent.id, [["executive-summary", BODY("Too early:")]]), (error: unknown) => refusedWith("PRECONDITION")(error) && /not open for your edits/.test((error as CommandValidationError).issues[0]!.message));

    const approved = await sent();
    await approveReportAsClient(database.pool, { reportVersionId: approved.id, expectedVersion: await version(approved.id) }, portal("pu-1"));
    await assert.rejects(update(approved.id, [["executive-summary", BODY("After approving:")]]), (error: unknown) => refusedWith("PRECONDITION")(error) && /You have approved this report, so it is locked/.test((error as CommandValidationError).issues[0]!.message));

    await finalApproveReport(database.pool, { reportVersionId: approved.id, expectedStatus: "client_approved", manifestVersion: 1, reviewedSnapshotId: approved.snapshotId, expectedVersion: await version(approved.id) }, staff("rev", "reviewer"));
    await assert.rejects(update(approved.id, [["executive-summary", BODY("After issue:")]]), (error: unknown) => refusedWith("PRECONDITION")(error) && /has been issued/.test((error as CommandValidationError).issues[0]!.message));

    const replaced = await validated();
    await q(`UPDATE nzi_console.report_versions SET status = 'superseded' WHERE report_version_id = $1`, [replaced.id]);
    await assert.rejects(update(replaced.id, [["executive-summary", BODY("Replaced:")]]), (error: unknown) => refusedWith("PRECONDITION")(error) && /newer version/.test((error as CommandValidationError).issues[0]!.message));

    for (const id of [unsent.id, approved.id, replaced.id]) assert.equal((await edits(id)).length, 0, "no history row for a refused Update");
    assert.doesNotMatch(JSON.stringify(await frozen(approved.id)), /After approving|After issue/);
  });

  it("is pinned to the version the client saw: a stale screen is refused and nothing changes", async () => {
    const v = await sent();
    const seen = await version(v.id);
    await updateReportNarrative(database.pool, { reportVersionId: v.id, expectedVersion: seen, sectionKey: "executive-summary", change: "edit", bodyHtml: BODY("The CRM amended:") }, staff("ada", "admin"));
    await assert.rejects(update(v.id, [["background", BODY("My stale edit:")]], "pu-1", seen), VersionConflictError);
    assert.doesNotMatch(await body(v.id, "background"), /My stale edit/);
    assert.equal((await edits(v.id)).filter((r) => r.principal === "portal").length, 0);
    // Reloaded, the same edit goes through - and the client then approves exactly what they edited.
    await update(v.id, [["background", BODY("My edit:")]]);
    await assert.rejects(approveReportAsClient(database.pool, { reportVersionId: v.id, expectedVersion: seen + 1 }, portal("pu-1")), VersionConflictError, "an approval of the screen before the Update is refused");
    await approveReportAsClient(database.pool, { reportVersionId: v.id, expectedVersion: await version(v.id) }, portal("pu-1"));
    assert.equal((await row(v.id)).status, "client_approved");
  });

  it("the words are held to the tokenised, no-money rule: a typed figure, money or an unknown token is refused and nothing is written", async () => {
    const v = await sent();
    const start = await version(v.id);
    for (const [label, bodyHtml, code] of [
      ["a typed figure", "<p>We emitted 13157 tonnes.</p>", "TYPED_FIGURE"],
      ["money", "<p>This saved us £4,000 a year.</p>", "MONEY"],
      ["an unknown token", `<p>See <span data-token="notAFigure"></span>.</p>`, "UNKNOWN_TOKEN"],
      ["a script", `<p>Hi</p><script>alert(1)</script>`, "UNSAFE"],
    ] as const) {
      await assert.rejects(update(v.id, [["executive-summary", BODY("A fine change:")], ["background", bodyHtml]]), refusedWith(code), label);
    }
    assert.deepEqual([await version(v.id), (await edits(v.id)).length], [start, 0], "the good edit in the same batch was not saved either: a batch is all or nothing");
    assert.doesNotMatch(await body(v.id, "executive-summary"), /A fine change/);
  });

  it("only narrative sections the version draws are editable: not a figure, chart or table, not a section it leaves out, not a duplicate", async () => {
    const v = await sent();
    await assert.rejects(update(v.id, [["not-a-section", BODY("x")]]), refusedWith("INVALID"));
    await assert.rejects(update(v.id, [["executive-summary", BODY("a")], ["executive-summary", BODY("b")]]), refusedWith("DUPLICATE"));
    await assert.rejects(updateReportAsClient(database.pool, { reportVersionId: v.id, expectedVersion: await version(v.id), edits: [] }, portal("pu-1")), refusedWith("REQUIRED"));
    // A narrative section the plan does not draw has no frozen wording to edit.
    await q(`UPDATE nzi_console.report_versions SET narrative = (SELECT jsonb_agg(e ORDER BY o) FROM jsonb_array_elements(narrative) WITH ORDINALITY AS t(e, o) WHERE e->>'key' <> 'background') WHERE report_version_id = $1`, [v.id]);
    await assert.rejects(update(v.id, [["background", BODY("Not drawn:")]]), refusedWith("NOT_EDITABLE"));
    assert.equal((await edits(v.id)).length, 0);
  });

  it("authorisation: no grant, a revoked grant, another client's user and a staff principal are each refused; nothing changes", async () => {
    const v = await sent();
    const start = await version(v.id);
    for (const user of ["pu-nogrant", "pu-revoked"]) await assert.rejects(update(v.id, [["executive-summary", BODY("Not mine:")]], user), AuthorizationError, user);
    await assert.rejects(updateReportAsClient(database.pool, { reportVersionId: v.id, expectedVersion: start, edits: [{ sectionKey: "executive-summary", bodyHtml: BODY("Other client:") }] }, portal("pu-other", OTHER_CLIENT)), AuthorizationError, "another client's user");
    await assert.rejects(updateReportAsClient(database.pool, { reportVersionId: v.id, expectedVersion: start, edits: [{ sectionKey: "executive-summary", bodyHtml: BODY("Staff:") }] }, staff("ada", "admin")), AuthorizationError, "staff cannot send the client's Update");
    assert.deepEqual([await version(v.id), (await edits(v.id)).length], [start, 0]);
  });

  it("the portal read: the granted user gets the live round and its editable sections, nobody else does, and nothing is stored", async () => {
    const v = await sent();
    const read = (user: string, clientId = CLIENT, reportVersionId?: string) => withTenantRead(database.pool, ORG, (db) => getGrantedPortalReviewRound(db, { organisationId: ORG, portalUserId: user, clientId, jobId: JOB, reportVersionId: reportVersionId ?? v.id }));
    const round = (await read("pu-1"))!;
    assert.deepEqual([round.reportVersionId, round.status, round.version, round.scopeLabel], [v.id, "in_client_review", await version(v.id), "Whole client"]);
    assert.deepEqual(round.editableSections, (round.composition.narrative ?? []).map((e) => e.key));
    assert.ok(round.editableSections.length >= 5);
    assert.equal(round.composition.reportVersionId, v.id);
    assert.equal(Number((await q(`SELECT count(*)::int AS n FROM nzi_console.report_compositions WHERE report_version_id = $1`, [v.id]))[0].n), 0, "composed live, stored nowhere");
    for (const [user, client] of [["pu-nogrant", CLIENT], ["pu-revoked", CLIENT], ["pu-other", OTHER_CLIENT]] as const) assert.equal(await read(user, client), null, user);
    // After the Update the read carries the new wording and the new version.
    await update(v.id, [["background", BODY("Reread:")]]);
    const after = (await read("pu-2"))!;
    assert.equal(after.version, round.version + 1);
    assert.equal(after.composition.narrative!.find((e) => e.key === "background")!.bodyHtml, BODY("Reread:"));
    // Once approved the client sees it, locked: no editable sections.
    await approveReportAsClient(database.pool, { reportVersionId: v.id, expectedVersion: after.version }, portal("pu-1"));
    const locked = (await read("pu-1"))!;
    assert.deepEqual([locked.status, locked.editableSections], ["client_approved", []]);
    // A direct-published report is not a review round.
    const direct = await validated();
    assert.equal(await read("pu-1", CLIENT, direct.id), null, "a validated version is not shown to the client");
  });
});
