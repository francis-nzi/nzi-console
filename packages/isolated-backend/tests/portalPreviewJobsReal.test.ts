import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { commandGrantForRole, roleCapabilityGrants, type CommandContext, type StaffRole } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { AuthorizationError, type PortalPrincipal, type StaffPrincipal } from "../src/auth";
import { createScopeRow, publishCrpReport, setClientPortalScopeVisibility, validateCrpReport } from "../src/postgresCommands";
import { getPortalDataView, getPortalJobEmissions, getPortalRowHistory } from "../src/portalCapture";
import { readJobEmissions } from "../src/emissionsAggregation";
import { getPortalAssuredDashboard } from "../src/portalAnalytics";
import { getGrantedPortalReport, portalPublishedReportOf } from "../src/portalComposition";
import { getScopeQaReadiness, listGrantedPublishedCrpReports } from "../src/readModels";
import { getPortalPreview } from "../src/portalPreview";
import { createPortalTrackerAction, getPortalActionTracker } from "../src/portalActions";
import { addGrantedReportComment, addStaffReportComment, listGrantedReportComments } from "../src/portalReview";
import {
  getPortalActionTrackerForStaff, getPortalAssuredDashboardForStaff, getPortalDataViewForStaff, getPortalJobEmissionsForStaff, getPortalInputSpecForStaff, getPortalPublishedReportForStaff, getPortalReportViewForStaff,
  getPortalRowHistoryForStaff, listPortalBroadcastsForStaff, listPortalPreviewJobs, listReportCommentsForStaff,
} from "../src/portalPreviewReads";
import { withTenantRead, type Queryable } from "../src/postgres";

/**
 * The staff portal preview, job-aware and grant-independent (BUILD-staff-portal-preview-job-aware), against a real database.
 *
 *  - **R2, one read path:** each staff-preview read returns what the client's own read returns for the same job — byte for byte,
 *    but for what a portal *user* owns (the data-entry window, an approval), which a preview has no user for.
 *  - **R2, two authorizers that never cross:** `support.portal_impersonate` on the client and the job the client's; refused
 *    without it, for another client's job, and to a portal principal — and a staff principal finds nothing on the grant path.
 *  - **R2, the window never gates a preview;** a job nobody is granted previews in full (R3).
 *  - **R3:** the jobs listed are the client's own, never its grants.
 *  - **R4:** the Data view honours the profile's scope visibility, exactly as the client's does.
 *  - **R1:** `portal.preview.open` names the job and the surface; a refused open writes nothing.
 *  - **R5:** nothing but the open's audit row is written by any of it.
 *  - NZC-120 and no staff identity hold in preview, inherited from the shared assembly.
 */
const ORG = "demo-nzi-console"; // the synthetic factor seed's organisation
const CLIENT = "ppj-client", OTHER = "ppj-other", BARE = "ppj-bare";
const PORTAL = "ppj-portal";
const MAIN = "ppj-main", UNGRANTED = "ppj-ungranted", EMPTY = "ppj-empty", FOREIGN = "ppj-foreign";
const DATASET = "synthetic-gb-2026";
const STAFF_NAME = "Quillon Staffwright"; // distinctive, so a leak anywhere in a client payload is unmistakable
const STAFF_IDENTITY_KEYS = ["capturedBy", "calculatedBy", "reviewedBy", "approvedBy", "decidedBy", "createdBy", "updatedBy", "preparedBy", "reviewerNote"];
const here = dirname(fileURLToPath(import.meta.url));

const staff = (role: StaffRole = "admin", userId = "ppj-ada"): StaffPrincipal => ({
  sessionId: `ppj-${role}`, userId, organisationId: ORG, issuedAt: Date.now(), expiresAt: Date.now() + 3_600_000,
  role, matrixVersion: commandGrantForRole(role, ORG, userId).matrixVersion, capabilities: roleCapabilityGrants(role),
});
const portal = { principal: "portal", organisationId: ORG, userId: PORTAL, clientId: CLIENT, sessionId: "p", issuedAt: 1, expiresAt: 2, displayName: "P", email: "p@example.invalid" } as unknown as PortalPrincipal;
const refused = (error: unknown) => error instanceof AuthorizationError;

/**
 * Every key at any depth that carries a value — for the "no staff identity reaches the client" walk. A key the client's copy
 * keeps but blanks (the composition's `assurance.reviewedBy: ""`, F-4b) carries nothing, so it is not counted.
 */
const keyPaths = (value: unknown, path = "$", into = new Map<string, string>()): Map<string, string> => {
  if (Array.isArray(value)) value.forEach((entry, index) => keyPaths(entry, `${path}[${index}]`, into));
  else if (value && typeof value === "object") for (const [key, inner] of Object.entries(value)) {
    if (inner !== "" && inner !== null && inner !== undefined && !into.has(key)) into.set(key, `${path}.${key}`);
    keyPaths(inner, `${path}.${key}`, into);
  }
  return into;
};

describe("the staff portal preview, job-aware and grant-independent, against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let count = 0;
  const context = (actor: string, role: StaffRole): CommandContext => {
    count += 1;
    return { organisationId: ORG, actorId: actor, principal: "staff", idempotencyKey: `ppj-${count}`, correlationId: `corr-ppj-${count}`, grant: commandGrantForRole(role, ORG, actor) };
  };
  const q = async (sql: string, params: unknown[] = []) => { const db = await database.admin(); try { return (await db.query(sql, params)).rows; } finally { await db.end(); } };
  const read = <T>(work: (db: Queryable) => Promise<T>) => withTenantRead(database.pool, ORG, work);
  const writes = async () => (await q(`SELECT (SELECT count(*) FROM nzi_console.audit_events)::int AS audit, (SELECT count(*) FROM nzi_console.job_scope_rows)::int AS rows,
    (SELECT count(*) FROM nzi_console.transactional_outbox)::int AS outbox, (SELECT count(*) FROM nzi_console.portal_report_approvals)::int AS approvals`))[0];
  const snapshot = async (snapshotId: string, jobId: string) => {
    // The payload `portalCompositionReal` issues, so the manifest gate passes on a known-good snapshot.
    const payload = { jobNumber: `J-${jobId}`, client: "Preview Co", reportingYear: 2025,
      measurements: [
        { rowId: `${snapshotId}-a`, scope: "1", scopeCode: "1", siteId: "ppj-s-a", siteLabel: "Works", sourceLabel: "Gas", tco2e: 10, qualityTier: "measured", factorSet: "demo" },
        { rowId: `${snapshotId}-b`, scope: "2", scopeCode: "2", siteId: "ppj-s-b", siteLabel: "Annex", sourceLabel: "Electricity", tco2e: 5, qualityTier: "measured", factorSet: "demo" },
        { rowId: `${snapshotId}-g`, scope: "3", scopeCode: "3.1", siteId: null, siteLabel: null, sourceLabel: "Goods", tco2e: 20, qualityTier: "estimated", factorSet: "demo", purchasedGoodsCategoryId: "pg", purchasedGoodsCategoryLabel: "Materials" }],
      target: { baselineYear: 2024, baselineTco2e: 40, interimYear: 2030, interimReductionPercent: 50, netZeroYear: 2045 },
      intensityTarget: { source: "client-target", metric: "turnover", metricLabel: "Turnover", denominatorUnit: "£m", reportingDenominator: 12.5, baselineYear: 2024, baselineIntensity: 3,
        interimYear: 2030, interimReductionPercent: 50, targetYear: 2045, targetReductionPercent: 100, netZeroYear: null, jobId, version: 1, updatedAt: "2026-01-01T00:00:00.000Z", updatedBy: "ppj-ada" },
      annualComparison: [{ year: 2024, values: [{ scope: "1", value: 12 }] }, { year: 2025, values: [{ scope: "1", value: 10 }] }],
      provenance: { resolver: "crp.snapshot.issue@2", reportingPeriod: { from: "2025-01-01", to: "2025-12-31" }, factorSets: [], boundary: { siteIds: ["ppj-s-a", "ppj-s-b"], excludedRowIds: [] } } };
    await q(`INSERT INTO nzi_console.reviewed_crp_snapshots (organisation_id, snapshot_id, job_id, snapshot_version, job_version, data_hash, payload_json, created_by, approved_by, approved_at)
             VALUES ($1, $2, $3, 1, 1, $4, $5::jsonb, 'ppj-ada', 'ppj-rev', now())`, [ORG, snapshotId, jobId, `sha256:${createHash("sha256").update(snapshotId).digest("hex")}`, JSON.stringify(payload)]);
  };
  const issue = async (snapshotId: string) => {
    const reportVersionId = (await validateCrpReport(database.pool, { reviewedSnapshotId: snapshotId, manifestVersion: 1 }, context("ppj-rev", "reviewer"))).data.reportVersionId;
    await publishCrpReport(database.pool, { reportVersionId, expectedStatus: "validated", expectedVersion: 1, manifestVersion: 1, reviewedSnapshotId: snapshotId }, context("ppj-rev", "reviewer"));
    return reportVersionId;
  };
  let gasRow = "";

  before(async () => {
    database = (await createDisposableDatabase("portalpreviewjobs"))!;
    await q(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $1)`, [ORG]);
    await q(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    await q(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name) VALUES ($1, 'ppj-ada', 'admin', 'active', $2), ($1, 'ppj-rev', 'reviewer', 'active', 'Rev'), ($1, 'ppj-con', 'consultant', 'active', 'Con'), ($1, 'ppj-view', 'viewer', 'active', 'View')`, [ORG, STAFF_NAME]);
    for (const [id, name] of [[CLIENT, "Preview Co"], [OTHER, "Other Co"], [BARE, "Bare Co"]] as const) {
      await q(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status, currency) VALUES ($1, $2, $3, 'active', 'GBP')`, [ORG, id, name]);
    }
    await q(`INSERT INTO nzi_console.client_sites (organisation_id, client_id, site_id, name, in_service_from, created_by) VALUES ($1, $2, 'ppj-s-a', 'Works', '2020-01-01', 'seed'), ($1, $2, 'ppj-s-b', 'Annex', '2020-01-01', 'seed')`, [ORG, CLIENT]);
    for (const [jobId, clientId, sequence] of [[MAIN, CLIENT, 9801], [UNGRANTED, CLIENT, 9802], [EMPTY, CLIENT, 9803], [FOREIGN, OTHER, 9804]] as const) {
      await q(`INSERT INTO nzi_console.jobs (organisation_id, job_id, client_id, sequence, job_family, title, status, workflow_stage, reporting_year, reporting_period_start, reporting_period_end)
               VALUES ($1, $2, $3, $4, 'crp', 'CRP', 'open', 'Data entry', 2026, '2026-01-01', '2026-12-31')`, [ORG, jobId, clientId, sequence]);
      await q(`INSERT INTO nzi_console.job_emissions_config (organisation_id, job_id, reporting_from, reporting_to, country_code) VALUES ($1, $2, '2026-01-01', '2026-12-31', 'GB')`, [ORG, jobId]);
    }
    await q(readFileSync(resolve(here, "../seeds/0003_synthetic_factors.sql"), "utf8"));
    for (const jobId of [MAIN, UNGRANTED]) {
      await q(`INSERT INTO nzi_console.job_dataset_selections (organisation_id, job_id, dataset_id, selection_source, reason, selected_by) VALUES ($1, $2, $3, 'automatic', 'Fixture', 'ppj-ada') ON CONFLICT DO NOTHING`, [ORG, jobId, DATASET]);
    }
    // A staff-captured row on each, so a captured-by name exists to leak if the client copy were not the shared one.
    for (const jobId of [MAIN, UNGRANTED]) {
      const created = await createScopeRow(database.pool, { jobId, scope: "1", categoryCode: "1.natural-gas", sourceLabel: "Boiler gas", siteId: null, quantity: 1000, unit: "kWh",
        datasetId: DATASET, factorId: "gas-demo", factorVersion: null, factorLabel: "Natural gas", notes: null, monthlyActivity: [], qualityTier: null } as never, context("ppj-ada", "admin"));
      if (jobId === MAIN) gasRow = created.data.rowId;
    }
    await snapshot("ppj-snap-main", MAIN);
    await snapshot("ppj-snap-ungranted", UNGRANTED);
    await issue("ppj-snap-main");
    await issue("ppj-snap-ungranted");
    // The client's one portal user holds MAIN only; UNGRANTED and EMPTY are granted to nobody. BARE has no portal user at all.
    await q(`INSERT INTO nzi_console.portal_users (organisation_id, portal_user_id, client_id, status) VALUES ($1, $2, $3, 'active')`, [ORG, PORTAL, CLIENT]);
    await q(`INSERT INTO nzi_console.portal_access_grants (organisation_id, grant_id, client_id, portal_user_id, job_id, data_entry_starts_at, data_entry_expires_at)
             VALUES ($1, 'ppj-grant', $2, $3, $4, now() - interval '1 day', now() + interval '30 days')`, [ORG, CLIENT, PORTAL, MAIN]);
  });
  after(async () => { await database?.end(); });

  describe("R2 — one read path: the preview returns what the client's own read returns", () => {
    it("the Data view: identical but for the window, which is a portal user's", async () => {
      const client = await getPortalDataView(database.pool, portal, MAIN);
      const preview = await getPortalDataViewForStaff(database.pool, staff(), CLIENT, MAIN);
      assert.ok(client.access, "the client's window is open");
      assert.equal(preview.access, null, "a preview has no portal user, so no window");
      assert.equal(JSON.stringify({ ...preview, access: null }), JSON.stringify({ ...client, access: null }));
      assert.ok(preview.rows.some((row) => row.id === gasRow), "the job's rows are there");
    });

    it("the totals band: the CRM's own emissions read over the client's rows, identical in preview, narrowed by site (R2)", async () => {
      const view = await getPortalDataViewForStaff(database.pool, staff(), CLIENT, MAIN);
      assert.ok(view.emissions.headline.entries > 0 && view.emissions.headline.tco2e >= 0);
      const client = await getPortalJobEmissions(database.pool, portal, MAIN, null);
      assert.equal(JSON.stringify(await getPortalJobEmissionsForStaff(database.pool, staff(), CLIENT, MAIN, null)), JSON.stringify(client));
      assert.equal(JSON.stringify(client.headline), JSON.stringify(view.emissions.headline), "the band's re-read agrees with the view's own");
      // Unhidden, the client's QA readiness is the CRM's own for the job.
      assert.deepEqual(view.qa, await read((db) => getScopeQaReadiness(db, MAIN)));
      // Unhidden, it is the CRM's read itself: one implementation, not a second.
      assert.equal(JSON.stringify(client.headline), JSON.stringify((await readJobEmissions(database.pool, { organisationId: ORG, jobId: MAIN })).headline));
      const nowhere = await getPortalJobEmissions(database.pool, portal, MAIN, "ppj-no-such-site");
      assert.equal(nowhere.headline.entries, 0, "a site with nothing has nothing");
      assert.deepEqual(nowhere.bySite, client.bySite, "the site counts stay whole while one is chosen");
      await assert.rejects(getPortalJobEmissionsForStaff(database.pool, staff(), CLIENT, FOREIGN, null), refused);
      await assert.rejects(getPortalJobEmissions(database.pool, portal, UNGRANTED, null), refused, "the client's own path needs the grant");
    });

    it("the preview carries the client's logo asset for the shell (R5), or none", async () => {
      assert.equal((await getPortalPreview(database.pool, staff(), { clientId: CLIENT, today: "2026-10-23" })).client.logoAssetId, null);
    });

    it("a row's History: identical", async () => {
      assert.deepEqual(await getPortalRowHistoryForStaff(database.pool, staff(), CLIENT, MAIN, gasRow), await getPortalRowHistory(database.pool, portal, MAIN, gasRow));
    });

    it("the dashboard: identical", async () => {
      const client = await read((db) => getPortalAssuredDashboard(db, { portalUserId: PORTAL, clientId: CLIENT, jobId: MAIN }));
      const preview = await getPortalAssuredDashboardForStaff(database.pool, staff(), CLIENT, MAIN);
      assert.equal(client.published, true);
      assert.equal(JSON.stringify(preview), JSON.stringify(client));
    });

    it("the published report and its composition: identical, with no approval", async () => {
      const client = await read(async (db) => portalPublishedReportOf(await listGrantedPublishedCrpReports(db, { portalUserId: PORTAL, clientId: CLIENT, jobId: MAIN }), null));
      const preview = await getPortalPublishedReportForStaff(database.pool, staff(), CLIENT, MAIN, null);
      assert.ok(client && preview);
      assert.equal(preview.approval, null, "an approval is a portal user's");
      assert.equal(JSON.stringify({ report: preview.report, reports: preview.reports }), JSON.stringify(client));
      const clientView = await read((db) => getGrantedPortalReport(db, { portalUserId: PORTAL, clientId: CLIENT, jobId: MAIN }));
      const previewView = await getPortalReportViewForStaff(database.pool, staff(), CLIENT, MAIN, null);
      assert.equal(previewView?.state, "composed");
      assert.equal(JSON.stringify(previewView), JSON.stringify(clientView));
    });

    it("the action tracker: identical, and read only (BUILD-portal-shell-lookandfeel, Actions)", async () => {
      await createPortalTrackerAction(database.pool, portal, MAIN, { leverCode: "A1.1", title: "Switch the fleet to EVs", notes: "", progressPercent: 40 });
      const client = await getPortalActionTracker(database.pool, portal, MAIN);
      assert.equal(client.actions.length, 1);
      assert.equal(JSON.stringify(await getPortalActionTrackerForStaff(database.pool, staff(), CLIENT, MAIN)), JSON.stringify(client));
      await assert.rejects(getPortalActionTrackerForStaff(database.pool, staff(), CLIENT, FOREIGN), refused);
      await assert.rejects(getPortalActionTrackerForStaff(database.pool, staff("viewer", "ppj-view"), CLIENT, MAIN), refused);
    });

    it("the report thread: identical, read only, and only a published report of this client's job (Messages, R7)", async () => {
      const [report] = await read((db) => listGrantedPublishedCrpReports(db, { portalUserId: PORTAL, clientId: CLIENT, jobId: MAIN }));
      assert.ok(report);
      const thread = { jobId: MAIN, reportVersionId: report.reportVersionId };
      await addGrantedReportComment(database.pool, { ...portal, displayName: "Pat Client" } as never, { ...thread, body: "Is the depot gas included?" });
      await addStaffReportComment(database.pool, staff(), { ...thread, body: "Yes — under Scope 1." });
      const client = await listGrantedReportComments(database.pool, portal, thread);
      assert.equal(client.length, 2);
      const before = await writes();
      assert.equal(JSON.stringify(await listReportCommentsForStaff(database.pool, staff(), CLIENT, MAIN, report.reportVersionId)), JSON.stringify(client));
      assert.deepEqual(await writes(), before, "reading the thread in preview writes nothing — no read receipt");
      await assert.rejects(listReportCommentsForStaff(database.pool, staff(), CLIENT, FOREIGN, report.reportVersionId), refused, "another client's job");
      await assert.rejects(listReportCommentsForStaff(database.pool, staff(), CLIENT, UNGRANTED, report.reportVersionId), refused, "another job's report");
      await assert.rejects(listReportCommentsForStaff(database.pool, staff("viewer", "ppj-view"), CLIENT, MAIN, report.reportVersionId), refused, "no capability");
    });

    it("the input spec and broadcasts: the client's own resolvers", async () => {
      assert.ok((await getPortalInputSpecForStaff(database.pool, staff(), CLIENT)).length > 0);
      assert.ok(Array.isArray(await listPortalBroadcastsForStaff(database.pool, staff(), CLIENT)));
    });
  });

  describe("R2 — two authorizers that never cross", () => {
    it("is refused without support.portal_impersonate, and held by the roles that hold it", async () => {
      await assert.rejects(getPortalDataViewForStaff(database.pool, staff("viewer", "ppj-view"), CLIENT, MAIN), refused);
      await assert.rejects(getPortalAssuredDashboardForStaff(database.pool, staff("reviewer", "ppj-rev"), CLIENT, MAIN), refused);
      await assert.rejects(listPortalPreviewJobs(database.pool, staff("viewer", "ppj-view"), CLIENT), refused);
      assert.ok(await getPortalDataViewForStaff(database.pool, staff("consultant", "ppj-con"), CLIENT, MAIN));
    });

    it("refuses a job that is not the client's, and an unknown one — on every read", async () => {
      for (const jobId of [FOREIGN, "ppj-nope"]) {
        await assert.rejects(getPortalDataViewForStaff(database.pool, staff(), CLIENT, jobId), refused, `data view ${jobId}`);
        await assert.rejects(getPortalAssuredDashboardForStaff(database.pool, staff(), CLIENT, jobId), refused, `dashboard ${jobId}`);
        await assert.rejects(getPortalPublishedReportForStaff(database.pool, staff(), CLIENT, jobId, null), refused, `report ${jobId}`);
        await assert.rejects(getPortalReportViewForStaff(database.pool, staff(), CLIENT, jobId, null), refused, `composition ${jobId}`);
        await assert.rejects(getPortalRowHistoryForStaff(database.pool, staff(), CLIENT, jobId, gasRow), refused, `history ${jobId}`);
      }
      // Claiming the job's own client is no way round it: the foreign job is OTHER's, and is previewed only as OTHER's.
      assert.ok(await getPortalDataViewForStaff(database.pool, staff(), OTHER, FOREIGN));
    });

    it("a portal principal cannot reach the staff path, and a staff principal finds nothing on the grant path", async () => {
      await assert.rejects(getPortalDataViewForStaff(database.pool, portal as unknown as StaffPrincipal, CLIENT, MAIN), refused);
      await assert.rejects(getPortalPublishedReportForStaff(database.pool, portal as unknown as StaffPrincipal, CLIENT, MAIN, null), refused);
      await assert.rejects(getPortalDataView(database.pool, staff() as unknown as PortalPrincipal, MAIN), refused);
      assert.equal(await read((db) => getGrantedPortalReport(db, { portalUserId: staff().userId, clientId: CLIENT, jobId: MAIN })), null);
    });

    it("the window never gates a preview, and a job granted to nobody previews in full (R3)", async () => {
      await q(`UPDATE nzi_console.portal_access_grants SET data_entry_starts_at = NULL, data_entry_expires_at = NULL WHERE grant_id = 'ppj-grant'`);
      try {
        assert.equal((await getPortalDataView(database.pool, portal, MAIN)).access, null, "the client's window is closed");
        assert.ok((await getPortalDataViewForStaff(database.pool, staff(), CLIENT, MAIN)).rows.length > 0, "the preview reads on");
      } finally {
        await q(`UPDATE nzi_console.portal_access_grants SET data_entry_starts_at = now() - interval '1 day', data_entry_expires_at = now() + interval '30 days' WHERE grant_id = 'ppj-grant'`);
      }
      await assert.rejects(getPortalDataView(database.pool, portal, UNGRANTED), refused, "the client cannot see an ungranted job");
      const view = await getPortalDataViewForStaff(database.pool, staff(), CLIENT, UNGRANTED);
      assert.ok(view.rows.length > 0, "but the consultant previews it");
      assert.equal((await getPortalAssuredDashboardForStaff(database.pool, staff(), CLIENT, UNGRANTED)).published, true);
      assert.ok(await getPortalPublishedReportForStaff(database.pool, staff(), CLIENT, UNGRANTED, null));
    });

    it("a job with no published report reads as the client's real empty states", async () => {
      assert.deepEqual(await getPortalAssuredDashboardForStaff(database.pool, staff(), CLIENT, EMPTY), { published: false });
      assert.equal(await getPortalPublishedReportForStaff(database.pool, staff(), CLIENT, EMPTY, null), null);
      assert.equal(await getPortalReportViewForStaff(database.pool, staff(), CLIENT, EMPTY, null), null);
    });
  });

  describe("R3 — the client's own jobs, never its grants", () => {
    it("lists every job of the client's, granted or not, and none of another client's", async () => {
      const jobs = await listPortalPreviewJobs(database.pool, staff(), CLIENT);
      assert.deepEqual(jobs.map((job) => job.id).sort(), [EMPTY, MAIN, UNGRANTED].sort());
      assert.deepEqual(jobs.filter((job) => job.hasPublishedReport).map((job) => job.id).sort(), [MAIN, UNGRANTED].sort());
      assert.ok(jobs.every((job) => job.approved === false && job.approvedAt === null && job.hasUnreadNziResponse === false), "a portal user's fields are nobody's");
    });

    it("a client with no portal user at all previews", async () => {
      const preview = await getPortalPreview(database.pool, staff(), { clientId: BARE, today: "2026-10-23" });
      assert.deepEqual(preview.jobs, []);
      assert.equal(preview.client.name, "Bare Co");
    });
  });

  describe("R4 — the profile gates the preview as it gates the client", () => {
    it("a scope switched off for the client is absent from both, alike", async () => {
      await setClientPortalScopeVisibility(database.pool, { clientId: CLIENT, scope: "1", visible: false }, context("ppj-ada", "admin"));
      try {
        const client = await getPortalDataView(database.pool, portal, MAIN);
        const preview = await getPortalDataViewForStaff(database.pool, staff(), CLIENT, MAIN);
        assert.ok(!preview.rows.some((row) => row.scope === "1"), "no scope 1 row in the preview");
        // The totals band (BUILD-portal-data-crm-parity R2) counts nothing the client cannot see: a hidden scope is in no total.
        assert.ok(!preview.emissions.byScope.some((scope) => scope.scope.startsWith("1")), "no scope 1 in the band");
        assert.equal(preview.emissions.headline.entries, preview.rows.filter((row) => row.enabled !== false).length, "the band counts exactly the rows shown");
        // Review & QA (polish fix 5): the CRM's QA readiness over the same rows — a hidden category is in no count.
        assert.equal(preview.qa.enabled, preview.rows.filter((row) => row.enabled !== false).length, "QA counts exactly the rows shown");
        assert.equal(preview.qa.total, preview.rows.length);
        assert.equal(JSON.stringify(await getPortalJobEmissionsForStaff(database.pool, staff(), CLIENT, MAIN, null)), JSON.stringify(await getPortalJobEmissions(database.pool, portal, MAIN, null)));
        assert.ok(!preview.categories.categories.some((category) => category.scope === "1"), "no scope 1 category in the preview");
        assert.equal(JSON.stringify({ ...preview, access: null }), JSON.stringify({ ...client, access: null }));
        await assert.rejects(getPortalRowHistoryForStaff(database.pool, staff(), CLIENT, MAIN, gasRow), refused, "a hidden row's History is not the preview's either");
      } finally {
        await setClientPortalScopeVisibility(database.pool, { clientId: CLIENT, scope: "1", visible: null }, context("ppj-ada", "admin"));
      }
    });
  });

  describe("R1 — the open is audited, with the job", () => {
    const opens = async () => q(`SELECT actor_id, principal_type, entity_id, after_json FROM nzi_console.audit_events WHERE action = 'portal.preview.open' ORDER BY occurred_at, audit_event_id`);

    it("portal.preview.open names the staff actor, the job and the surface", async () => {
      const before = (await opens()).length;
      const preview = await getPortalPreview(database.pool, staff(), { clientId: CLIENT, today: "2026-10-23", jobId: MAIN, surface: "data" });
      assert.equal(preview.job?.id, MAIN);
      const rows = await opens();
      assert.equal(rows.length, before + 1);
      const row = rows.at(-1)!;
      assert.equal(row.principal_type, "staff");
      assert.equal(row.actor_id, "ppj-ada");
      assert.equal(row.entity_id, CLIENT);
      assert.equal(row.after_json.jobId, MAIN);
      assert.equal(row.after_json.surface, "data");
      assert.equal(row.after_json.impersonated, false);
    });

    it("a job not the client's is refused before anything is written", async () => {
      const before = (await opens()).length;
      await assert.rejects(getPortalPreview(database.pool, staff(), { clientId: CLIENT, today: "2026-10-23", jobId: FOREIGN, surface: "report" }), refused);
      assert.equal((await opens()).length, before);
    });
  });

  describe("R5 and the client's copy", () => {
    it("no read writes anything", async () => {
      const before = await writes();
      await getPortalDataViewForStaff(database.pool, staff(), CLIENT, MAIN);
      await getPortalRowHistoryForStaff(database.pool, staff(), CLIENT, MAIN, gasRow);
      await getPortalAssuredDashboardForStaff(database.pool, staff(), CLIENT, MAIN);
      await getPortalPublishedReportForStaff(database.pool, staff(), CLIENT, MAIN, null);
      await getPortalReportViewForStaff(database.pool, staff(), CLIENT, MAIN, null);
      await listPortalPreviewJobs(database.pool, staff(), CLIENT);
      assert.deepEqual(await writes(), before);
    });

    it("no staff identity and no money reach the preview (NZC-120)", async () => {
      // The report view carries the staff-side report for the route's own checks (as the client's `getGrantedPortalReport`
      // does); the route sends only its frozen composition, the client's copy — so that is what is checked.
      const view = await getPortalReportViewForStaff(database.pool, staff(), CLIENT, MAIN, null);
      assert.equal(view?.state, "composed");
      const payloads = [
        await getPortalDataViewForStaff(database.pool, staff(), CLIENT, MAIN),
        await getPortalPublishedReportForStaff(database.pool, staff(), CLIENT, MAIN, null),
        view?.state === "composed" ? view.composition : null,
        await getPortalAssuredDashboardForStaff(database.pool, staff(), CLIENT, MAIN),
      ];
      for (const payload of payloads) {
        const keys = keyPaths(payload);
        for (const key of STAFF_IDENTITY_KEYS) assert.ok(!keys.has(key), `no ${key} (at ${keys.get(key)})`);
        assert.ok(!JSON.stringify(payload).includes(STAFF_NAME), "no member of staff's name");
        for (const key of ["price", "fee", "invoice", "quoteTotal", "netPrice"]) assert.ok(!keys.has(key), `no ${key} (at ${keys.get(key)})`);
      }
    });
  });
});
