import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { commandGrantForRole, defaultReportSectionPlan, type CommandContext, type ReportComposition, type ReportSectionPlan, type StaffRole } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { validateCrpReport } from "../src/postgresCommands";
import { previewReportComposition } from "../src/reportCompositions";
import { draftReportComposition } from "../src/reportDraftComposition";
import { withTenantRead } from "../src/postgres";

/**
 * B2-2 (REVIEW-B2-1-and-B2-rulings, Q6 approved with B0's guardrails) against a real database: the Report Studio's draft is what
 * `report.validate` would hold for a job's latest approved snapshot with the plan and scope asked for — composed READ ONLY,
 * stored nowhere — with what validate would refuse beside it, in validate's own words. And it is the same composition: validate
 * that plan and scope, and the version's B0 preview equals the draft field for field (but for its id and when it was composed).
 */
const ORG = "draft-org";
const CLIENT = "draft-client";
const JOB = "draft-job";

describe("the Report Studio's draft of a job's report, against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let count = 0;
  const context = (actor: string, role: StaffRole): CommandContext => {
    count += 1;
    return { organisationId: ORG, actorId: actor, principal: "staff", idempotencyKey: `draft-${count}`, correlationId: `corr-draft-${count}`, grant: commandGrantForRole(role, ORG, actor) };
  };
  const q = async (sql: string, params: unknown[] = []) => { const db = await database.admin(); try { return (await db.query(sql, params)).rows; } finally { await db.end(); } };
  const n = async (sql: string, params: unknown[] = []) => Number((await q(sql, params))[0]!.n);
  const draft = (input: { jobId?: string; sectionPlan?: ReportSectionPlan; scope?: { kind: "whole" } | { kind: "sites"; siteIds: string[] }; now?: Date } = {}) =>
    withTenantRead(database.pool, ORG, (db) => draftReportComposition(db, { organisationId: ORG, jobId: input.jobId ?? JOB, sectionPlan: input.sectionPlan, scope: input.scope, now: input.now }));
  // J000663's shape: one reporting year, no reduction target, no intensity target — Intensity and Targets have nothing to draw.
  const firstYearPlan = defaultReportSectionPlan.map((entry) => entry.key === "intensity" || entry.key === "targets" ? { ...entry, included: false } : entry);
  let snapshotId = "";

  before(async () => {
    database = (await createDisposableDatabase("reportdraftcomposition"))!;
    await q(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $1)`, [ORG]);
    await q(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name) VALUES ($1, 'ada', 'admin', 'active', 'Ada'), ($1, 'rev', 'reviewer', 'active', 'Rev'), ($1, 'prep', 'admin', 'active', 'Prep')`, [ORG]);
    await q(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status, currency) VALUES ($1, $2, 'Draft Co', 'active', 'GBP')`, [ORG, CLIENT]);
    await q(`INSERT INTO nzi_console.client_sites (organisation_id, client_id, site_id, name, in_service_from, created_by) VALUES ($1, $2, 's-uk', 'UK Office', '2020-01-01', 'seed')`, [ORG, CLIENT]);
    await q(`INSERT INTO nzi_console.jobs (organisation_id, job_id, client_id, sequence, job_family, title, status, workflow_stage, reporting_year) VALUES ($1, $2, $3, 9903, 'crp', 'CRP', 'open', 'delivery', 2025), ($1, 'draft-unapproved', $3, 9904, 'crp', 'CRP', 'open', 'delivery', 2025)`, [ORG, JOB, CLIENT]);
    await q(`INSERT INTO nzi_console.job_emissions_config (organisation_id, job_id, reporting_from, reporting_to, country_code) VALUES ($1, $2, '2025-01-01', '2025-12-31', 'GB')`, [ORG, JOB]);
    const insert = async (id: string, jobId: string, version: number, approved: boolean) => {
      const payload = { jobNumber: "J009903", client: "Draft Co", reportingYear: 2025,
        measurements: [
          { rowId: `${id}-a`, scope: "1", scopeCode: "1", siteId: "s-uk", siteLabel: "UK Office", sourceLabel: "Gas", tco2e: 43.4, qualityTier: "measured", factorSet: "Gas · upload.xlsx" },
          { rowId: `${id}-g`, scope: "3", scopeCode: "3.1", siteId: "s-uk", siteLabel: "UK Office", sourceLabel: "Goods", tco2e: 20, qualityTier: "estimated", factorSet: "Goods · upload.csv",
            purchasedGoodsCategoryId: "pg", purchasedGoodsCategoryLabel: "Materials" }],
        annualComparison: [{ year: 2025, values: [{ scope: "1", value: 43.4 }] }],
        provenance: { resolver: "crp.snapshot.issue@2", reportingPeriod: { from: "2025-01-01", to: "2025-12-31" }, boundary: { siteIds: ["s-uk"], excludedRowIds: [] },
          factorSets: [{ source: "dataset", id: "uk-ghg-gb-2025", name: "upload.xlsx", version: "upload.xlsx" }, { source: "dataset", id: "ceda-gb-2025", name: "upload.csv", version: "upload.csv" }] } };
      await q(`INSERT INTO nzi_console.reviewed_crp_snapshots (organisation_id, snapshot_id, job_id, snapshot_version, job_version, data_hash, payload_json, created_by, approved_by, approved_at)
               VALUES ($1, $2, $3, $4, 1, $5, $6::jsonb, 'prep', $7, $8)`, [ORG, id, jobId, version, `sha256:${createHash("sha256").update(id).digest("hex")}`, JSON.stringify(payload), approved ? "rev" : null, approved ? new Date() : null]);
    };
    await insert("draft-snap-1", JOB, 1, true);
    await insert("draft-snap-2", JOB, 2, false);
    await insert("draft-unapproved-1", "draft-unapproved", 1, false);
    snapshotId = "draft-snap-1";
  });
  after(async () => { await database?.end(); });

  it("drafts the job's latest APPROVED snapshot — an unapproved one never reaches a report; no approved snapshot, no draft", async () => {
    const drafted = (await draft())!;
    assert.equal(drafted.snapshotId, snapshotId, "version 2 is unapproved, so version 1 is drafted");
    assert.equal(drafted.snapshotVersion, 1);
    assert.equal(drafted.composition.renderer, "composed@4", "a draft is drawn as a new composition would be");
    assert.equal(await draft({ jobId: "draft-unapproved" }), null);
    assert.equal(await draft({ jobId: "no-such-job" }), null);
  });

  it("says what validate would refuse, in its words — the first-year blockers — and clears them when the plan leaves those sections out", async () => {
    const standard = (await draft())!;
    assert.deepEqual(standard.blockers.map((blocker) => blocker.field).sort(), ["intensity_pathway", "reduction_pathway"]);
    assert.ok(standard.blockers.every((blocker) => blocker.code === "MISSING_REQUIRED_CHART"));
    assert.equal(standard.planOrigin, "default");
    const firstYear = (await draft({ sectionPlan: firstYearPlan }))!;
    assert.deepEqual(firstYear.blockers, []);
    assert.equal(firstYear.planOrigin, "edited");
    assert.deepEqual(firstYear.composition.sectionPlan, firstYearPlan.map(({ key, included }) => ({ key, included })));
  });

  it("a plan that breaks the plan rules, or a site outside the snapshot, is a blocker — and the draft keeps to what could be held", async () => {
    const noCover = (await draft({ sectionPlan: defaultReportSectionPlan.filter((entry) => entry.key !== "cover") }))!;
    assert.ok(noCover.blockers.length > 0, "a plan with no cover could never be validated");
    assert.deepEqual(noCover.sectionPlan, defaultReportSectionPlan.map(({ key, included }) => ({ key, included })), "the draft shows the plan validate would fall back to");
    const elsewhere = (await draft({ sectionPlan: firstYearPlan, scope: { kind: "sites", siteIds: ["s-elsewhere"] } }))!;
    assert.ok(elsewhere.blockers.some((blocker) => blocker.code === "SITE_NOT_SELECTABLE"));
    assert.deepEqual(elsewhere.scope, { kind: "whole" });
    const uk = (await draft({ sectionPlan: firstYearPlan, scope: { kind: "sites", siteIds: ["s-uk"] } }))!;
    assert.deepEqual([uk.blockers, uk.scope], [[], { kind: "sites", siteIds: ["s-uk"] }]);
    assert.deepEqual(uk.scopeChoices.sites.map((site) => site.siteId), ["s-uk"], "the scope selector's choices are the snapshot's own sites");
  });

  it("stores nothing and runs read only: a write in the same transaction is refused", async () => {
    await draft({ sectionPlan: firstYearPlan });
    assert.equal(await n(`SELECT count(*) AS n FROM nzi_console.report_versions WHERE organisation_id = $1`, [ORG]), 0, "no version");
    assert.equal(await n(`SELECT count(*) AS n FROM nzi_console.report_compositions WHERE organisation_id = $1`, [ORG]), 0, "no composition");
    await assert.rejects(withTenantRead(database.pool, ORG, async (db) => {
      await draftReportComposition(db, { organisationId: ORG, jobId: JOB, sectionPlan: firstYearPlan });
      await db.query(`UPDATE nzi_console.jobs SET title = title WHERE job_id = $1`, [JOB]);
    }), /read-only/);
  });

  it("is the composition validate then holds: the draft equals the validated version's B0 preview, field for field", async () => {
    const drafted = (await draft({ sectionPlan: firstYearPlan, scope: { kind: "sites", siteIds: ["s-uk"] }, now: new Date("2026-10-15T09:00:00.000Z") }))!;
    const validated = await validateCrpReport(database.pool, { reviewedSnapshotId: snapshotId, manifestVersion: 1, sectionPlan: firstYearPlan, scope: { kind: "sites", siteIds: ["s-uk"] } }, context("rev", "reviewer"));
    const previewed = (await withTenantRead(database.pool, ORG, (db) => previewReportComposition(db, { organisationId: ORG, reportVersionId: validated.data.reportVersionId, now: new Date("2026-10-15T10:00:00.000Z") })))!;
    // Only the id ("draft" vs the version's) and the moment of composing may differ; the id is set as a field, never by
    // string replacement (the word "draft" is also in this fixture's snapshot and job ids).
    const comparable = (composition: ReportComposition) => JSON.parse(JSON.stringify({ ...composition, reportVersionId: "<id>" }).split(composition.issuedAt).join("<composed>"));
    assert.equal(drafted.composition.reportVersionId, "draft");
    assert.deepEqual(comparable(drafted.composition), comparable(previewed.composition));
  });
});
