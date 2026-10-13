import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { commandGrantForRole, defaultReportSectionPlan, type CommandContext, type ReportComposition, type StaffRole } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { publishCrpReport, validateCrpReport } from "../src/postgresCommands";
import { getReportComposition, previewReportComposition } from "../src/reportCompositions";
import { withTenantRead } from "../src/postgres";

/**
 * B0 (RULING-report-studio-consolidation) against a real database: the composed preview of a validated report version is the
 * composition publish would freeze — the same one, field for field, but for the moment it was composed — built in a READ ONLY
 * transaction and stored nowhere. A published version is not re-composed (it has its frozen composition); an unknown or other
 * version has nothing to preview.
 */
const ORG = "preview-org";
const CLIENT = "preview-client";
const JOB = "preview-job";

describe("the composed preview of a validated report version, against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let count = 0;
  const context = (actor: string, role: StaffRole): CommandContext => {
    count += 1;
    return { organisationId: ORG, actorId: actor, principal: "staff", idempotencyKey: `preview-${count}`, correlationId: `corr-preview-${count}`, grant: commandGrantForRole(role, ORG, actor) };
  };
  const q = async (sql: string, params: unknown[] = []) => { const db = await database.admin(); try { return (await db.query(sql, params)).rows; } finally { await db.end(); } };
  const n = async (sql: string, params: unknown[] = []) => Number((await q(sql, params))[0]!.n);
  const preview = (reportVersionId: string, now?: Date) => withTenantRead(database.pool, ORG, (db) => previewReportComposition(db, { organisationId: ORG, reportVersionId, now }));

  let snapshots = 0;
  const snapshot = async (): Promise<string> => {
    snapshots += 1;
    const snapshotId = `preview-snap-${snapshots}`;
    const payload = { jobNumber: "J009902", client: "Preview Co", reportingYear: 2025,
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
  const validate = async () => {
    const snap = await snapshot();
    const plan = defaultReportSectionPlan.map((entry) => entry.key === "srs" ? { ...entry, included: false } : entry);
    const validated = await validateCrpReport(database.pool, { reviewedSnapshotId: snap, manifestVersion: 1, sectionPlan: plan }, context("rev", "reviewer"));
    return { snap, reportVersionId: validated.data.reportVersionId };
  };

  before(async () => {
    database = (await createDisposableDatabase("reportcompositionpreview"))!;
    await q(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $1)`, [ORG]);
    await q(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name) VALUES ($1, 'ada', 'admin', 'active', 'Ada'), ($1, 'rev', 'reviewer', 'active', 'Rev'), ($1, 'prep', 'admin', 'active', 'Prep')`, [ORG]);
    await q(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status, currency) VALUES ($1, $2, 'Preview Co', 'active', 'GBP')`, [ORG, CLIENT]);
    await q(`INSERT INTO nzi_console.jobs (organisation_id, job_id, client_id, sequence, job_family, title, status, workflow_stage, reporting_year) VALUES ($1, $2, $3, 9902, 'crp', 'CRP', 'open', 'delivery', 2025)`, [ORG, JOB, CLIENT]);
    await q(`INSERT INTO nzi_console.job_emissions_config (organisation_id, job_id, reporting_from, reporting_to, country_code) VALUES ($1, $2, '2025-01-01', '2025-12-31', 'GB')`, [ORG, JOB]);
  });
  after(async () => { await database?.end(); });

  it("a validated version previews its composition — from its own snapshot and plan — and nothing is stored or changed", async () => {
    const { snap, reportVersionId } = await validate();
    const before = (await q(`SELECT version, status FROM nzi_console.report_versions WHERE report_version_id = $1`, [reportVersionId]))[0];
    const result = await preview(reportVersionId);
    assert.ok(result, "a validated version has a preview");
    assert.equal(result!.status, "validated");
    assert.deepEqual([result!.composition.reportVersionId, result!.composition.snapshotId], [reportVersionId, snap]);
    assert.equal(result!.composition.sectionPlan!.find((entry) => entry.key === "srs")!.included, false, "the version's own plan");
    assert.equal(await n(`SELECT count(*) AS n FROM nzi_console.report_compositions`), 0, "stored nowhere");
    assert.deepEqual((await q(`SELECT version, status FROM nzi_console.report_versions WHERE report_version_id = $1`, [reportVersionId]))[0], before, "the version is untouched");
  });

  it("the preview is what publish freezes: the same composition, field for field, but for when it was composed", async () => {
    const { snap, reportVersionId } = await validate();
    const previewed = (await preview(reportVersionId, new Date("2026-10-13T09:00:00.000Z")))!;
    await publishCrpReport(database.pool, { reportVersionId, expectedStatus: "validated", manifestVersion: 1, reviewedSnapshotId: snap, expectedVersion: 1 }, context("rev", "reviewer"));
    const frozen = (await withTenantRead(database.pool, ORG, (db) => getReportComposition(db, reportVersionId))) as ReportComposition;
    const without = (composition: ReportComposition) => JSON.parse(JSON.stringify(composition).split(composition.issuedAt).join("<issued>"));
    assert.notEqual(frozen.issuedAt, previewed.composition.issuedAt);
    assert.deepEqual(without(previewed.composition), without(frozen));
  });

  it("a published version is never re-composed; an unknown version has nothing to preview", async () => {
    const { snap, reportVersionId } = await validate();
    await publishCrpReport(database.pool, { reportVersionId, expectedStatus: "validated", manifestVersion: 1, reviewedSnapshotId: snap, expectedVersion: 1 }, context("rev", "reviewer"));
    assert.equal(await preview(reportVersionId), null, "published: read its frozen composition instead");
    assert.equal(await preview("no-such-version"), null);
  });

  it("the preview runs in a read-only transaction: composing cannot write", async () => {
    const { reportVersionId } = await validate();
    await assert.rejects(withTenantRead(database.pool, ORG, async (db) => {
      await previewReportComposition(db, { organisationId: ORG, reportVersionId });
      await db.query(`INSERT INTO nzi_console.report_compositions (organisation_id, composition_id, report_version_id, job_id, reviewed_snapshot_id, snapshot_data_hash, data_hash, payload_json, issued_by)
                      VALUES ($1, 'x', $2, $3, 'x', 'x', 'x', '{}'::jsonb, 'x')`, [ORG, reportVersionId, JOB]);
    }), /read-only/);
  });
});
