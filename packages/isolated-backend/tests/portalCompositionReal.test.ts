import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, it } from "node:test";
import {
  clientFacingPublishedReport, commandGrantForRole, defaultReportSectionPlan, isReportGap, reportMethodologyRows, reportOmittedSections, reportSectionPlanOf,
  type CommandContext, type ReportComposition, type ReportScope, type StaffRole,
} from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { publishCrpReport, validateCrpReport } from "../src/postgresCommands";
import { getGrantedIssuerLogo, getGrantedPortalReport } from "../src/portalComposition";
import { getGrantedPortalDeliverables, portalPublicationEvidence } from "../src/portalDeliverables";
import { getReportComposition } from "../src/reportCompositions";
import { seedPortalAcceptance } from "../src/portalAcceptanceSeed";
import { withTenantRead, type Queryable } from "../src/postgres";

/**
 * Reporting F-4a (RULING-reporting-F4), against a real database: what a client may read of a published report.
 * - The frozen composition, grant-checked: the default (whole client) or the scope named; never another client's, an ungranted
 *   job's, another job's version, or an unknown one.
 * - D1: a version with no composition (issued before 0077) is `pre-composition` — none is ever made for it.
 * - D6: the client's copy carries no internal strategy owner; the staff copy keeps it.
 * - D4: the issuer logo only when it is the frozen issuer logo of a report the user may see.
 * - D5: documents for the version named, their figures from that report's own view — a site report's documents carry its
 *   sites and say what they leave out; totals checked against the frozen composition.
 */
const ORG = "pcomp-org";
const CLIENT = "pcomp-client";
const OTHER = "pcomp-other";
const PORTAL = "pcomp-portal";
const OUTSIDER = "pcomp-outsider";
const ISSUER_LOGO = "issuer-logo-1";
const STRATEGY_OWNER = "strategy-owner-q7x";

describe("the client portal reads the frozen composition (F-4a), against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let count = 0;
  const context = (actor: string, role: StaffRole): CommandContext => {
    count += 1;
    return { organisationId: ORG, actorId: actor, principal: "staff", idempotencyKey: `pc-${count}`, correlationId: `corr-pc-${count}`, grant: commandGrantForRole(role, ORG, actor) };
  };
  const q = async (sql: string, params: unknown[] = []) => { const db = await database.admin(); try { return (await db.query(sql, params)).rows; } finally { await db.end(); } };
  const read = <T>(work: (db: Queryable) => Promise<T>) => withTenantRead(database.pool, ORG, work);
  const issue = async (snapshotId: string, scope?: ReportScope) => {
    const reportVersionId = (await validateCrpReport(database.pool, { reviewedSnapshotId: snapshotId, manifestVersion: 1, ...(scope ? { scope } : {}) }, context("rev", "reviewer"))).data.reportVersionId;
    await publishCrpReport(database.pool, { reportVersionId, expectedStatus: "validated", expectedVersion: 1, manifestVersion: 1, reviewedSnapshotId: snapshotId }, context("rev", "reviewer"));
    return reportVersionId;
  };
  const snapshot = async (snapshotId: string, jobId: string, clientName: string) => {
    const payload = { jobNumber: `J-${jobId}`, client: clientName, reportingYear: 2025,
      measurements: [
        { rowId: `${snapshotId}-a`, scope: "1", scopeCode: "1", siteId: "s-a", siteLabel: "Works", sourceLabel: "Gas", tco2e: 10, qualityTier: "measured", factorSet: "demo" },
        { rowId: `${snapshotId}-b`, scope: "2", scopeCode: "2", siteId: "s-b", siteLabel: "Annex", sourceLabel: "Electricity", tco2e: 5, qualityTier: "measured", factorSet: "demo" },
        { rowId: `${snapshotId}-g`, scope: "3", scopeCode: "3.1", siteId: null, siteLabel: null, sourceLabel: "Goods", tco2e: 20, qualityTier: "estimated", factorSet: "demo", purchasedGoodsCategoryId: "pg", purchasedGoodsCategoryLabel: "Materials" }],
      target: { baselineYear: 2024, baselineTco2e: 40, interimYear: 2030, interimReductionPercent: 50, netZeroYear: 2045 },
      intensityTarget: { source: "client-target", metric: "turnover", metricLabel: "Turnover", denominatorUnit: "£m", reportingDenominator: 12.5, baselineYear: 2024, baselineIntensity: 3,
        interimYear: 2030, interimReductionPercent: 50, targetYear: 2045, targetReductionPercent: 100, netZeroYear: null, jobId, version: 1, updatedAt: "2026-01-01T00:00:00.000Z", updatedBy: "ada" },
      annualComparison: [{ year: 2024, values: [{ scope: "1", value: 12 }] }, { year: 2025, values: [{ scope: "1", value: 10 }] }],
      provenance: { resolver: "crp.snapshot.issue@2", reportingPeriod: { from: "2025-01-01", to: "2025-12-31" }, factorSets: [], boundary: { siteIds: ["s-a", "s-b"], excludedRowIds: [] } } };
    await q(`INSERT INTO nzi_console.reviewed_crp_snapshots (organisation_id, snapshot_id, job_id, snapshot_version, job_version, data_hash, payload_json, created_by, approved_by, approved_at)
             VALUES ($1, $2, $3, 1, 1, $4, $5::jsonb, 'prep', 'rev', now())`, [ORG, snapshotId, jobId, `sha256:${createHash("sha256").update(snapshotId).digest("hex")}`, JSON.stringify(payload)]);
  };
  const as = (portalUserId: string, clientId: string, jobId: string, reportVersionId?: string | null) => ({ portalUserId, clientId, jobId, reportVersionId });
  let whole = "", works = "", legacy = "", foreign = "";

  before(async () => {
    database = (await createDisposableDatabase("portalcomposition"))!;
    await q(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $1)`, [ORG]);
    await q(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    await q(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name) VALUES ($1, 'ada', 'admin', 'active', 'Ada'), ($1, 'rev', 'reviewer', 'active', 'Rev'), ($1, $2, 'admin', 'active', 'Owner')`, [ORG, STRATEGY_OWNER]);
    for (const [id, name] of [[CLIENT, "Portal Co"], [OTHER, "Other Co"]] as const) {
      await q(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status, currency) VALUES ($1, $2, $3, 'active', 'GBP')`, [ORG, id, name]);
      await q(`INSERT INTO nzi_console.client_sites (organisation_id, client_id, site_id, name, in_service_from, created_by) VALUES ($1, $2, $3, 'Works', '2020-01-01', 'seed'), ($1, $2, $4, 'Annex', '2020-01-01', 'seed')`,
        [ORG, id, id === CLIENT ? "s-a" : "o-a", id === CLIENT ? "s-b" : "o-b"]);
    }
    // Strategies (owned by a distinctive internal user, so a leak of the name anywhere is unmistakable) and an SRS
    // assessment, so the plan section is composed (D6).
    await seedPortalAcceptance(database.pool, { organisationId: ORG, actorId: STRATEGY_OWNER, clientId: CLIENT });
    for (const [jobId, clientId, sequence] of [["j-main", CLIENT, 9701], ["j-legacy", CLIENT, 9702], ["j-ungranted", CLIENT, 9703], ["j-foreign", OTHER, 9704]] as const) {
      await q(`INSERT INTO nzi_console.jobs (organisation_id, job_id, client_id, sequence, job_family, title, status, workflow_stage, reporting_year) VALUES ($1, $2, $3, $4, 'crp', 'CRP', 'open', 'delivery', 2025)`, [ORG, jobId, clientId, sequence]);
      await q(`INSERT INTO nzi_console.job_emissions_config (organisation_id, job_id, reporting_from, reporting_to, country_code) VALUES ($1, $2, '2025-01-01', '2025-12-31', 'GB')`, [ORG, jobId]);
    }
    await snapshot("snap-main", "j-main", "Portal Co");
    await snapshot("snap-legacy", "j-legacy", "Portal Co");
    await snapshot("snap-ungranted", "j-ungranted", "Portal Co");
    whole = await issue("snap-main");
    works = await issue("snap-main", { kind: "sites", siteIds: ["s-a"] });
    legacy = await issue("snap-legacy");
    await issue("snap-ungranted");
    // Issued before 0077: no composition was ever frozen for it (removed here as the owner; the app role cannot).
    await q(`DELETE FROM nzi_console.report_compositions WHERE report_version_id = $1`, [legacy]);
    // The issuer logo the main whole-client report froze.
    await q(`INSERT INTO nzi_console.organisation_logo_assets (organisation_id, asset_id, file_name, content_type, byte_size, sha256, content, uploaded_by) VALUES ($1, $2, 'logo.svg', 'image/svg+xml', 11, $3, $4, 'ada')`,
      [ORG, ISSUER_LOGO, createHash("sha256").update("<svg></svg>").digest("hex"), Buffer.from("<svg></svg>")]);
    await q(`UPDATE nzi_console.report_versions SET issuer_logo_asset_id = $2 WHERE report_version_id = $1`, [whole, ISSUER_LOGO]);
    for (const [user, clientId, jobs] of [[PORTAL, CLIENT, ["j-main", "j-legacy"]], [OUTSIDER, OTHER, ["j-foreign"]]] as const) {
      await q(`INSERT INTO nzi_console.portal_users (organisation_id, portal_user_id, client_id, status) VALUES ($1, $2, $3, 'active')`, [ORG, user, clientId]);
      for (const jobId of jobs) {
        await q(`INSERT INTO nzi_console.portal_access_grants (organisation_id, grant_id, client_id, portal_user_id, job_id, data_entry_starts_at, data_entry_expires_at)
                 VALUES ($1, $2, $3, $4, $5, now() - interval '1 day', now() + interval '30 days')`, [ORG, `grant-${user}-${jobId}`, clientId, user, jobId]);
      }
    }
    foreign = "never-issued";
  });
  after(async () => { await database?.end(); });

  it("reads the frozen composition: the whole-client report by default, the site report when named — scoped, as frozen", async () => {
    const byDefault = await read((db) => getGrantedPortalReport(db, as(PORTAL, CLIENT, "j-main")));
    assert.equal(byDefault?.state, "composed");
    assert.equal(byDefault!.report.reportVersionId, whole);
    const site = await read((db) => getGrantedPortalReport(db, as(PORTAL, CLIENT, "j-main", works)));
    assert.equal(site?.state, "composed");
    if (site?.state !== "composed" || isReportGap(site.composition.emissions)) throw new Error("expected a composed site report");
    assert.deepEqual(site.composition.scope, { kind: "sites", siteIds: ["s-a"], siteLabels: ["Works"] });
    assert.equal(site.composition.emissions.totalTco2e, 10, "the site's figures, not the whole client's 35");
    assert.equal(site.composition.reportVersionId, works);
  });

  it("D6: the client's copy carries no internal strategy owner; the staff copy keeps them", async () => {
    const view = await read((db) => getGrantedPortalReport(db, as(PORTAL, CLIENT, "j-main")));
    const staff = (await read((db) => getReportComposition(db, whole)))!;
    const owners = (composition: ReportComposition) => isReportGap(composition.plan) ? [] : composition.plan.groups.flatMap((group) => group.strategies.map((strategy) => strategy.owner));
    assert.ok(owners(staff).length > 0 && owners(staff).every((owner) => owner === STRATEGY_OWNER), "the staff copy names the owner");
    assert.ok(view?.state === "composed" && owners(view.composition).every((owner) => owner === ""), "none reach the client");
    assert.ok(!JSON.stringify(view).includes(STRATEGY_OWNER), "not anywhere in the client's payload");
  });

  it("D1: a version issued before compositions is pre-composition — none is ever made for it", async () => {
    const view = await read((db) => getGrantedPortalReport(db, as(PORTAL, CLIENT, "j-legacy")));
    assert.equal(view?.state, "pre-composition");
    assert.equal(view!.report.reportVersionId, legacy);
    assert.equal((await q(`SELECT count(*)::int AS n FROM nzi_console.report_compositions WHERE report_version_id = $1`, [legacy]))[0]!.n, 0, "reading it froze nothing");
  });

  it("refuses another client's user, an ungranted job, another job's version and an unknown version", async () => {
    assert.equal(await read((db) => getGrantedPortalReport(db, as(OUTSIDER, OTHER, "j-main"))), null, "another client's user");
    assert.equal(await read((db) => getGrantedPortalReport(db, as(OUTSIDER, CLIENT, "j-main"))), null, "claiming the client without its grant");
    assert.equal(await read((db) => getGrantedPortalReport(db, as(PORTAL, CLIENT, "j-ungranted"))), null, "a job the user holds no grant to");
    assert.equal(await read((db) => getGrantedPortalReport(db, as(PORTAL, CLIENT, "j-main", legacy))), null, "another job's version, named");
    assert.equal(await read((db) => getGrantedPortalReport(db, as(PORTAL, CLIENT, "j-main", foreign))), null, "an unknown version");
  });

  it("D4: serves the issuer logo only when it is the frozen issuer logo of a report the user may see", async () => {
    const granted = await read((db) => getGrantedIssuerLogo(db, { organisationId: ORG, ...as(PORTAL, CLIENT, "j-main"), assetId: ISSUER_LOGO }));
    assert.equal(granted?.assetId, ISSUER_LOGO);
    assert.equal(await read((db) => getGrantedIssuerLogo(db, { organisationId: ORG, ...as(OUTSIDER, OTHER, "j-main"), assetId: ISSUER_LOGO })), null, "not to another client");
    assert.equal(await read((db) => getGrantedIssuerLogo(db, { organisationId: ORG, ...as(PORTAL, CLIENT, "j-legacy"), assetId: ISSUER_LOGO })), null, "not through a job whose reports did not freeze it");
    assert.equal(await read((db) => getGrantedIssuerLogo(db, { organisationId: ORG, ...as(PORTAL, CLIENT, "j-main"), assetId: "any-other-asset" })), null, "never another organisation asset");
  });

  it("D5: a site report's documents carry its sites and say what they leave out; the whole report's carry everything; a pre-0077 one keeps its snapshot", async () => {
    const site = (await read((db) => getGrantedPortalDeliverables(db, as(PORTAL, CLIENT, "j-main", works))))!;
    assert.equal(site.report.reportVersionId, works, "the version named, not the default");
    assert.ok(site.documents.every((document) => document.reportVersionId === works));
    const siteEvidence = portalPublicationEvidence(site.report, site.composition);
    assert.deepEqual([siteEvidence.basis, siteEvidence.scopeLabel], ["composition", "Works"]);
    assert.deepEqual(siteEvidence.scopeTotals, [{ scope: "1", tco2e: 10 }, { scope: "2", tco2e: 0 }, { scope: "3", tco2e: 0 }]);
    assert.deepEqual(siteEvidence.measurements.map((row) => row.sourceLabel), ["Gas"], "only Works' rows");
    assert.match(siteEvidence.unallocatedStatement ?? "", /not attributable to a site/);
    const wholeDocs = (await read((db) => getGrantedPortalDeliverables(db, as(PORTAL, CLIENT, "j-main"))))!;
    const wholeEvidence = portalPublicationEvidence(wholeDocs.report, wholeDocs.composition);
    assert.deepEqual(wholeEvidence.scopeTotals.map((item) => item.tco2e), [10, 5, 20]);
    assert.equal(wholeEvidence.unallocatedStatement, null);
    const legacyDocs = (await read((db) => getGrantedPortalDeliverables(db, as(PORTAL, CLIENT, "j-legacy"))))!;
    assert.deepEqual([legacyDocs.composition, portalPublicationEvidence(legacyDocs.report, legacyDocs.composition).basis], [null, "snapshot"]);
  });

  it("F-4b: a report that leaves a section out reaches the client with it frozen out and stated; the client's copy names none of the issuer's staff", async () => {
    // Every staff identity a published report can carry is seeded with one distinctive mark, so a leak anywhere is unmistakable.
    const MARK = "staffmark-z9k";
    await q(`INSERT INTO nzi_console.jobs (organisation_id, job_id, client_id, sequence, job_family, title, status, workflow_stage, reporting_year) VALUES ($1, 'j-excl', $2, 9705, 'crp', 'CRP', 'open', 'delivery', 2025)`, [ORG, CLIENT]);
    await q(`INSERT INTO nzi_console.job_emissions_config (organisation_id, job_id, reporting_from, reporting_to, country_code) VALUES ($1, 'j-excl', '2025-01-01', '2025-12-31', 'GB')`, [ORG]);
    const payload = { jobNumber: "J-excl", client: "Portal Co", reportingYear: 2025,
      measurements: [
        { rowId: "x-a", rowVersion: 1, scope: "1", scopeCode: "1", siteId: "s-a", siteLabel: "Works", sourceLabel: "Gas", tco2e: 10, qualityTier: "measured", factorSet: "demo", reviewedBy: `${MARK}-row-reviewer` },
        { rowId: "x-g", rowVersion: 1, scope: "3", scopeCode: "3.1", siteId: null, siteLabel: null, sourceLabel: "Goods", tco2e: 20, qualityTier: "estimated", factorSet: "demo", purchasedGoodsCategoryId: "pg", purchasedGoodsCategoryLabel: "Materials", reviewedBy: `${MARK}-row-reviewer` }],
      target: { jobId: "j-excl", baselineYear: 2024, baselineTco2e: 40, interimYear: 2030, interimReductionPercent: 50, netZeroYear: 2045, version: 1, updatedAt: "2026-01-01T00:00:00.000Z", updatedBy: `${MARK}-target-editor` },
      intensityTarget: { source: "client-target", metric: "turnover", metricLabel: "Turnover", denominatorUnit: "£m", reportingDenominator: 12.5, baselineYear: 2024, baselineIntensity: 3,
        interimYear: 2030, interimReductionPercent: 50, targetYear: 2045, targetReductionPercent: 100, netZeroYear: null, jobId: "j-excl", version: 1, updatedAt: "2026-01-01T00:00:00.000Z", updatedBy: `${MARK}-intensity-editor` },
      sections: [{ key: "executive-summary", title: "Executive summary", ordinal: 10, contentSource: "edited", bodyHtml: "<p>Summary.</p>", version: 2, updatedBy: `${MARK}-section-editor`, updatedAt: "2026-01-01T00:00:00.000Z" }],
      gapResolutions: [{ gapKey: "g1", reason: "Recorded as nil.", resolvedBy: `${MARK}-gap-resolver`, resolvedAt: "2026-01-01T00:00:00.000Z" }],
      annualComparison: [{ year: 2024, values: [{ scope: "1", value: 12 }] }, { year: 2025, values: [{ scope: "1", value: 10 }] }],
      provenance: { resolver: "crp.snapshot.issue@2", reportingPeriod: { from: "2025-01-01", to: "2025-12-31" }, factorSets: [], boundary: { siteIds: ["s-a", "s-b"], excludedRowIds: [] } } };
    await q(`INSERT INTO nzi_console.reviewed_crp_snapshots (organisation_id, snapshot_id, job_id, snapshot_version, job_version, data_hash, payload_json, created_by, approved_by, approved_at)
             VALUES ($1, 'snap-excl', 'j-excl', 1, 1, $2, $3::jsonb, $4, 'rev', now())`, [ORG, `sha256:${createHash("sha256").update("snap-excl").digest("hex")}`, JSON.stringify(payload), `${MARK}-preparer`]);
    const withoutTargets = defaultReportSectionPlan.map((entry) => entry.key === "targets" ? { ...entry, included: false } : entry);
    const reportVersionId = (await validateCrpReport(database.pool, { reviewedSnapshotId: "snap-excl", manifestVersion: 1 }, context("rev", "reviewer"))).data.reportVersionId;
    // Exclusion is held (no command may leave a section out yet), so the plan is set as the owner — the version as it will be
    // once the flip lands — and issued through the real publish, which freezes the version's plan.
    await q(`UPDATE nzi_console.report_versions SET section_plan = $2::jsonb, section_plan_origin = 'edited' WHERE report_version_id = $1`, [reportVersionId, JSON.stringify(withoutTargets)]);
    await publishCrpReport(database.pool, { reportVersionId, expectedStatus: "validated", expectedVersion: 1, manifestVersion: 1, reviewedSnapshotId: "snap-excl" }, context("rev", "reviewer"));
    await q(`INSERT INTO nzi_console.portal_access_grants (organisation_id, grant_id, client_id, portal_user_id, job_id, data_entry_starts_at, data_entry_expires_at)
             VALUES ($1, 'grant-excl', $2, $3, 'j-excl', now() - interval '1 day', now() + interval '30 days')`, [ORG, CLIENT, PORTAL]);

    const view = await read((db) => getGrantedPortalReport(db, as(PORTAL, CLIENT, "j-excl")));
    if (view?.state !== "composed") throw new Error("expected the composed report");
    // Left out, frozen out, and said: the client's copy carries the issued plan, and its Methodology states the omission.
    assert.equal(reportSectionPlanOf(view.composition).find((entry) => entry.key === "targets")!.included, false);
    assert.deepEqual(reportOmittedSections(reportSectionPlanOf(view.composition)), ["Targets & reduction pathway"]);
    // No reviewer on the client's copy, and so no "Reviewed by" line; the staff copy keeps both.
    const staff = (await read((db) => getReportComposition(db, reportVersionId)))!;
    assert.equal(staff.assurance.reviewedBy, `${MARK}-preparer`);
    assert.ok(reportMethodologyRows(staff).some((row) => row.label === "Reviewed by"));
    assert.equal(view.composition.assurance.reviewedBy, "");
    assert.ok(!reportMethodologyRows(view.composition).some((row) => row.label === "Reviewed by"), "the line goes, with no name or organisation in its place");
    assert.ok(reportMethodologyRows(view.composition).some((row) => row.label === "Assurance basis"), "the basis stands alone");
    // The published report as the route sends it: every staff identity gone, every figure the same.
    const staffCopy = JSON.stringify(view.report);
    for (const who of ["preparer", "row-reviewer", "target-editor", "intensity-editor", "section-editor", "gap-resolver"]) assert.ok(staffCopy.includes(`${MARK}-${who}`), `the fixture seeds ${who}`);
    const client = clientFacingPublishedReport(view.report);
    assert.ok(!JSON.stringify({ report: client, composition: view.composition }).includes(MARK), "no staff identity anywhere in what the client is sent");
    assert.deepEqual(client.snapshot.measurements.map((row) => [row.rowId, row.tco2e, row.sourceLabel]), view.report.snapshot.measurements.map((row) => [row.rowId, row.tco2e, row.sourceLabel]));
    assert.deepEqual([client.snapshot.target?.baselineTco2e, client.snapshot.intensityTarget?.reportingDenominator, client.dataHash], [40, 12.5, view.report.dataHash]);
  });

  it("D5: a document never disagrees with the report it is for — a total that differs from the frozen composition is refused", async () => {
    const site = (await read((db) => getGrantedPortalDeliverables(db, as(PORTAL, CLIENT, "j-main", works))))!;
    const emissions = site.composition!.emissions;
    if (isReportGap(emissions)) throw new Error("expected emissions");
    const tampered = { ...site.composition!, emissions: { ...emissions, byScope: emissions.byScope.map((entry) => ({ ...entry, tco2e: entry.tco2e + 1 })) } };
    assert.throws(() => portalPublicationEvidence(site.report, tampered), /differs from the frozen report/);
    assert.throws(() => portalPublicationEvidence(site.report, { ...site.composition!, snapshotDataHash: "sha256:other" }), /different evidence/);
  });
});
