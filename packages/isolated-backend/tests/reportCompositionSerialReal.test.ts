import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { commandGrantForRole, isReportGap, type CommandContext, type ReportComposition } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { validateCrpReport } from "../src/postgresCommands";
import { composeForReportVersion } from "../src/reportCompositions";
import { seedPortalAcceptance } from "../src/portalAcceptanceSeed";
import { withTenantRead, type Queryable } from "../src/postgres";

/**
 * Composing a report puts one query at a time on the tenant client (DESIGN_CONVENTIONS §13).
 *
 * `composeForReportVersion` runs on the single client of a tenant transaction — under `withTenantRead`, and inside
 * `report.publish`. It used to gather its sections with `Promise.all` on that client. The transaction already serialises
 * what it is handed (`serialisedQueryable`, #385), so nothing overlapped on the wire; §13 forbids the fan-out regardless,
 * so a read model is correct without depending on that wrapper.
 *
 * The guard below is §13's strict fake (`srsFrameworkRead.test.ts`) put around the real client: it refuses a second query
 * while one is in flight instead of queueing it. It sits *outside* the transaction's serialiser, so a `Promise.all`
 * anywhere in the composition's call tree fails here. The fixture reaches every section — emissions by site, intensity,
 * targets, plan and SRS — so every read is driven through the guard, and the composition must equal the unguarded one.
 */
const ORG = "serial-org";
const CLIENT = "serial-client";
const ACTOR = "serial-admin";

function serialOnly(inner: Queryable): Queryable & { peakInFlight: number; queries: number } {
  let inFlight = 0;
  const guarded = {
    peakInFlight: 0,
    queries: 0,
    async query<T extends Record<string, unknown>>(text: string, values?: readonly unknown[]) {
      inFlight += 1;
      guarded.queries += 1;
      guarded.peakInFlight = Math.max(guarded.peakInFlight, inFlight);
      if (inFlight > 1) {
        inFlight -= 1;
        throw new Error(`two queries in flight on one tenant client (§13): ${text.replace(/\s+/g, " ").slice(0, 80)}`);
      }
      try {
        return await inner.query<T>(text, values);
      } finally {
        inFlight -= 1;
      }
    },
  };
  return guarded as Queryable & { peakInFlight: number; queries: number };
}

describe("composing a report stays on one query at a time (§13), against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let reportVersionId = "";
  const q = async (sql: string, params: unknown[] = []) => { const db = await database.admin(); try { return (await db.query(sql, params)).rows; } finally { await db.end(); } };
  const context = (): CommandContext => ({ organisationId: ORG, actorId: "rev", principal: "staff", idempotencyKey: "serial-validate", correlationId: "corr-serial", grant: commandGrantForRole("reviewer", ORG, "rev") });
  const compose = (wrap: (db: Queryable) => Queryable) =>
    withTenantRead(database.pool, ORG, (db) => composeForReportVersion(wrap(db), { organisationId: ORG, reportVersionId, issuedAt: "2026-02-01T00:00:00.000Z" }));

  before(async () => {
    database = (await createDisposableDatabase("reportcompositionserial"))!;
    await q(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $1)`, [ORG]);
    // The SRS framework and the strategy library the plan and roadmap sections read.
    await q(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    await q(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name) VALUES ($1, $2, 'admin', 'active', 'Ada'), ($1, 'rev', 'reviewer', 'active', 'Rev')`, [ORG, ACTOR]);
    await q(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status, currency, baseline_period_start, baseline_total_tco2e) VALUES ($1, $2, 'Serial Co', 'active', 'GBP', '2023-01-01', 40)`, [ORG, CLIENT]);
    await q(`INSERT INTO nzi_console.client_sites (organisation_id, client_id, site_id, name, in_service_from, created_by) VALUES ($1, $2, 's-a', 'Works', '2020-01-01', 'seed'), ($1, $2, 's-b', 'Annex', '2020-01-01', 'seed')`, [ORG, CLIENT]);
    await q(`INSERT INTO nzi_console.client_site_floor_areas (organisation_id, floor_area_id, site_id, effective_from, floor_area_m2, recorded_by) VALUES ($1, 'fa-a', 's-a', NULL, 1000, 'seed'), ($1, 'fa-b', 's-b', NULL, 500, 'seed')`, [ORG]);
    for (const [key, label, unit, divider, kind, source, ordering] of [["employees", "Employees", "employee", 1, "text", "entered", 1], ["floor-area", "Floor area", "m²", 1, "text", "site-floor-area", 2]] as const) {
      await q(`INSERT INTO nzi_console.client_intensity_metrics (organisation_id, client_id, metric_key, version, label, unit_wording, divider, icon_key, is_standard, value_source, active, ordering, unit_kind, set_by, correlation_id)
               VALUES ($1, $2, $3, 1, $4, $5, $6, 'metric', true, $7, true, $8, $9, 'seed', 'seed')`, [ORG, CLIENT, key, label, unit, divider, source, ordering, kind]);
    }
    await q(`INSERT INTO nzi_console.client_targets (organisation_id, client_id, version, near_term_year, near_term_pct, net_zero_year, net_zero_pct, benchmark_year, benchmark_total_tco2e, benchmark_source, set_by, correlation_id)
             VALUES ($1, $2, 1, 2030, 50, 2045, 90, 2023, 40, 'client-record', 'fixture', 'fixture')`, [ORG, CLIENT]);
    // Strategies (the plan) and a completed SRS assessment (the roadmap), through the staff commands.
    await seedPortalAcceptance(database.pool, { organisationId: ORG, actorId: ACTOR, clientId: CLIENT });

    for (const [jobId, sequence, year] of [["j-prev", 9801, 2024], ["j-cur", 9802, 2025]] as const) {
      await q(`INSERT INTO nzi_console.jobs (organisation_id, job_id, client_id, sequence, job_family, title, status, workflow_stage, reporting_year) VALUES ($1, $2, $3, $4, 'crp', 'CRP', 'open', 'delivery', $5)`, [ORG, jobId, CLIENT, sequence, year]);
      await q(`INSERT INTO nzi_console.job_emissions_config (organisation_id, job_id, reporting_from, reporting_to, country_code) VALUES ($1, $2, $3, $4, 'GB')`, [ORG, jobId, `${year}-01-01`, `${year}-12-31`]);
      const measurements = [
        { rowId: `${jobId}-1`, scope: "1", scopeCode: "1", siteId: "s-a", siteLabel: "Works", sourceLabel: "Gas", tco2e: 10, qualityTier: "measured", factorSet: "demo" },
        { rowId: `${jobId}-2`, scope: "2", scopeCode: "2", siteId: "s-b", siteLabel: "Annex", sourceLabel: "Electricity", tco2e: 5, qualityTier: "measured", factorSet: "demo" },
        { rowId: `${jobId}-3`, scope: "3", scopeCode: "3.1", siteId: null, siteLabel: null, sourceLabel: "Goods", tco2e: 20, qualityTier: "estimated", factorSet: "demo", purchasedGoodsCategoryId: "pg", purchasedGoodsCategoryLabel: "Materials" },
      ];
      const payload = { jobNumber: `J00${sequence}`, client: "Serial Co", reportingYear: year, measurements,
        target: { baselineYear: 2023, baselineTco2e: 40, interimYear: 2030, interimReductionPercent: 50, netZeroYear: 2045 },
        intensityTarget: { source: "client-target", metric: "employee", metricLabel: "Employees", denominatorUnit: "employee", reportingDenominator: 240, baselineYear: 2023,
          baselineIntensity: 0.2, interimYear: 2030, interimReductionPercent: 50, targetYear: 2045, targetReductionPercent: 100, netZeroYear: null, jobId, version: 1,
          updatedAt: "2026-01-01T00:00:00.000Z", updatedBy: "ada" },
        annualComparison: [{ year: year - 1, values: [{ scope: "1", value: 12 }] }, { year, values: [{ scope: "1", value: 10 }] }],
        provenance: { resolver: "crp.snapshot.issue@2", reportingPeriod: { from: `${year}-01-01`, to: `${year}-12-31` }, factorSets: [], boundary: { siteIds: ["s-a", "s-b"], excludedRowIds: [] } } };
      await q(`INSERT INTO nzi_console.reviewed_crp_snapshots (organisation_id, snapshot_id, job_id, snapshot_version, job_version, data_hash, payload_json, created_by, approved_by, approved_at)
               VALUES ($1, $2, $3, 1, 1, $4, $5::jsonb, 'ada', 'rev', now())`, [ORG, `snap-${jobId}`, jobId, `sha256:${createHash("sha256").update(jobId).digest("hex")}`, JSON.stringify(payload)]);
    }
    await q(`INSERT INTO nzi_console.job_intensity_values (organisation_id, job_id, reporting_year, metric_key, value, recorded_by) VALUES ($1, 'j-cur', 2025, 'employees', 240, 'ada')`, [ORG]);
    const validated = await validateCrpReport(database.pool, { reviewedSnapshotId: "snap-j-cur", manifestVersion: 1 }, context());
    reportVersionId = validated.data.reportVersionId;
  });
  after(async () => { await database?.end(); });

  it("the fixture reaches every section, so every read goes through the guard", async () => {
    const composition: ReportComposition = await compose((db) => db);
    for (const [name, section] of [["emissions", composition.emissions], ["intensity", composition.intensity], ["targets", composition.targets], ["plan", composition.plan], ["srs", composition.srs]] as const) {
      assert.ok(section && !isReportGap(section as never), `${name} is composed, not a gap: ${JSON.stringify(section).slice(0, 160)}`);
    }
  });

  it("never puts a second query on the tenant client while one is running, and composes exactly what it did unguarded", async () => {
    const unguarded = await compose((db) => db);
    let guard: ReturnType<typeof serialOnly> | null = null;
    const guarded = await compose((db) => (guard = serialOnly(db)));
    assert.equal(guard!.peakInFlight, 1, "the whole composition must be serial on a transaction client");
    assert.ok(guard!.queries > 15, `every section read through the guard (${guard!.queries} queries)`);
    assert.deepEqual(guarded, unguarded, "serial reads compose the same report");
  });
});
