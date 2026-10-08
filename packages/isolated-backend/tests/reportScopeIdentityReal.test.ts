import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { commandGrantForRole, type CommandContext, type ReportScope, type StaffRole } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { publishCrpReport, validateCrpReport } from "../src/postgresCommands";
import { getCurrentPublishedCrpReport, getGrantedPublishedCrpReport, listCurrentPublishedCrpReports, listGrantedPortalJobs, listGrantedPublishedCrpReports } from "../src/readModels";
import { approveGrantedPublishedReport } from "../src/portalReview";
import { listReportStatusRegister } from "../src/reportStatusRegister";
import { ScopeConflictError, VersionConflictError } from "../src/errors";
import { withTenantRead } from "../src/postgres";

/**
 * Reporting S-1 (RULING-reporting-S.md; R-S2 as updated), against a real database — migration 0163:
 * - a report version records its scope; the same snapshot may be validated once per scope, and the same scope twice is a
 *   conflict, never a raw error;
 * - a site scope may pick only the snapshot's own sites (its boundary stamp, else the sites its rows carry);
 * - "every site" is not "whole client" (ruled): two keys, two reports;
 * - several published reports per job, one per scope: publishing supersedes the same scope only; a race on one scope is a
 *   conflict;
 * - the readers: every published scope listed, whole-client first; the default is whole-client, then the most recent; a
 *   portal grant sees every scope, and approving one leaves the others unapproved;
 * - the status register keeps one row per job, at the stage that most needs attention.
 */
const ORG = "scope-org";
const CLIENT = "scope-client";
const ADMIN = "ada";
const REVIEWER = "rev";
const PORTAL = "pu-scope";

describe("report scope: identity and readers (S-1, 0163), against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let keys = 0;
  const context = (actor: string, role: StaffRole): CommandContext => {
    keys += 1;
    return { organisationId: ORG, actorId: actor, principal: "staff", idempotencyKey: `scope-${keys}`, correlationId: `corr-scope-${keys}`, grant: commandGrantForRole(role, ORG, actor) };
  };
  const q = async (sql: string, params: unknown[] = []) => { const db = await database.admin(); try { return (await db.query(sql, params)).rows; } finally { await db.end(); } };
  const read = <T>(fn: (db: never) => Promise<T>) => withTenantRead(database.pool, ORG, fn as never) as Promise<T>;
  const portal = { principal: "portal" as const, sessionId: "s", userId: PORTAL, clientId: CLIENT, organisationId: ORG, issuedAt: 0, expiresAt: Number.MAX_SAFE_INTEGER };

  const measurements = [
    { rowId: "r1", scope: "1", scopeCode: "1", siteId: "s-a", siteLabel: "Works", tco2e: 10, qualityTier: "measured", factorSet: "demo" },
    { rowId: "r2", scope: "2", scopeCode: "2", siteId: "s-b", siteLabel: "Annex", tco2e: 5, qualityTier: "measured", factorSet: "demo" },
    { rowId: "r3", scope: "3", scopeCode: "3.1", siteId: null, siteLabel: null, tco2e: 20, qualityTier: "estimated", factorSet: "demo", purchasedGoodsCategoryId: "pg", purchasedGoodsCategoryLabel: "Materials" }];
  const intensityTarget = { source: "client-target", metric: "turnover", metricLabel: "Turnover", denominatorUnit: "£m", reportingDenominator: 12.5, baselineYear: 2024, baselineIntensity: 6,
    interimYear: 2030, interimReductionPercent: 50, targetYear: 2045, targetReductionPercent: 100, netZeroYear: null, jobId: "x", version: 1, updatedAt: "2026-01-01T00:00:00.000Z", updatedBy: ADMIN };
  /** A reviewed snapshot; `stamp` is its boundary's site ids, or null for one frozen before the stamp. */
  const snapshot = async (snapshotId: string, jobId: string, version: number, stamp: string[] | null) => {
    const payload = { jobNumber: `J-${jobId}`, client: "Scope Client", reportingYear: 2025, measurements, intensityTarget,
      target: { baselineYear: 2024, baselineTco2e: 40, interimYear: 2030, interimReductionPercent: 50, netZeroYear: 2045 },
      annualComparison: [{ year: 2024, values: [{ scope: "1", value: 12 }] }, { year: 2025, values: [{ scope: "1", value: 10 }] }],
      ...(stamp ? { provenance: { resolver: "crp.snapshot.issue@2", reportingPeriod: { from: "2025-01-01", to: "2025-12-31" }, factorSets: [], boundary: { siteIds: stamp, excludedRowIds: [] } } } : {}) };
    await q(`INSERT INTO nzi_console.reviewed_crp_snapshots (organisation_id, snapshot_id, job_id, snapshot_version, job_version, data_hash, payload_json, created_by, approved_by, approved_at)
             VALUES ($1, $2, $3, $4, 1, $5, $6::jsonb, $7, $8, now())`, [ORG, snapshotId, jobId, version, `sha256:${createHash("sha256").update(snapshotId).digest("hex")}`, JSON.stringify(payload), ADMIN, REVIEWER]);
  };
  const validate = (snapshotId: string, scope?: ReportScope) => validateCrpReport(database.pool, { reviewedSnapshotId: snapshotId, manifestVersion: 1, ...(scope ? { scope } : {}) }, context(REVIEWER, "reviewer"));
  const publish = async (reportVersionId: string, snapshotId: string) => {
    const [row] = await q(`SELECT version FROM nzi_console.report_versions WHERE report_version_id = $1`, [reportVersionId]);
    return publishCrpReport(database.pool, { reportVersionId, expectedStatus: "validated", expectedVersion: row.version, manifestVersion: 1, reviewedSnapshotId: snapshotId }, context(REVIEWER, "reviewer"));
  };
  const statusOf = async (id: string) => (await q(`SELECT status, scope_key FROM nzi_console.report_versions WHERE report_version_id = $1`, [id]))[0];

  before(async () => {
    database = (await createDisposableDatabase("reportscope"))!;
    await q(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $1)`, [ORG]);
    await q(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name) VALUES ($1, $2, 'admin', 'active', 'Ada'), ($1, $3, 'reviewer', 'active', 'Rev')`, [ORG, ADMIN, REVIEWER]);
    await q(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status, currency) VALUES ($1, $2, 'Scope Client', 'active', 'GBP')`, [ORG, CLIENT]);
    await q(`INSERT INTO nzi_console.client_sites (organisation_id, client_id, site_id, name, in_service_from, created_by) VALUES ($1, $2, 's-a', 'Works', '2020-01-01', 'seed'), ($1, $2, 's-b', 'Annex', '2020-01-01', 'seed'), ($1, $2, 's-c', 'Depot', '2020-01-01', 'seed')`, [ORG, CLIENT]);
    for (const [jobId, sequence] of [["j-main", 9601], ["j-old", 9602], ["j-race", 9603]] as const) {
      await q(`INSERT INTO nzi_console.jobs (organisation_id, job_id, client_id, sequence, job_family, title, status, workflow_stage, reporting_year) VALUES ($1, $2, $3, $4, 'crp', 'CRP', 'open', 'delivery', 2025)`, [ORG, jobId, CLIENT, sequence]);
    }
    // The boundary stamp names a site with no rows (Depot): it is in the boundary, so it may be scoped.
    await snapshot("snap-main", "j-main", 1, ["s-a", "s-b", "s-c"]);
    await snapshot("snap-main-2", "j-main", 2, ["s-a", "s-b", "s-c"]);
    await snapshot("snap-old", "j-old", 1, null);
    await snapshot("snap-race-1", "j-race", 1, ["s-a", "s-b"]);
    await snapshot("snap-race-2", "j-race", 2, ["s-a", "s-b"]);
    await q(`INSERT INTO nzi_console.portal_users (organisation_id, portal_user_id, client_id, status) VALUES ($1, $2, $3, 'active')`, [ORG, PORTAL, CLIENT]);
    await q(`INSERT INTO nzi_console.portal_access_grants (organisation_id, grant_id, client_id, portal_user_id, job_id, data_entry_starts_at, data_entry_expires_at)
             VALUES ($1, 'grant-scope', $2, $3, 'j-main', now() - interval '1 day', now() + interval '30 days')`, [ORG, CLIENT, PORTAL]);
  });
  after(async () => { await database?.end(); });

  let whole = "", works = "";
  it("validates one snapshot once per scope, and the same scope twice is a conflict — never a raw error", async () => {
    whole = (await validate("snap-main")).data.reportVersionId;
    works = (await validate("snap-main", { kind: "sites", siteIds: ["s-a"] })).data.reportVersionId;
    assert.deepEqual([(await statusOf(whole)).scope_key, (await statusOf(works)).scope_key], ["whole", "sites:s-a"]);
    await assert.rejects(validate("snap-main", { kind: "sites", siteIds: ["s-a"] }), (error) => error instanceof ScopeConflictError && error instanceof VersionConflictError && /already validated at this scope/.test(error.message));
    await assert.rejects(validate("snap-main"), ScopeConflictError, "whole client twice, too");
  });

  it("keeps 'every site' distinct from 'whole client' (ruled) — and stores a site set canonically", async () => {
    const every = (await validate("snap-main", { kind: "sites", siteIds: ["s-c", "s-b", "s-a", "s-b"] })).data;
    assert.deepEqual(every.scope, { kind: "sites", siteIds: ["s-a", "s-b", "s-c"] }, "sorted and distinct");
    assert.equal((await statusOf(every.reportVersionId)).scope_key, "sites:s-a,s-b,s-c", "its own key — not 'whole'");
  });

  it("lets a scope pick only the snapshot's own sites: its boundary stamp, or for a pre-stamp snapshot the sites its rows carry", async () => {
    await assert.rejects(validate("snap-main", { kind: "sites", siteIds: ["s-a", "nowhere"] }), (error: any) => error.issues?.[0]?.code === "SITE_NOT_SELECTABLE");
    await assert.rejects(validate("snap-old", { kind: "sites", siteIds: ["s-c"] }), (error: any) => error.issues?.[0]?.code === "SITE_NOT_SELECTABLE", "Depot has no rows on a pre-stamp snapshot");
    assert.equal((await validate("snap-old", { kind: "sites", siteIds: ["s-b"] })).data.scope.kind, "sites");
    await assert.rejects(validate("snap-main", { kind: "sites", siteIds: [] }), (error: any) => error.issues?.some((issue: any) => issue.field === "scope.siteIds"));
  });

  it("publishes several scopes side by side; re-publishing a scope supersedes that scope only", async () => {
    await publish(whole, "snap-main");
    await publish(works, "snap-main");
    assert.deepEqual([(await statusOf(whole)).status, (await statusOf(works)).status], ["published", "published"], "whole client and Works both live");
    const wholeAgain = (await validate("snap-main-2")).data.reportVersionId;
    await publish(wholeAgain, "snap-main-2");
    assert.deepEqual([(await statusOf(whole)).status, (await statusOf(wholeAgain)).status, (await statusOf(works)).status], ["superseded", "published", "published"]);
    whole = wholeAgain;
  });

  it("turns a race to publish one scope into a conflict, not a raw error", async () => {
    const [first, second] = [(await validate("snap-race-1")).data.reportVersionId, (await validate("snap-race-2")).data.reportVersionId];
    // Another publish of the same scope is mid-flight: its row is published but not yet committed, so this publish's
    // supersede cannot see it, and its own publish waits on the index — then loses when the other commits.
    const other = await database.admin();
    try {
      await other.query("BEGIN");
      await other.query(`UPDATE nzi_console.report_versions SET status = 'published', published_at = now(), published_by = 'other' WHERE report_version_id = $1`, [first]);
      const racing = publish(second, "snap-race-2");
      await new Promise((settle) => setTimeout(settle, 400));
      await other.query("COMMIT");
      await assert.rejects(racing, (error) => error instanceof ScopeConflictError && error instanceof VersionConflictError && /published at the same moment/.test(error.message));
    } finally { await other.end(); }
    assert.deepEqual([(await statusOf(first)).status, (await statusOf(second)).status], ["published", "validated"], "the winner stands; the loser is untouched");
  });

  it("lists every published scope, whole-client first; the default is the whole-client report", async () => {
    const reports = await read((db) => listCurrentPublishedCrpReports(db, "j-main"));
    assert.deepEqual(reports.map((report) => [report.reportVersionId, report.scopeLabel]), [[whole, "Whole client"], [works, "Works"]]);
    assert.equal((await read((db) => getCurrentPublishedCrpReport(db, "j-main")))?.reportVersionId, whole);
    assert.equal((await read((db) => getCurrentPublishedCrpReport(db, "j-main", works)))?.reportVersionId, works);
    assert.equal(await read((db) => getCurrentPublishedCrpReport(db, "j-main", "not-a-version")), null);
  });

  it("defaults to the most recently published when no whole-client report is live (ruled)", async () => {
    await q(`UPDATE nzi_console.report_versions SET status = 'superseded' WHERE report_version_id = $1`, [whole]);
    try {
      assert.equal((await read((db) => getCurrentPublishedCrpReport(db, "j-main")))?.reportVersionId, works);
    } finally { await q(`UPDATE nzi_console.report_versions SET status = 'published' WHERE report_version_id = $1`, [whole]); }
  });

  it("shows a portal grant every published scope; approving one leaves the other unapproved", async () => {
    const granted = await read((db) => listGrantedPublishedCrpReports(db, { portalUserId: PORTAL, clientId: CLIENT, jobId: "j-main" }));
    assert.deepEqual(granted.map((report) => report.scopeLabel), ["Whole client", "Works"]);
    assert.equal((await read((db) => getGrantedPublishedCrpReport(db, { portalUserId: PORTAL, clientId: CLIENT, jobId: "j-main" })))?.reportVersionId, whole, "the portal opens on the whole-client report");
    await approveGrantedPublishedReport(database.pool, portal, { jobId: "j-main", reportVersionId: works });
    const [job] = (await read((db) => listGrantedPortalJobs(db, { portalUserId: PORTAL, clientId: CLIENT }))) as any[];
    assert.equal(job.approved, false, "the job-level flag is the default (whole-client) report's — not yet approved");
    assert.deepEqual(job.publishedReports.map((report: any) => [report.scopeLabel, report.approved]), [["Whole client", false], ["Works", true]]);
    assert.deepEqual(await read((db) => listGrantedPublishedCrpReports(db, { portalUserId: "nobody", clientId: CLIENT, jobId: "j-main" })), [], "no grant, no reports");
  });

  it("keeps one status row per job, at the stage that most needs attention across its scopes", async () => {
    const rows = await read((db) => listReportStatusRegister(db));
    const main = rows.filter((row) => row.jobId === "j-main");
    assert.equal(main.length, 1, "never duplicated by its published scopes");
    assert.equal(main[0]!.stage, "awaiting-client", "Works is approved, the whole-client report is not yet");
    assert.deepEqual(main[0]!.scopes, [{ scopeLabel: "Whole client", stage: "awaiting-client" }, { scopeLabel: "Works", stage: "client-approved" }]);
    assert.equal(main[0]!.publishedVersionId, whole);
  });
});
