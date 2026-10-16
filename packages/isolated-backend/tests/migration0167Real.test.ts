import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { commandGrantForRole, defaultReportSectionPlan, setReportSectionIncluded, type CommandContext, type ReportSectionPlan, type StaffRole } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { publishCrpReport, validateCrpReport } from "../src/postgresCommands";

/**
 * Migration 0167 (ACCEPT-composed5-checkpoint3, the migration ruling; approved at checkpoint 4): Net Zero Commitment and
 * Background were forced off in every stored plan (the validator allowed nothing else), so they are turned ON, once, in the
 * plans that still feed new reports — an active profile gets a NEW version (append-only), a validated version is turned on
 * in place with its version bumped — and NEVER in a published version, a withdrawn profile, or a frozen composition. Run
 * again, it changes nothing.
 */
const ORG = "m167-org";
const STANDALONE = ["narrative:net-zero-commitment", "narrative:background"];
const migration = readFileSync(new URL("../migrations/0167_report_plan_standalone_narrative_on.sql", import.meta.url), "utf8");

describe("migration 0167: the standalone narrative sections on, once, in the plans that feed new reports", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let count = 0;
  const context = (actor: string, role: StaffRole): CommandContext => {
    count += 1;
    return { organisationId: ORG, actorId: actor, principal: "staff", idempotencyKey: `m167-${count}`, correlationId: `corr-m167-${count}`, grant: commandGrantForRole(role, ORG, actor) };
  };
  const q = async (sql: string, params: unknown[] = []) => { const db = await database.admin(); try { return (await db.query(sql, params)).rows; } finally { await db.end(); } };
  const runMigration = async () => { const db = await database.admin(); try { await db.query(migration); } finally { await db.end(); } };
  /** The default plan with both standalone sections off — what every plan stored before composed@5 holds. */
  const forcedOff = (): ReportSectionPlan => STANDALONE.reduce<ReportSectionPlan>((plan, key) => plan.map((entry) => entry.key === key ? { ...entry, included: false } : entry), defaultReportSectionPlan);
  const on = (plan: ReportSectionPlan) => STANDALONE.map((key) => plan.find((entry) => entry.key === key)!.included);
  const snapshotFor = async (clientId: string, jobId: string, sequence: number) => {
    await q(`INSERT INTO nzi_console.jobs (organisation_id, job_id, client_id, sequence, job_family, title, status, workflow_stage, reporting_year) VALUES ($1, $2, $3, $4, 'crp', 'CRP', 'open', 'delivery', 2025)`, [ORG, jobId, clientId, sequence]);
    const payload = { jobNumber: `J-${jobId}`, client: clientId, reportingYear: 2025, annualComparison: [],
      measurements: [{ rowId: `${jobId}-r`, rowVersion: 1, scope: "1", scopeCode: "1", siteId: null, siteLabel: null, sourceLabel: "Gas", tco2e: 10, factorSet: "Gas · demo", qualityTier: "measured", factorSource: "dataset" }] };
    await q(`INSERT INTO nzi_console.reviewed_crp_snapshots (organisation_id, snapshot_id, job_id, snapshot_version, job_version, data_hash, payload_json, created_by, approved_by, approved_at)
             VALUES ($1, $2, $3, 1, 1, $4, $5::jsonb, 'prep', 'rev', now())`, [ORG, `snap-${jobId}`, jobId, `sha256:${createHash("sha256").update(jobId).digest("hex")}`, JSON.stringify(payload)]);
    return `snap-${jobId}`;
  };
  // A version holding the forced-off plan (as every version validated before composed@5 does); Targets and Intensity left out
  // (this snapshot has neither, and validate's R4 would refuse their charts).
  const forcedOffVersion = async (snapshotId: string) => {
    const plan = setReportSectionIncluded(setReportSectionIncluded(forcedOff(), "targets", false), "intensity", false);
    return (await validateCrpReport(database.pool, { reviewedSnapshotId: snapshotId, manifestVersion: 1, sectionPlan: plan }, context("rev", "reviewer"))).data.reportVersionId;
  };
  const profiles = (clientId: string) => q(`SELECT version, active, section_plan, issuer_line, set_by FROM nzi_console.client_report_profiles WHERE organisation_id = $1 AND client_id = $2 ORDER BY version`, [ORG, clientId]);
  const version = async (id: string) => (await q(`SELECT status, version, section_plan FROM nzi_console.report_versions WHERE organisation_id = $1 AND report_version_id = $2`, [ORG, id]))[0] as { status: string; version: number; section_plan: ReportSectionPlan };
  let validatedId = "", publishedId = "", publishedComposition = "", publishedRow = "", validatedBefore = 0;

  before(async () => {
    database = (await createDisposableDatabase("migration0167"))!;
    await q(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $1)`, [ORG]);
    await q(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name) VALUES ($1, 'rev', 'reviewer', 'active', 'Rev')`, [ORG]);
    for (const client of ["c-active", "c-withdrawn", "c-on", "c-versions"]) {
      await q(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status) VALUES ($1, $2, $2, 'active')`, [ORG, client]);
    }
    const profile = (clientId: string, version: number, plan: ReportSectionPlan | null, extra: { active?: boolean; issuerLine?: string | null; reason?: string | null } = {}) =>
      q(`INSERT INTO nzi_console.client_report_profiles (organisation_id, client_id, version, active, section_plan, issuer_line, reason, set_by, correlation_id) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, 'seed', 'seed')`,
        [ORG, clientId, version, extra.active ?? true, plan === null ? null : JSON.stringify(plan), extra.issuerLine ?? null, extra.reason ?? null]);
    await profile("c-active", 1, forcedOff(), { issuerLine: "Prepared for the Board" });
    await profile("c-withdrawn", 1, forcedOff());
    await profile("c-withdrawn", 2, null, { active: false, reason: "withdrawn" });
    await profile("c-on", 1, defaultReportSectionPlan);
    validatedId = await forcedOffVersion(await snapshotFor("c-versions", "j-validated", 9671));
    publishedId = await forcedOffVersion(await snapshotFor("c-versions", "j-published", 9672));
    await publishCrpReport(database.pool, { reportVersionId: publishedId, expectedStatus: "validated", expectedVersion: 1, manifestVersion: 1, reviewedSnapshotId: "snap-j-published" }, context("rev", "reviewer"));
    publishedComposition = JSON.stringify(await q(`SELECT * FROM nzi_console.report_compositions WHERE organisation_id = $1`, [ORG]));
    publishedRow = JSON.stringify(await q(`SELECT * FROM nzi_console.report_versions WHERE organisation_id = $1 AND report_version_id = $2`, [ORG, publishedId]));
    validatedBefore = (await version(validatedId)).version;
    await runMigration();
  });
  after(async () => { await database?.end(); });

  it("an active profile with the sections forced off gets a NEW version with both on — the old one untouched, the issuer line carried", async () => {
    const rows = await profiles("c-active") as Array<{ version: number; active: boolean; section_plan: ReportSectionPlan; issuer_line: string | null; set_by: string }>;
    assert.equal(rows.length, 2);
    assert.deepEqual(on(rows[0]!.section_plan), [false, false], "version 1 stays as written (append-only)");
    assert.deepEqual([rows[1]!.version, rows[1]!.active, rows[1]!.issuer_line, rows[1]!.set_by], [2, true, "Prepared for the Board", "migration:0167"]);
    assert.deepEqual(on(rows[1]!.section_plan), [true, true]);
    assert.deepEqual(rows[1]!.section_plan.map((entry) => entry.key), rows[0]!.section_plan.map((entry) => entry.key), "order unchanged");
    assert.deepEqual(rows[1]!.section_plan.filter((entry) => !STANDALONE.includes(entry.key)), rows[0]!.section_plan.filter((entry) => !STANDALONE.includes(entry.key)), "every other choice unchanged");
  });

  it("never a withdrawn profile, nor one already on", async () => {
    assert.equal((await profiles("c-withdrawn")).length, 2);
    assert.equal((await profiles("c-on")).length, 1);
  });

  it("a validated, unpublished version is turned on in place, its version bumped — a studio holding the old one is refused, not overwritten", async () => {
    const row = await version(validatedId);
    assert.deepEqual([row.status, row.version], ["validated", validatedBefore + 1]);
    assert.deepEqual(on(row.section_plan), [true, true]);
  });

  it("NEVER a published version, nor any frozen composition", async () => {
    const row = await version(publishedId);
    assert.equal(row.status, "published");
    assert.deepEqual(on(row.section_plan), [false, false]);
    assert.equal(JSON.stringify(await q(`SELECT * FROM nzi_console.report_versions WHERE organisation_id = $1 AND report_version_id = $2`, [ORG, publishedId])), publishedRow, "the whole row, byte for byte");
    assert.equal(JSON.stringify(await q(`SELECT * FROM nzi_console.report_compositions WHERE organisation_id = $1`, [ORG])), publishedComposition, "byte for byte");
  });

  it("is idempotent: run again, nothing changes", async () => {
    const snapshot = async () => JSON.stringify([await profiles("c-active"), await profiles("c-withdrawn"), await profiles("c-on"), await version(validatedId), await version(publishedId)]);
    const before = await snapshot();
    await runMigration();
    assert.equal(await snapshot(), before);
  });
});
