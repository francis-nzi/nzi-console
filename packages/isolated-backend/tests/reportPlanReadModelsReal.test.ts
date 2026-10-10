import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { commandGrantForRole, defaultReportSectionPlan, moveReportSection, type CommandContext, type StaffRole } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { validateCrpReport } from "../src/postgresCommands";
import { deactivateClientReportProfile, getReportVersionSectionPlan, setClientReportProfile, updateReportSectionPlan } from "../src/reportSectionPlans";
import { getClientWorkspace, listReportVersionRegister } from "../src/readModels";
import { seedPortalAcceptance } from "../src/portalAcceptanceSeed";
import { withTenantRead, type Queryable } from "../src/postgres";

/**
 * Reporting F-1b, against a real database: the read models the editors stand on.
 * - The client workspace carries the report profile (current when active; the latest version, which the next save expects).
 * - A report version's section plan reads back with the version publish will pin, and the default for a pre-0164 version.
 * - The register carries each version's `version`, so the job page's publish pins what it holds.
 * - §13: `getClientWorkspace` was modified, so it conforms and is guarded — §13's overlap-refusing fake around the real tenant
 *   client, over a workspace whose every part reads (sites, snapshots, contacts, SRS, strategies, the template, the profile).
 */
const ORG = "rmodel-org";
const CLIENT = "rmodel-client";
const JOB = "rmodel-job";

/**
 * §13's strict fake around the real client. It records the **first** overlap: a workspace adjunct fails soft, so an overlap
 * inside one is swallowed there and only shows later as a symptom — the first is the site to fix.
 */
function serialOnly(inner: Queryable): Queryable & { peakInFlight: number; queries: number; firstOverlap: string | null } {
  let inFlight = 0;
  let running = "";
  const guarded = {
    peakInFlight: 0, queries: 0, firstOverlap: null as string | null,
    async query<T extends Record<string, unknown>>(text: string, values?: readonly unknown[]) {
      inFlight += 1; guarded.queries += 1; guarded.peakInFlight = Math.max(guarded.peakInFlight, inFlight);
      const short = text.replace(/\s+/g, " ").slice(0, 90);
      if (inFlight > 1) {
        inFlight -= 1;
        guarded.firstOverlap ??= `${short}  — while running —  ${running}`;
        throw new Error(`two queries in flight on one tenant client (§13): ${short}`);
      }
      running = short;
      try { return await inner.query<T>(text, values); } finally { inFlight -= 1; }
    },
  };
  return guarded as Queryable & { peakInFlight: number; queries: number; firstOverlap: string | null };
}

describe("the read models behind the section-plan editors (F-1b), against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let count = 0;
  const context = (actor: string, role: StaffRole, reason?: string): CommandContext => {
    count += 1;
    return { organisationId: ORG, actorId: actor, principal: "staff", idempotencyKey: `rm-${count}`, correlationId: `corr-rm-${count}`, grant: commandGrantForRole(role, ORG, actor), ...(reason ? { reason } : {}) };
  };
  const q = async (sql: string, params: unknown[] = []) => { const db = await database.admin(); try { return (await db.query(sql, params)).rows; } finally { await db.end(); } };
  const read = <T>(work: (db: Queryable) => Promise<T>) => withTenantRead(database.pool, ORG, work);
  let reportVersionId = "";

  before(async () => {
    database = (await createDisposableDatabase("reportplanreadmodels"))!;
    await q(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $1)`, [ORG]);
    await q(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    await q(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name) VALUES ($1, 'ada', 'admin', 'active', 'Ada'), ($1, 'rev', 'reviewer', 'active', 'Rev')`, [ORG]);
    await q(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status, currency, baseline_period_start, baseline_total_tco2e) VALUES ($1, $2, 'Model Co', 'active', 'GBP', '2024-01-01', 40)`, [ORG, CLIENT]);
    await q(`INSERT INTO nzi_console.client_sites (organisation_id, client_id, site_id, name, in_service_from, created_by) VALUES ($1, $2, 'm-a', 'Works', '2020-01-01', 'seed')`, [ORG, CLIENT]);
    await q(`INSERT INTO nzi_console.client_site_floor_areas (organisation_id, floor_area_id, site_id, effective_from, floor_area_m2, recorded_by) VALUES ($1, 'mfa', 'm-a', NULL, 800, 'seed')`, [ORG]);
    await seedPortalAcceptance(database.pool, { organisationId: ORG, actorId: "ada", clientId: CLIENT });
    await q(`INSERT INTO nzi_console.jobs (organisation_id, job_id, client_id, sequence, job_family, title, status, workflow_stage, reporting_year) VALUES ($1, $2, $3, 9951, 'crp', 'CRP', 'open', 'delivery', 2025)`, [ORG, JOB, CLIENT]);
    await q(`INSERT INTO nzi_console.job_emissions_config (organisation_id, job_id, reporting_from, reporting_to, country_code) VALUES ($1, $2, '2025-01-01', '2025-12-31', 'GB')`, [ORG, JOB]);
    const payload = { jobNumber: "J009951", client: "Model Co", reportingYear: 2025,
      measurements: [
        { rowId: "a", scope: "1", scopeCode: "1", siteId: "m-a", siteLabel: "Works", sourceLabel: "Gas", tco2e: 10, qualityTier: "measured", factorSet: "demo" },
        { rowId: "b", scope: "3", scopeCode: "3.1", siteId: null, siteLabel: null, sourceLabel: "Goods", tco2e: 20, qualityTier: "estimated", factorSet: "demo", purchasedGoodsCategoryId: "pg", purchasedGoodsCategoryLabel: "Materials" }],
      target: { baselineYear: 2024, baselineTco2e: 40, interimYear: 2030, interimReductionPercent: 50, netZeroYear: 2045 },
      intensityTarget: { source: "client-target", metric: "turnover", metricLabel: "Turnover", denominatorUnit: "£m", reportingDenominator: 12.5, baselineYear: 2024, baselineIntensity: 3,
        interimYear: 2030, interimReductionPercent: 50, targetYear: 2045, targetReductionPercent: 100, netZeroYear: null, jobId: JOB, version: 1, updatedAt: "2026-01-01T00:00:00.000Z", updatedBy: "ada" },
      annualComparison: [{ year: 2024, values: [{ scope: "1", value: 12 }] }, { year: 2025, values: [{ scope: "1", value: 10 }] }] };
    await q(`INSERT INTO nzi_console.reviewed_crp_snapshots (organisation_id, snapshot_id, job_id, snapshot_version, job_version, data_hash, payload_json, created_by, approved_by, approved_at)
             VALUES ($1, 'rm-snap', $2, 1, 1, $3, $4::jsonb, 'prep', 'rev', now())`, [ORG, JOB, `sha256:${createHash("sha256").update("rm-snap").digest("hex")}`, JSON.stringify(payload)]);
    reportVersionId = (await validateCrpReport(database.pool, { reviewedSnapshotId: "rm-snap", manifestVersion: 1 }, context("rev", "reviewer"))).data.reportVersionId;
  });
  after(async () => { await database?.end(); });

  it("the client workspace carries the report profile: none, then current, then — withdrawn — none with the latest version", async () => {
    assert.deepEqual((await read((db) => getClientWorkspace(db, CLIENT)))!.reportProfile, { current: null, latestVersion: 0 });
    const plan = moveReportSection(defaultReportSectionPlan, "plan", "earlier");
    await setClientReportProfile(database.pool, { clientId: CLIENT, expectedVersion: 0, sectionPlan: plan, issuerLine: "Prepared for the Board of Model Co" }, context("ada", "admin"));
    const set = (await read((db) => getClientWorkspace(db, CLIENT)))!.reportProfile;
    assert.deepEqual([set.latestVersion, set.current?.version, set.current?.sectionPlan, set.current?.issuerLine], [1, 1, plan, "Prepared for the Board of Model Co"]);
    await deactivateClientReportProfile(database.pool, { clientId: CLIENT, expectedVersion: 1 }, context("ada", "admin", "Retired"));
    assert.deepEqual((await read((db) => getClientWorkspace(db, CLIENT)))!.reportProfile, { current: null, latestVersion: 2 }, "the next save expects version 2");
  });

  it("getClientWorkspace puts one query at a time on the tenant client (§13), reading every part", async () => {
    let guard: ReturnType<typeof serialOnly> | null = null;
    const workspace = await read((db) => getClientWorkspace(guard = serialOnly(db), CLIENT)).catch((error: unknown) => { throw new Error(`${String(error)} | first overlap: ${guard?.firstOverlap}`); });
    assert.equal(guard!.firstOverlap, null, "no overlap anywhere in the workspace read");
    assert.equal(guard!.peakInFlight, 1, "the whole workspace read is serial on a transaction client");
    assert.deepEqual(workspace!.degraded, [], "no part failed — every read went through the guard");
    assert.ok(workspace!.strategies.plan.length > 0 && workspace!.srs.framework !== null && workspace!.sites.length === 1, "the parts were really read");
    assert.ok(guard!.queries > 20, `${guard!.queries} queries`);
  });

  it("a version's section plan reads back with the version publish pins; a reorder moves both; a pre-0164 version reads the default", async () => {
    const before = (await read((db) => getReportVersionSectionPlan(db, reportVersionId)))!;
    // Validated (in `before`) while the client had no profile: the default, at version 1.
    assert.deepEqual([before.status, before.version, before.origin, before.sectionPlan], ["validated", 1, "default", defaultReportSectionPlan]);
    const reordered = moveReportSection(defaultReportSectionPlan, "targets", "earlier");
    await updateReportSectionPlan(database.pool, { reportVersionId, expectedVersion: 1, sectionPlan: reordered }, context("rev", "reviewer"));
    const after = (await read((db) => getReportVersionSectionPlan(db, reportVersionId)))!;
    assert.deepEqual([after.version, after.origin, after.sectionPlan], [2, "edited", reordered]);
    await q(`UPDATE nzi_console.report_versions SET section_plan = NULL, section_plan_origin = NULL WHERE report_version_id = $1`, [reportVersionId]);
    const legacy = (await read((db) => getReportVersionSectionPlan(db, reportVersionId)))!;
    assert.deepEqual([legacy.origin, legacy.sectionPlan], ["default", defaultReportSectionPlan]);
    assert.equal(await read((db) => getReportVersionSectionPlan(db, "no-such-version")), null);
  });

  it("the register carries each version's version, so the job page publishes the one it holds", async () => {
    const register = await read((db) => listReportVersionRegister(db));
    assert.deepEqual(register.filter((item) => item.reportVersionId === reportVersionId).map((item) => item.version), [2]);
  });
});
