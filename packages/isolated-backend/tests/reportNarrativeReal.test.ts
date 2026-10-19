import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { commandGrantForRole, crpReportSectionTemplate, defaultReportSectionPlan, setReportSectionIncluded, type CommandContext, type ReportNarrativeElement, type ReportSectionPlan, type StaffRole } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { CommandValidationError, editReportSection, publishCrpReport, validateCrpReport } from "../src/postgresCommands";
import { draftReportComposition } from "../src/reportDraftComposition";
import { getReportComposition, previewReportComposition } from "../src/reportCompositions";
import { SeparationOfDutiesError } from "../src/access";
import { withTenantRead } from "../src/postgres";

/**
 * B2-4 (RULING-report-studio-B2-4; migration 0169), against a real database, through the real commands:
 * - the draft carries the job's working narrative (composed@6), exactly what validate freezes;
 * - validate freezes it onto the version — token keys, never numerals; each section's version — for the narrative the plan draws;
 * - the preview and publish draw that frozen copy (an edit after validate does not reach it), stamped composed@6;
 * - a version validated before B2-4 (narrative NULL) composes, previews and publishes as composed@5 — composed@6 is unreachable;
 * - a body edited before the rule (a typed figure) is refused at validate and shown as a draft blocker, never issued;
 * - validate still refuses the snapshot's preparer (reviewer ≠ preparer).
 */
const ORG = "narr-org", CLIENT = "narr-client", JOB = "narr-job";

describe("B2-4: the frozen narrative, against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let count = 0;
  const context = (actor: string, role: StaffRole): CommandContext => {
    count += 1;
    return { organisationId: ORG, actorId: actor, principal: "staff", idempotencyKey: `narr-${count}`, correlationId: `corr-narr-${count}`, grant: commandGrantForRole(role, ORG, actor) };
  };
  const q = async (sql: string, params: unknown[] = []) => { const db = await database.admin(); try { return (await db.query(sql, params)).rows; } finally { await db.end(); } };
  const narrativeOf = async (reportVersionId: string) => (await q(`SELECT narrative FROM nzi_console.report_versions WHERE report_version_id = $1`, [reportVersionId]))[0]!.narrative as ReportNarrativeElement[] | null;
  const draft = (sectionPlan?: ReportSectionPlan) => withTenantRead(database.pool, ORG, (db) => draftReportComposition(db, { organisationId: ORG, jobId: JOB, ...(sectionPlan ? { sectionPlan } : {}) }));
  const preview = (reportVersionId: string) => withTenantRead(database.pool, ORG, (db) => previewReportComposition(db, { organisationId: ORG, reportVersionId }));
  const validate = (snapshotId: string, actor = "rev", role: StaffRole = "reviewer", sectionPlan?: ReportSectionPlan) =>
    validateCrpReport(database.pool, { reviewedSnapshotId: snapshotId, manifestVersion: 1, ...(sectionPlan ? { sectionPlan } : {}) }, context(actor, role));

  let snapshots = 0;
  /** An approved snapshot (prepared by "prep", approved by "rev") whose payload passes the CRP manifest. */
  const snapshot = async (): Promise<string> => {
    snapshots += 1;
    const snapshotId = `narr-snap-${snapshots}`;
    const payload = { jobNumber: "J009904", client: "Narrative Co", reportingYear: 2025,
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

  before(async () => {
    database = (await createDisposableDatabase("reportnarrative"))!;
    await q(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $1)`, [ORG]);
    await q(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name) VALUES ($1, 'ada', 'admin', 'active', 'Ada'), ($1, 'rev', 'reviewer', 'active', 'Rev'), ($1, 'prep', 'admin', 'active', 'Prep')`, [ORG]);
    await q(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status, currency) VALUES ($1, $2, 'Narrative Co', 'active', 'GBP')`, [ORG, CLIENT]);
    await q(`INSERT INTO nzi_console.jobs (organisation_id, job_id, client_id, sequence, job_family, title, status, workflow_stage, reporting_year) VALUES ($1, $2, $3, 9904, 'crp', 'CRP', 'open', 'delivery', 2025)`, [ORG, JOB, CLIENT]);
    await q(`INSERT INTO nzi_console.job_emissions_config (organisation_id, job_id, reporting_from, reporting_to, country_code) VALUES ($1, $2, '2025-01-01', '2025-12-31', 'GB')`, [ORG, JOB]);
  });
  after(async () => { await database?.end(); });

  it("0169: report_versions.narrative — jsonb, NULL by default, an array or nothing, writable by the app role", async () => {
    const column = (await q(`SELECT data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'nzi_console' AND table_name = 'report_versions' AND column_name = 'narrative'`))[0];
    assert.deepEqual(column, { data_type: "jsonb", is_nullable: "YES", column_default: null });
    const check = (await q(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'report_versions_narrative_array'`))[0];
    assert.equal(check.def, "CHECK (((narrative IS NULL) OR (jsonb_typeof(narrative) = 'array'::text)))");
    const can = (await q(`SELECT has_column_privilege('nzi_console_app', 'nzi_console.report_versions', 'narrative', 'INSERT') AS ins, has_column_privilege('nzi_console_app', 'nzi_console.report_versions', 'narrative', 'UPDATE') AS upd`))[0];
    assert.deepEqual(can, { ins: true, upd: true });
  });

  it("the draft carries the working narrative (composed@6); an edit through report.section.edit recomposes it", async () => {
    await snapshot();
    const before = (await draft())!;
    assert.equal(before.composition.renderer, "composed@6");
    assert.deepEqual(before.composition.narrative!.map((element) => [element.key, element.contentSource, element.sectionVersion]), [
      ["executive-summary", "default", 0], ["net-zero-commitment", "default", 0], ["background", "default", 0],
      ["intensity-analysis", "default", 0], ["category-analysis", "default", 0], ["reduction-actions", "default", 0]]);
    assert.equal(before.composition.narrative![0]!.bodyHtml, crpReportSectionTemplate("executive-summary")!.defaultBodyHtml);
    await editReportSection(database.pool, { jobId: JOB, sectionKey: "executive-summary", expectedVersion: 0,
      bodyHtml: "<p>Our footprint was <span data-token=\"total\"></span> in <span data-token=\"reportingYear\"></span>.</p>" }, context("ada", "admin"));
    const after = (await draft())!;
    assert.deepEqual(after.composition.narrative![0], { key: "executive-summary", contentSource: "client-edited", sectionVersion: 1,
      bodyHtml: "<p>Our footprint was <span data-token=\"total\"></span> in <span data-token=\"reportingYear\"></span>.</p>" });
    assert.deepEqual(after.blockers.filter((blocker) => blocker.field.startsWith("narrative.")), []);
  });

  it("validate freezes exactly that narrative onto the version — token keys, never numerals — and preview and publish draw the frozen copy", async () => {
    const snapshotId = await snapshot();
    const drafted = (await draft())!;
    const validated = await validate(snapshotId);
    const frozen = await narrativeOf(validated.data.reportVersionId);
    assert.deepEqual(frozen, drafted.composition.narrative, "what the draft showed is what validate froze");
    for (const element of frozen!) assert.doesNotMatch(element.bodyHtml.replace(/<span data-token="[^"]*"><\/span>/g, "").replace(/Scope [123]/g, ""), /\d/, `${element.key}: no typed figure`);

    // An edit after validate reaches the working store, never the validated version.
    await editReportSection(database.pool, { jobId: JOB, sectionKey: "executive-summary", expectedVersion: 1, bodyHtml: "<p>A later edit.</p>" }, context("ada", "admin"));
    const previewed = (await preview(validated.data.reportVersionId))!;
    assert.equal(previewed.composition.renderer, "composed@6");
    assert.deepEqual(previewed.composition.narrative, frozen);

    await publishCrpReport(database.pool, { reportVersionId: validated.data.reportVersionId, expectedStatus: "validated", manifestVersion: 1, reviewedSnapshotId: snapshotId, expectedVersion: 1 }, context("rev", "reviewer"));
    const issued = (await withTenantRead(database.pool, ORG, (db) => getReportComposition(db, validated.data.reportVersionId)))!;
    assert.equal(issued.renderer, "composed@6");
    assert.deepEqual(issued.narrative, frozen, "the published report says exactly what was validated");
  });

  it("a version validated before B2-4 (no frozen narrative) previews and publishes as composed@5 — composed@6 cannot be made without one", async () => {
    const snapshotId = await snapshot();
    const validated = await validate(snapshotId);
    await q(`UPDATE nzi_console.report_versions SET narrative = NULL WHERE report_version_id = $1`, [validated.data.reportVersionId]);
    const previewed = (await preview(validated.data.reportVersionId))!;
    assert.equal(previewed.composition.renderer, "composed@5");
    assert.equal("narrative" in previewed.composition, false);
    await publishCrpReport(database.pool, { reportVersionId: validated.data.reportVersionId, expectedStatus: "validated", manifestVersion: 1, reviewedSnapshotId: snapshotId, expectedVersion: 1 }, context("rev", "reviewer"));
    const issued = (await withTenantRead(database.pool, ORG, (db) => getReportComposition(db, validated.data.reportVersionId)))!;
    assert.equal(issued.renderer, "composed@5");
    assert.equal((await q(`SELECT count(*)::int AS n FROM nzi_console.report_compositions WHERE payload_json->>'renderer' = 'composed@6' AND NOT payload_json ? 'narrative'`))[0]!.n, 0);
  });

  it("freezes a body only for the narrative the plan draws — a left-out host takes its narrative with it", async () => {
    const snapshotId = await snapshot();
    const plan = setReportSectionIncluded(defaultReportSectionPlan, "narrative:background", false, { allowExclusion: true });
    const validated = await validate(snapshotId, "rev", "reviewer", plan);
    assert.deepEqual((await narrativeOf(validated.data.reportVersionId))!.map((element) => element.key),
      ["executive-summary", "net-zero-commitment", "intensity-analysis", "category-analysis", "reduction-actions"]);
  });

  it("refuses at validate — and shows on the draft — a body edited before the rule that holds a typed figure; nothing is issued", async () => {
    await q(`UPDATE nzi_console.report_sections SET body_html = '<p>We emitted 13157 tonnes.</p>' WHERE organisation_id = $1 AND job_id = $2 AND section_key = 'executive-summary'`, [ORG, JOB]);
    const snapshotId = await snapshot();
    const blockers = (await draft())!.blockers.filter((blocker) => blocker.field === "narrative.executive-summary");
    assert.deepEqual(blockers.map((blocker) => blocker.code), ["TYPED_FIGURE"]);
    assert.match(blockers[0]!.message, /^Executive summary: "13157" is a typed figure/);
    await assert.rejects(validate(snapshotId), (error: unknown) => error instanceof CommandValidationError && error.issues.some((issue) => issue.field === "narrative.executive-summary" && issue.code === "TYPED_FIGURE"));
    assert.equal((await q(`SELECT count(*)::int AS n FROM nzi_console.report_versions WHERE reviewed_snapshot_id = $1`, [snapshotId]))[0]!.n, 0);
    await q(`UPDATE nzi_console.report_sections SET body_html = '<p>Restored.</p>' WHERE organisation_id = $1 AND job_id = $2 AND section_key = 'executive-summary'`, [ORG, JOB]);
  });

  it("validate stays the reviewer's: the snapshot's preparer is still refused (reviewer ≠ preparer)", async () => {
    const snapshotId = await snapshot();
    await assert.rejects(validate(snapshotId, "prep", "admin"), (error: unknown) => error instanceof SeparationOfDutiesError && error.permission === "report.publish");
  });
});
