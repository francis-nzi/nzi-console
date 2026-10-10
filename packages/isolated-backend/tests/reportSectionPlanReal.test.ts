import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, it } from "node:test";
import {
  commandGrantForRole, defaultReportSectionPlan, reportSectionLayout,
  type CommandContext, type ReportComposition, type ReportSectionPlan, type StaffRole,
} from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { publishCrpReport, validateCrpReport } from "../src/postgresCommands";
import { deactivateClientReportProfile, setClientReportProfile, updateReportSectionPlan } from "../src/reportSectionPlans";
import { getReportComposition } from "../src/reportCompositions";
import { withTenantRead } from "../src/postgres";

/**
 * Reporting F-1 (0164; RULING-reporting-F Q1–Q3, Q5, Q6; R-D1), against a real database:
 * - precedence (Q3): the default ← the client's active profile, seeding at validate ← the version's own plan; the origin
 *   recorded; a profile edited later never reaches a version already validated;
 * - the freeze: publish copies the version's plan (and the profile's issuer line) into the composition; a version validated
 *   before F-1 publishes the default;
 * - the interlock (Q5): with F-4b (the portal on the issued report) an optional section may be left out at validate, at the
 *   profile and at update, and is frozen out at publish; the narrative is refused until it is drawn; the mandatory sections
 *   always;
 * - `report.sectionPlan.update` (Q2): validated only, version-checked and bumped, re-checked, held to separation of duties,
 *   audited before and after;
 * - the profile: append-only versions, withdrawal with a reason and no plan, no money in the issuer line.
 */
const ORG = "plan-org";
const CLIENT = "plan-client";
const JOB = "plan-job";

const keys = (plan: ReportSectionPlan) => plan.map((entry) => entry.key);
/** The default with targets moved ahead of intensity — a reorder, nothing left out. */
const reordered = (): ReportSectionPlan => {
  const plan = [...defaultReportSectionPlan];
  const targets = plan.findIndex((entry) => entry.key === "targets"), intensity = plan.findIndex((entry) => entry.key === "intensity");
  [plan[intensity], plan[targets]] = [plan[targets]!, plan[intensity]!];
  return plan;
};
/** The default with the plan section moved to just after the executive summary. */
const planFirst = (): ReportSectionPlan => {
  const rest = defaultReportSectionPlan.filter((entry) => entry.key !== "plan");
  const at = rest.findIndex((entry) => entry.key === "executive-summary") + 1;
  return [...rest.slice(0, at), { key: "plan", included: true }, ...rest.slice(at)];
};
const withExcluded = (key: string): ReportSectionPlan => defaultReportSectionPlan.map((entry) => entry.key === key ? { ...entry, included: false } : entry);
const codesOf = (error: unknown) => ((error as { issues?: Array<{ code: string }> }).issues ?? []).map((issue) => issue.code);

describe("a report's section plan and the client's report profile (F-1), against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let count = 0;
  const context = (actor: string, role: StaffRole, reason?: string): CommandContext => {
    count += 1;
    return { organisationId: ORG, actorId: actor, principal: "staff", idempotencyKey: `plan-${count}`, correlationId: `corr-plan-${count}`,
      grant: commandGrantForRole(role, ORG, actor), ...(reason ? { reason } : {}) };
  };
  const q = async (sql: string, params: unknown[] = []) => { const db = await database.admin(); try { return (await db.query(sql, params)).rows; } finally { await db.end(); } };
  const versionRow = async (id: string) => (await q(`SELECT version, status, section_plan, section_plan_origin, client_issuer_line FROM nzi_console.report_versions WHERE report_version_id = $1`, [id]))[0] as
    { version: number; status: string; section_plan: ReportSectionPlan | null; section_plan_origin: string | null; client_issuer_line: string | null };
  const validate = (snapshotId: string, sectionPlan?: ReportSectionPlan) =>
    validateCrpReport(database.pool, { reviewedSnapshotId: snapshotId, manifestVersion: 1, ...(sectionPlan ? { sectionPlan } : {}) }, context("rev", "reviewer"));
  const publish = (reportVersionId: string, snapshotId: string, expectedVersion: number) =>
    publishCrpReport(database.pool, { reportVersionId, expectedStatus: "validated", manifestVersion: 1, reviewedSnapshotId: snapshotId, expectedVersion }, context("rev", "reviewer"));
  const composition = (reportVersionId: string) => withTenantRead(database.pool, ORG, (db) => getReportComposition(db, reportVersionId)) as Promise<ReportComposition>;
  const profileVersion = async () => Number((await q(`SELECT coalesce(max(version), 0) AS v FROM nzi_console.client_report_profiles WHERE client_id = $1`, [CLIENT]))[0]!.v);

  let snapshots = 0;
  const snapshot = async (): Promise<string> => {
    snapshots += 1;
    const snapshotId = `plan-snap-${snapshots}`;
    const payload = { jobNumber: "J009901", client: "Plan Co", reportingYear: 2025,
      measurements: [
        { rowId: `r-${snapshots}`, scope: "1", scopeCode: "1", siteId: null, siteLabel: null, sourceLabel: "Gas", tco2e: 10, qualityTier: "measured", factorSet: "demo" },
        // The manifest's purchased-goods chart needs a categorised Scope 3 row.
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
    database = (await createDisposableDatabase("reportsectionplan"))!;
    await q(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $1)`, [ORG]);
    await q(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name) VALUES ($1, 'ada', 'admin', 'active', 'Ada'), ($1, 'rev', 'reviewer', 'active', 'Rev'), ($1, 'prep', 'admin', 'active', 'Prep')`, [ORG]);
    await q(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status, currency) VALUES ($1, $2, 'Plan Co', 'active', 'GBP')`, [ORG, CLIENT]);
    await q(`INSERT INTO nzi_console.jobs (organisation_id, job_id, client_id, sequence, job_family, title, status, workflow_stage, reporting_year) VALUES ($1, $2, $3, 9901, 'crp', 'CRP', 'open', 'delivery', 2025)`, [ORG, JOB, CLIENT]);
    await q(`INSERT INTO nzi_console.job_emissions_config (organisation_id, job_id, reporting_from, reporting_to, country_code) VALUES ($1, $2, '2025-01-01', '2025-12-31', 'GB')`, [ORG, JOB]);
  });
  after(async () => { await database?.end(); });

  it("with no profile a version carries the default plan; one validated before F-1 (no plan) publishes the default", async () => {
    const snap = await snapshot();
    const validated = await validate(snap);
    assert.equal(validated.data.sectionPlanOrigin, "default");
    const row = await versionRow(validated.data.reportVersionId);
    assert.deepEqual([keys(row.section_plan!), row.section_plan_origin, row.client_issuer_line], [keys(defaultReportSectionPlan), "default", null]);
    // A version validated before 0164 has no plan: it is issued with the default.
    await q(`UPDATE nzi_console.report_versions SET section_plan = NULL, section_plan_origin = NULL WHERE report_version_id = $1`, [validated.data.reportVersionId]);
    await publish(validated.data.reportVersionId, snap, 1);
    const issued = await composition(validated.data.reportVersionId);
    assert.deepEqual(issued.sectionPlan, defaultReportSectionPlan);
    assert.equal(issued.issuerLine, undefined);
  });

  it("the client's profile seeds the plan and issuer line at validate; a later profile edit never reaches that version; publish freezes both", async () => {
    await setClientReportProfile(database.pool, { clientId: CLIENT, expectedVersion: 0, sectionPlan: reordered(), issuerLine: "Prepared for the Board of Plan Co" }, context("ada", "admin"));
    const snap = await snapshot();
    const validated = await validate(snap);
    assert.equal(validated.data.sectionPlanOrigin, "profile:1");
    // The profile moves on; the validated version does not.
    await setClientReportProfile(database.pool, { clientId: CLIENT, expectedVersion: 1, sectionPlan: planFirst(), issuerLine: null }, context("ada", "admin"));
    const row = await versionRow(validated.data.reportVersionId);
    assert.deepEqual([keys(row.section_plan!), row.section_plan_origin, row.client_issuer_line], [keys(reordered()), "profile:1", "Prepared for the Board of Plan Co"]);
    await publish(validated.data.reportVersionId, snap, 1);
    const issued = await composition(validated.data.reportVersionId);
    assert.deepEqual(issued.sectionPlan, reordered(), "the order is part of what was issued");
    assert.equal(issued.issuerLine, "Prepared for the Board of Plan Co");
    const order = reportSectionLayout(issued.sectionPlan!, (key) => !key.startsWith("narrative:") && key !== "sites").map((entry) => `${entry.number ?? "-"} ${entry.key}`);
    assert.deepEqual(order, ["- cover", "01 executive-summary", "02 emissions", "03 targets", "04 intensity", "05 plan", "06 srs", "07 methodology"]);
  });

  it("a plan asked for at validate is the version's own (edited); one equal to the active profile reads as the profile's", async () => {
    const own = await validate(await snapshot(), reordered());
    assert.equal(own.data.sectionPlanOrigin, "edited", "the active profile (v2) is plan-first, so this is a one-off");
    const asProfile = await validate(await snapshot(), planFirst());
    assert.equal(asProfile.data.sectionPlanOrigin, "profile:2");
  });

  it("report.sectionPlan.update: validated only, version-checked and bumped, held to separation of duties, audited before and after", async () => {
    const snap = await snapshot();
    const validated = await validate(snap);
    assert.equal(validated.data.sectionPlanOrigin, "profile:2");
    // The snapshot's preparer may not shape the report they would then release.
    await assert.rejects(updateReportSectionPlan(database.pool, { reportVersionId: validated.data.reportVersionId, expectedVersion: 1, sectionPlan: reordered() }, context("prep", "admin")),
      /someone else must validate and publish it/);
    const updated = await updateReportSectionPlan(database.pool, { reportVersionId: validated.data.reportVersionId, expectedVersion: 1, sectionPlan: reordered() }, context("rev", "reviewer"));
    assert.deepEqual([updated.data.version, updated.data.origin], [2, "edited"]);
    const row = await versionRow(validated.data.reportVersionId);
    assert.deepEqual([row.version, keys(row.section_plan!), row.section_plan_origin], [2, keys(reordered()), "edited"]);
    // A screen that saw version 1 is told the report moved.
    await assert.rejects(updateReportSectionPlan(database.pool, { reportVersionId: validated.data.reportVersionId, expectedVersion: 1, sectionPlan: planFirst() }, context("rev", "reviewer")), /version/i);
    const audit = (await q(`SELECT before_json, after_json FROM nzi_console.audit_events WHERE action = 'report_section_plan_updated' AND entity_id = $1`, [validated.data.reportVersionId]))[0] as
      { before_json: { origin: string; order: string[] }; after_json: { origin: string; order: string[] } };
    assert.deepEqual([audit.before_json.origin, audit.after_json.origin], ["profile:2", "edited"]);
    assert.deepEqual(audit.after_json.order, reordered().filter((entry) => entry.included).map((entry) => entry.key));
    // Publish pins the bumped version, and freezes the edited plan.
    await assert.rejects(publish(validated.data.reportVersionId, snap, 1), /version/i);
    await publish(validated.data.reportVersionId, snap, 2);
    assert.deepEqual((await composition(validated.data.reportVersionId)).sectionPlan, reordered());
    // Once published, the order is fixed as it was issued.
    const current = (await versionRow(validated.data.reportVersionId)).version;
    await assert.rejects(updateReportSectionPlan(database.pool, { reportVersionId: validated.data.reportVersionId, expectedVersion: current, sectionPlan: planFirst() }, context("rev", "reviewer")),
      (error) => codesOf(error).includes("PRECONDITION"));
  });

  it("the profile is append-only: a stale version is a conflict, withdrawal needs a reason and carries no plan, and a withdrawn profile seeds nothing", async () => {
    const latest = await profileVersion();
    await assert.rejects(setClientReportProfile(database.pool, { clientId: CLIENT, expectedVersion: latest - 1, sectionPlan: reordered(), issuerLine: null }, context("ada", "admin")), /version/i);
    await assert.rejects(deactivateClientReportProfile(database.pool, { clientId: CLIENT, expectedVersion: latest }, context("ada", "admin")), (error) => codesOf(error).includes("REQUIRED"));
    await deactivateClientReportProfile(database.pool, { clientId: CLIENT, expectedVersion: latest }, context("ada", "admin", "House style retired"));
    const withdrawn = (await q(`SELECT active, section_plan, issuer_line, reason FROM nzi_console.client_report_profiles WHERE client_id = $1 ORDER BY version DESC LIMIT 1`, [CLIENT]))[0];
    assert.deepEqual(withdrawn, { active: false, section_plan: null, issuer_line: null, reason: "House style retired" });
    assert.equal((await validate(await snapshot())).data.sectionPlanOrigin, "default");
    const grants = (await q(`SELECT has_table_privilege('nzi_console_app', 'nzi_console.client_report_profiles', 'UPDATE') AS u, has_table_privilege('nzi_console_app', 'nzi_console.client_report_profiles', 'DELETE') AS d`))[0];
    assert.deepEqual(grants, { u: false, d: false });
  });

  it("a stored profile that no longer fits the rules is refused at validate, never issued", async () => {
    // As if written under looser rules (or before a rule changed): a profile that leaves a mandatory section out.
    const version = (await profileVersion()) + 1;
    await q(`INSERT INTO nzi_console.client_report_profiles (organisation_id, client_id, version, active, section_plan, set_by, correlation_id) VALUES ($1, $2, $3, true, $4::jsonb, 'seed', 'seed')`,
      [ORG, CLIENT, version, JSON.stringify(withExcluded("emissions"))]);
    await assert.rejects(validate(await snapshot()), (error) => {
      const issues = (error as { issues?: Array<{ code: string; field: string; message: string }> }).issues ?? [];
      return issues.some((issue) => issue.code === "MANDATORY_SECTION" && issue.field === "reportProfile" && /report profile no longer fits/.test(issue.message));
    });
    // A plan chosen for this report still validates past it.
    assert.equal((await validate(await snapshot(), reordered())).data.sectionPlanOrigin, "edited");
  });

  it("an issuer line is words for the cover, never money (NZC-120)", async () => {
    for (const line of ["Prepared for a £2m programme", "Budget GBP 40000", "Fee 1500 EUR"]) {
      await assert.rejects(setClientReportProfile(database.pool, { clientId: CLIENT, expectedVersion: await profileVersion(), sectionPlan: reordered(), issuerLine: line }, context("ada", "admin")),
        (error) => codesOf(error).includes("MONEY_SHAPED"), line);
    }
  });

  // Last, because the profile is append-only: it leaves the client's profile at a new version the tests above do not expect.
  it("with F-4b, an optional section may be left out at validate, at the profile and at update, and is frozen out; narrative and a mandatory section never", async () => {
    const atValidate = await validate(await snapshot(), withExcluded("targets"));
    assert.equal(atValidate.data.sectionPlanOrigin, "edited");
    const narrative = defaultReportSectionPlan.map((entry) => entry.key === "narrative:background" ? { ...entry, included: true } : entry);
    await assert.rejects(validate(await snapshot(), narrative), (error) => codesOf(error).includes("NARRATIVE_NOT_YET_DRAWN"));
    await assert.rejects(validate(await snapshot(), withExcluded("emissions")), (error) => codesOf(error).includes("MANDATORY_SECTION"));
    await setClientReportProfile(database.pool, { clientId: CLIENT, expectedVersion: await profileVersion(), sectionPlan: withExcluded("srs"), issuerLine: null }, context("ada", "admin"));
    const snap = await snapshot();
    const validated = await validate(snap);
    assert.equal(validated.data.sectionPlanOrigin, `profile:${await profileVersion()}`, "the profile's left-out SRS seeds the version");
    assert.equal((await versionRow(validated.data.reportVersionId)).section_plan!.find((entry) => entry.key === "srs")!.included, false);
    const updated = await updateReportSectionPlan(database.pool, { reportVersionId: validated.data.reportVersionId, expectedVersion: 1, sectionPlan: withExcluded("plan") }, context("rev", "reviewer"));
    assert.equal(updated.data.origin, "edited");
    await publish(validated.data.reportVersionId, snap, updated.data.version);
    const frozen = (await composition(validated.data.reportVersionId)).sectionPlan!;
    assert.equal(frozen.find((entry) => entry.key === "plan")!.included, false, "the published report froze the plan section out");
    assert.equal(frozen.find((entry) => entry.key === "srs")!.included, true, "the update replaced the profile's plan; it did not merge with it");
  });
});
