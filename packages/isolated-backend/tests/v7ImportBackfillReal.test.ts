import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { commandGrantForRole, V7_REINGEST_ACTOR, type V7FiguresRowFigures, type V7ReingestJobInput, type V7ReingestPlanRow } from "@nzi/contracts";
import { withTenantRead, withTenantWrite } from "../src/postgres";
import type { PlannedRow } from "../src/v7ClientImport";
import { readConsoleScopeTotals, type V7FiguresClient, type V7FiguresRead, type V7RowFiguresClient, type V7RowFiguresRead } from "../src/v7Drift";
import { parseV7BackfillApproved, runV7Backfill, V7_BACKFILL_AUDIT_ACTION, V7_BACKFILL_CSV_HEADER, v7BackfillCsv, v7BackfillTotals,
  type V7BackfillJob, type V7BackfillOptions } from "../src/v7ImportBackfill";
import type { V7ImportRefreshSource } from "../src/v7ImportRefresh";
import { reingestV7JobInTransaction } from "../src/v7Reingest";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";

/**
 * DESIGN-backfill-reprice-and-reselect (R2, ruled 27 Nov: BF-1 … BF-6 as proposed). Each job stands as the October re-ingest left it:
 * a two-year job (April 2025 – March 2026) whose electricity months were stored positionally and priced on one edition, beside a UAE
 * client's calendar-year job on UK factors and an unmatched country. The backfill re-reads the months by calendar month, re-prices by
 * month, re-derives the datasets, corrects the country and re-points the UAE rows — a dry run by default, written only on approval.
 */
const ORG = "backfill";
const CROSSWALK_SHA = "d4c14407379377d20aeccebd9256eaf7ef7124846b07e05b3a0bf4afd233c8f2";
// V7's month_N is calendar month N: month_N = N × 1,000 kWh, 78,000 kWh in all.
const MONTHS = Array.from({ length: 12 }, (_, at) => (at + 1) * 1000);
const ELEC_QTY = 78_000;
// October's positional reading priced on 2025 alone; the calendar reading by month — Apr–Dec 2025 (72,000 kWh @ 0.177), Jan–Mar 2026
// (6,000 kWh @ 0.13096) — is V7's own figure.
const STORED = (ELEC_QTY * 0.177) / 1000;
const V7_ELEC = (72_000 * 0.177 + 6_000 * 0.13096) / 1000;
const close = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;

type Spanning = { k: number; jobId: string; number: string; v7JobId: string; elec: string; gas: string };
const spanning = (k: number): Spanning => ({ k, jobId: `bf-${k}`, number: `J${String(9900 + k).padStart(6, "0")}`, v7JobId: String(k), elec: `${k}01`, gas: `${k}02` });
// Reconciles once re-priced; issued (a snapshot); V7 prices its electricity differently; V7 changed its months since import.
const SPAN = spanning(91), ISSUED = spanning(92), OFF = spanning(93), CHANGED = spanning(94);
const UAE = { jobId: "bf-95", number: "J009995", v7JobId: "95", spend: "9501", spendOff: "9502", gas: "9503", gbOnly: "9504" };
const UNMATCHED = { jobId: "bf-96", number: "J009996", v7JobId: "96" };
const TWO_YEAR = [SPAN, ISSUED, OFF, CHANGED];

const migrated = (id: string, over: { scope: string; qty: number; uom: string; factor: number; original: string; months?: number[] }) => ({
  id, ...over, record: { qty: over.qty, uom: over.uom, factor: over.factor, ghg_unit: "kgCO2e", original_id: over.original, reported_tco2e: (over.qty * over.factor) / 1000,
    data_source: "Company Data", enabled: true, ...(over.months ? { months: over.months } : {}) } });

/** The live view set: each V7 row as V7 holds it now — CHANGED's January moved since it was imported. */
const liveRows = new Map<string, Array<{ legacyDbId: string; migratedRecord: Record<string, unknown> }>>();
const source: V7ImportRefreshSource = async (_db, { jobId }) => ({ sourceSha256: "e".repeat(64), rows: (liveRows.get(jobId) ?? []) as unknown as PlannedRow[] });

const ownFigures = (entry: Spanning, elec = V7_ELEC): V7FiguresRowFigures => ({ contract: "v7-import-figures/1", job_id: entry.k, computed_at: "2026-11-27T10:00:00Z", rows: [
  { row_id: Number(entry.elec), scope: "Scope 2", enabled: true, tco2e: elec, blended: true, custom_factor: false, spans: [
    { from: "2025-04", to: "2025-12", dataset_id: 1, dataset_year: 2025, factor: 0.177, ghg_unit: "kgCO2e", tco2e: (72_000 * 0.177) / 1000 },
    { from: "2026-01", to: "2026-03", dataset_id: 2, dataset_year: 2026, factor: 0.13096, ghg_unit: "kgCO2e", tco2e: elec - (72_000 * 0.177) / 1000 }] },
  { row_id: Number(entry.gas), scope: "Scope 1", enabled: true, tco2e: 0.2, blended: false, custom_factor: false, spans: [
    { from: "2025-04", to: "2026-03", dataset_id: 1, dataset_year: 2025, factor: 0.2, ghg_unit: "kgCO2e", tco2e: 0.2 }] }] });

describe("the reviewed backfill (R2): months re-read by calendar month, re-priced, datasets re-selected, countries corrected — on approval only", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;
  const calls: string[] = [];
  const figuresBody: Record<string, V7RowFiguresRead> = {
    [SPAN.v7JobId]: { ok: true, body: ownFigures(SPAN) }, [ISSUED.v7JobId]: { ok: true, body: ownFigures(ISSUED) },
    [OFF.v7JobId]: { ok: true, body: ownFigures(OFF, 20) }, [CHANGED.v7JobId]: { ok: true, body: ownFigures(CHANGED) } };
  const rowFigures: V7RowFiguresClient = async ({ v7JobId }) => { calls.push(v7JobId); return figuresBody[v7JobId] ?? { ok: false, reason: "not-found" }; };
  // Endpoint 1, for the drift check after a write: V7's totals as the console holds them once backfilled.
  const totals: Record<string, [number, number, number]> = { [SPAN.number]: [0.2, V7_ELEC, 0], [UAE.number]: [0.23, 0, 1.1], [UNMATCHED.number]: [0, 0, 0] };
  const figures: V7FiguresClient = async ({ legacyJobNumber }): Promise<V7FiguresRead> => {
    const t = totals[legacyJobNumber];
    return t ? { ok: true, body: { contract: "v7-import-figures/1", job_id: 1, job_number: legacyJobNumber, computed_at: "2026-11-27T10:00:00Z", period: { from: null, to: null },
      scope_totals: { scope_1: t[0], scope_2: t[1], scope_3: t[2], total: t[0] + t[1] + t[2] }, counted_rows: 2, rows_updated_at: null } } : { ok: false, reason: "not-found" };
  };
  const waits: number[] = [];
  const run = (over: Partial<V7BackfillOptions> = {}) => runV7Backfill(database.pool, { organisationId: ORG, actorId: "staff-admin", reason: "R2 backfill (test)", commit: false,
    source, rowFigures, figures, sleep: async (ms) => { waits.push(ms); }, ...over });
  const fingerprint = async () => {
    const tables = (await db.query<{ t: string }>(`SELECT tablename AS t FROM pg_tables WHERE schemaname = 'nzi_console' ORDER BY tablename`)).rows.map((row) => row.t);
    const prints: Record<string, string> = {};
    for (const table of tables) prints[table] = (await db.query<{ p: string }>(`SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS p FROM nzi_console.${table} t`)).rows[0]!.p;
    return prints;
  };
  /** Everything of one job's own: its rows, its config, its selections, its audit, its drift checks. */
  const jobPrint = async (jobId: string) => (await db.query<{ p: string }>(
    `SELECT md5(concat_ws('#',
       (SELECT string_agg(r::text, '|' ORDER BY r.scope_row_id) FROM nzi_console.job_scope_rows r WHERE r.organisation_id = $1 AND r.job_id = $2),
       (SELECT string_agg(c::text, '|') FROM nzi_console.job_emissions_config c WHERE c.organisation_id = $1 AND c.job_id = $2),
       (SELECT string_agg(s::text, '|' ORDER BY s.dataset_id) FROM nzi_console.job_dataset_selections s WHERE s.organisation_id = $1 AND s.job_id = $2),
       (SELECT string_agg(a::text, '|' ORDER BY a.occurred_at, a.audit_event_id) FROM nzi_console.audit_events a WHERE a.organisation_id = $1 AND a.entity_id = $2),
       (SELECT string_agg(d::text, '|' ORDER BY d.check_id) FROM nzi_console.v7_drift_checks d WHERE d.organisation_id = $1 AND d.job_id = $2))) AS p`, [ORG, jobId])).rows[0]!.p;
  const selections = async (jobId: string) => (await db.query<{ dataset_id: string; selection_source: string }>(
    `SELECT dataset_id, selection_source FROM nzi_console.job_dataset_selections WHERE organisation_id = $1 AND job_id = $2 ORDER BY dataset_id`, [ORG, jobId])).rows
    .map((row) => `${row.dataset_id}:${row.selection_source}`);
  const liveRow = async (v7: string) => (await db.query<{ scope_row_id: string; tco2e: number; review_status: string; monthly: Array<{ month: string; quantity: number | null }>;
    dataset_id: string | null; factor_id: string | null; factor_source: string; client_factor_id: string | null; lineage: Array<{ title: string }>; reingest: unknown }>(
    `SELECT scope_row_id, calculated_tco2e::float8 AS tco2e, review_status, monthly_activity_json AS monthly, dataset_id, factor_id, factor_source, client_factor_id,
            lineage_json AS lineage, provenance_json->'reingest' AS reingest
       FROM nzi_console.job_scope_rows WHERE organisation_id = $1 AND origin = 'live' AND enabled AND reingested_from_row_id = $2`, [ORG, v7])).rows[0]!;
  const of = (jobs: readonly V7BackfillJob[], entry: { jobId: string }) => jobs.find((job) => job.jobId === entry.jobId)!;
  const country = async (jobId: string) => (await db.query<{ c: string }>(`SELECT country_code AS c FROM nzi_console.job_emissions_config WHERE organisation_id = $1 AND job_id = $2`, [ORG, jobId])).rows[0]!.c;
  let dryRunCsv = "";

  const dataset = (id: string, country: string, from: string, to: string, status = "active") => db.query(
    `INSERT INTO nzi_console.emission_factor_datasets (organisation_id,dataset_id,name,version,valid_from,valid_to,country_code,status,source_name,licence)
     VALUES ($1,$2,$2,'1',$3,$4,$5,$6,'Test','Source: test.')`, [ORG, id, from, to, country, status]);
  const factor = (datasetId: string, id: string, label: string, unit: string, kg: number, scope: string) => db.query(
    `INSERT INTO nzi_console.emission_factors (organisation_id,dataset_id,factor_id,label,activity_unit,kgco2e_per_unit,scopes,source_levels) VALUES ($1,$2,$3,$4,$5,$6,ARRAY[$7::text],ARRAY[]::text[])`,
    [ORG, datasetId, id, label, unit, kg, scope]);
  const select = (jobId: string, datasetId: string, source: "automatic" | "manual", reason: string) => db.query(
    `INSERT INTO nzi_console.job_dataset_selections (organisation_id,job_id,dataset_id,selection_source,reason,selected_by) VALUES ($1,$2,$3,$4,$5,'seed')`, [ORG, jobId, datasetId, source, reason]);
  const job = async (entry: { jobId: string; number: string; v7JobId: string }, client: string, from: string, to: string, sequence: number) => {
    await db.query(`INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage,reporting_year,reporting_period_start,reporting_period_end,source_system,legacy_db_id,legacy_job_number)
      VALUES ($1,$2,$3,$4,'crp','CRP','open','Data entry',2025,$5,$6,'nzi-pro-v7',$7,$8)`, [ORG, entry.jobId, client, sequence, from, to, entry.v7JobId, entry.number]);
    await db.query(`INSERT INTO nzi_console.job_emissions_config (organisation_id,job_id,reporting_from,reporting_to,country_code) VALUES ($1,$2,$3,$4,'GB')`, [ORG, entry.jobId, from, to]);
    // Every job carried the old one-edition rule's picks: DESNZ 2025 and the automatic CEDA GB 2025.
    await select(entry.jobId, "uk-ghg-gb-2025", "automatic", "one edition per series (test)");
    await select(entry.jobId, "ceda-gb-2025", "automatic", "one edition per series (test)");
  };
  const insertMigrated = async (jobId: string, rows: ReturnType<typeof migrated>[]) => {
    for (const m of rows) await db.query(`INSERT INTO nzi_console.job_scope_rows (organisation_id,scope_row_id,job_id,scope,source_label,report_label,level_1,level_2,quantity,unit,
        calculated_tco2e,review_status,enabled,origin,migrated_record,source_system,legacy_db_id)
      VALUES ($1,$2,$3,$4,$5,$5,'v7','v7',$6,$7,$8,'pending',true,'migrated',$9::jsonb,'nzi-pro-v7',$2)`,
      [ORG, m.id, jobId, m.scope, `V7 ${m.id}`, m.qty, m.uom, (m.qty * m.factor) / 1000, JSON.stringify(m.record)]);
  };
  const reingest = async (jobId: string, rows: V7ReingestPlanRow[], vintages: string[]) => {
    const runId = `v7-reingest-${randomUUID()}`;
    const input: V7ReingestJobInput = { jobId, runId, crosswalkVersion: "v1", crosswalkSha256: CROSSWALK_SHA, vintageDatasetIds: vintages, rows };
    await withTenantWrite(database.pool, ORG, (client) => reingestV7JobInTransaction(client, input, { organisationId: ORG, actorId: V7_REINGEST_ACTOR, principal: "system",
      idempotencyKey: runId, correlationId: runId, reason: "v7 re-ingest (test)", grant: commandGrantForRole("admin", ORG, V7_REINGEST_ACTOR) }));
  };

  before(async () => {
    database = (await createDisposableDatabase("v7backfill"))!;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,$1)`, [ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
    for (const [id, registered] of [["c-gb", "United Kingdom"], ["c-ae", "United Arab Emirates"], ["c-ab", "Aberdeenshire"]])
      await db.query(`INSERT INTO nzi_console.clients (organisation_id,client_id,name,status,registered_country) VALUES ($1,$2,$2,'active',$3)`, [ORG, id, registered]);
    for (const [user, role] of [["staff-admin", "admin"], ["staff-consultant", "consultant"]])
      await db.query(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name) VALUES ($1, $2, $3, 'active', $2)`, [ORG, user, role]);
    // The library: DESNZ GB 2025 and 2026; CEDA 2025 (Watershed) superseded, Spain's with its Cornerstone successor; UAE A&S 2025.
    await dataset("uk-ghg-gb-2025", "GB", "2025-01-01", "2025-12-31");
    await dataset("uk-ghg-gb-2026", "GB", "2026-01-01", "2026-12-31");
    await dataset("ceda-gb-2025", "GB", "2025-01-01", "2025-12-31", "superseded");
    await dataset("ceda-es-2025", "ES", "2025-01-01", "2025-12-31", "superseded");
    await dataset("ceda-es-2025-edition-2026-rc", "ES", "2025-01-01", "2025-12-31");
    await dataset("uk-ghg-ae-2025", "AE", "2025-01-01", "2025-12-31");
    for (const [ds, kg] of [["uk-ghg-gb-2025", 0.177], ["uk-ghg-gb-2026", 0.13096]] as const) await factor(ds, "elec", "Electricity: UK", "kWh", kg, "2");
    for (const ds of ["uk-ghg-gb-2025", "uk-ghg-gb-2026", "uk-ghg-ae-2025"]) await factor(ds, "gas", "Natural gas", "kWh", 0.2, "1");
    await factor("uk-ghg-gb-2025", "gb-only", "A UK-only line", "kWh", 0.3, "1");
    await factor("uk-ghg-ae-2025", "uk-ghg-SWC-SPEND-77", "Spend line 77", "GBP", 0.5, "3");

    // The two-year jobs, as October left them: re-ingested on 2025 alone, electricity months stored positionally, both rows attested.
    for (const [at, entry] of TWO_YEAR.entries()) {
      await job(entry, "c-gb", "2025-04-01", "2026-03-31", 9900 + at);
      await select(entry.jobId, "ceda-es-2025", "manual", "Spain spend (test)");
      const rows = [migrated(entry.elec, { scope: "2", qty: ELEC_QTY, uom: "kWh", factor: 0.177, original: "elec", months: MONTHS }),
        migrated(entry.gas, { scope: "1", qty: 1000, uom: "kWh", factor: 0.2, original: "gas" })];
      await insertMigrated(entry.jobId, rows);
      await reingest(entry.jobId, [
        { v7RowId: entry.elec, disposition: "RE-INGEST", categoryCode: "2.purchased-electricity", scope: "2", sourceLabel: "Electricity", quantity: ELEC_QTY, unit: "kWh",
          datasetId: "uk-ghg-gb-2025", factorId: "elec", qualityTier: "measured", v7Tco2e: STORED, rule: "S2" },
        { v7RowId: entry.gas, disposition: "RE-INGEST", categoryCode: "1.natural-gas", scope: "1", sourceLabel: "Natural gas", quantity: 1000, unit: "kWh",
          datasetId: "uk-ghg-gb-2025", factorId: "gas", qualityTier: "measured", v7Tco2e: 0.2, rule: "S1-GAS" }], ["uk-ghg-gb-2025"]);
      // October's positional months: the period's i-th month held month_(i+1).
      const positional = ["2025-04", "2025-05", "2025-06", "2025-07", "2025-08", "2025-09", "2025-10", "2025-11", "2025-12", "2026-01", "2026-02", "2026-03"]
        .map((month, i) => ({ month, quantity: MONTHS[i]! }));
      await db.query(`UPDATE nzi_console.job_scope_rows SET monthly_activity_json = $3::jsonb, calculated_tco2e = $4 WHERE organisation_id = $1 AND reingested_from_row_id = $2`,
        [ORG, entry.elec, JSON.stringify(positional), STORED]);
      await db.query(`UPDATE nzi_console.job_scope_rows SET review_status = 'approved', reviewed_by = 'staff-reviewer', reviewed_at = now(), reviewed_row_version = version
                       WHERE organisation_id = $1 AND job_id = $2 AND origin = 'live'`, [ORG, entry.jobId]);
      liveRows.set(entry.jobId, rows.map((row) => ({ legacyDbId: row.id, migratedRecord: row.record })));
    }
    // CHANGED: V7 has moved its January since the import.
    liveRows.set(CHANGED.jobId, liveRows.get(CHANGED.jobId)!.map((row) => row.legacyDbId === CHANGED.elec
      ? { ...row, migratedRecord: { ...row.migratedRecord, months: [1500, ...MONTHS.slice(1)] } } : row));
    // ISSUED: a reviewed snapshot freezes its figures.
    await db.query(`INSERT INTO nzi_console.reviewed_crp_snapshots (organisation_id, snapshot_id, job_id, snapshot_version, job_version, data_hash, payload_json, created_by)
      VALUES ($1, 'snap-bf', $2, 1, 1, $3, '{}'::jsonb, 'staff-consultant')`, [ORG, ISSUED.jobId, `sha256:${"a".repeat(64)}`]);

    // UAE: a UAE client's calendar-2025 job on UK factors — two SWC-SPEND rows on carried factors (one at UAE A&S's value, one not),
    // gas on DESNZ GB with a UAE twin, and a line UAE A&S doesn't hold.
    await job(UAE, "c-ae", "2025-01-01", "2025-12-31", 9995);
    await insertMigrated(UAE.jobId, [
      migrated(UAE.spend, { scope: "3", qty: 1000, uom: "GBP", factor: 0.5, original: "SWC-SPEND-77" }),
      migrated(UAE.spendOff, { scope: "3", qty: 1000, uom: "GBP", factor: 0.6, original: "SWC-SPEND-77" }),
      migrated(UAE.gas, { scope: "1", qty: 1000, uom: "kWh", factor: 0.2, original: "gas" }),
      migrated(UAE.gbOnly, { scope: "1", qty: 100, uom: "kWh", factor: 0.3, original: "gb-only" })]);
    const carry = (id: string, kg: number): V7ReingestPlanRow => ({ v7RowId: id, disposition: "CARRY-V7-FACTOR", categoryCode: "3.1", scope: "3.1", sourceLabel: "Spend",
      quantity: 1000, unit: "GBP", carriedFactor: { label: "V7 SWC-SPEND-77", unit: "GBP", kgco2ePerUnit: kg, vintageYear: 2025 }, qualityTier: "estimated", v7Tco2e: kg, rule: "CARRY" });
    await reingest(UAE.jobId, [carry(UAE.spend, 0.5), carry(UAE.spendOff, 0.6),
      { v7RowId: UAE.gas, disposition: "RE-INGEST", categoryCode: "1.natural-gas", scope: "1", sourceLabel: "Natural gas", quantity: 1000, unit: "kWh",
        datasetId: "uk-ghg-gb-2025", factorId: "gas", qualityTier: "measured", v7Tco2e: 0.2, rule: "S1-GAS" },
      { v7RowId: UAE.gbOnly, disposition: "RE-INGEST", categoryCode: "1.natural-gas", scope: "1", sourceLabel: "A UK-only line", quantity: 100, unit: "kWh",
        datasetId: "uk-ghg-gb-2025", factorId: "gb-only", qualityTier: "measured", v7Tco2e: 0.03, rule: "S1-GAS" }], ["uk-ghg-gb-2025"]);
    // UNMATCHED: a client whose registered country the matcher can't read; no rows.
    await job(UNMATCHED, "c-ab", "2025-01-01", "2025-12-31", 9996);
  });
  after(async () => { await db?.end(); await database?.end(); });

  it("the dry run: each job's whole act, rolled back — what it would write, and why the rest is listed; nothing written", async () => {
    const print = await fingerprint();
    calls.length = 0; waits.length = 0;
    const result = await run();
    assert.equal(result.stopped, "completed");
    assert.deepEqual(result.jobs.map((entry) => [entry.jobNumber, entry.status]), [[SPAN.number, "would-write"], [ISSUED.number, "listed-issued"],
      [OFF.number, "does-not-reconcile"], [CHANGED.number, "v7-row-changed"], [UAE.number, "would-write"], [UNMATCHED.number, "would-write"]]);

    // A: the positionally-mapped job shows its re-read months and a reconciling after — V7's own, per scope.
    const span = of(result.jobs, SPAN);
    assert.deepEqual([span.monthsMoved, span.repriced, span.repointed], [1, 1, 0], "the electricity's months moved and it re-priced; the annual gas didn't move");
    const s2 = span.scopes.find((entry) => entry.scope === "2")!;
    assert.ok(close(s2.before, STORED) && close(s2.after, V7_ELEC) && close(s2.previous!, V7_ELEC), `Scope 2 ${s2.before} → ${s2.after}, V7 ${s2.previous}`);
    // B: the second year's edition comes in; the automatic CEDA GB 2025 goes; the manual Watershed pick moves to its successor (L-4).
    assert.deepEqual([span.selectionsAdded, span.selectionsRemoved], [["ceda-es-2025-edition-2026-rc", "uk-ghg-gb-2026"], ["ceda-es-2025", "ceda-gb-2025"]]);
    assert.deepEqual([span.countryBefore, span.countryAfter, span.countryAssumed], ["GB", "GB", false]);

    assert.deepEqual(of(result.jobs, ISSUED).codes, ["ISSUED"], "a snapshot freezes it: listed, never written");
    // BF-6: a two-year job that doesn't reconcile is listed whole, the row that differs named.
    const off = of(result.jobs, OFF);
    assert.deepEqual(off.misses.map((miss) => [miss.legacyDbId, miss.scope, miss.reason]), [[OFF.elec, "2", "no-match"]]);
    assert.deepEqual(of(result.jobs, CHANGED).rows.map((row) => row.code), ["V7_ROW_CHANGED"], "V7 changed it since import: a bring-in, not a backfill");

    // C + D: the UAE job becomes AE; the equal rows re-point, the unequal one and the line with no twin are listed.
    const uae = of(result.jobs, UAE);
    assert.deepEqual([uae.countryBefore, uae.countryAfter, uae.repointed], ["GB", "AE", 2]);
    const notMoved = Object.fromEntries(uae.rows.map((row) => [row.rowId, row.code]));
    assert.deepEqual(Object.values(notMoved).sort(), ["DOES_NOT_REPRODUCE", "NO_UAE_FACTOR"]);
    assert.deepEqual([uae.selectionsAdded, uae.selectionsRemoved], [["uk-ghg-ae-2025"], ["ceda-gb-2025"]], "DESNZ GB 2025 kept: a row still cites it");
    assert.deepEqual(uae.scopes.map((entry) => [entry.before, entry.after].map((n) => Math.round(n * 1e4) / 1e4)), [[0.23, 0.23], [0, 0], [1.1, 1.1]], "D moves no figure");
    const unmatched = of(result.jobs, UNMATCHED);
    assert.deepEqual([unmatched.countryAfter, unmatched.countryAssumed, unmatched.selectionsRemoved], ["GB", true, ["ceda-gb-2025"]], "GB kept, flagged (D-D)");

    assert.deepEqual(calls, [SPAN.v7JobId, OFF.v7JobId, CHANGED.v7JobId], "endpoint 2 once per two-year job with re-ingested rows; never an issued one's, never a calendar year's");
    assert.ok(waits.length > 0 && waits.every((ms) => ms >= 2_000), `the 2 s floor after each job that called V7: ${waits.join(", ")}`);
    assert.deepEqual(await fingerprint(), print, "a dry run writes nothing");

    dryRunCsv = v7BackfillCsv(result.jobs);
    const lines = dryRunCsv.split("\n");
    assert.equal(lines[0], V7_BACKFILL_CSV_HEADER);
    assert.deepEqual([...parseV7BackfillApproved(dryRunCsv).keys()], [SPAN.number, UAE.number, UNMATCHED.number], "only would-write lines are approvable");
    assert.deepEqual(v7BackfillTotals(result.jobs).filter((row) => row.jobs).map((row) => [row.status, row.jobs]),
      [["would-write", 3], ["does-not-reconcile", 1], ["listed-issued", 1], ["v7-row-changed", 1]]);
    assert.ok(!/GBP|kWh|Electricity|Natural gas|Spend line/.test(dryRunCsv), "ids, codes and tCO2e only — no unit, money or label");
  });

  it("--commit needs the approved list, and the Admin: refused before anything is read", async () => {
    await assert.rejects(run({ commit: true }), /APPROVAL_REQUIRED/);
    await assert.rejects(run({ commit: true, jobNumbers: [SPAN.number] }), /APPROVAL_REQUIRED/);
    await assert.rejects(run({ actorId: "staff-consultant" }), /NOT_ADMIN/);
    await assert.rejects(run({ reason: "short" }), /REASON_REQUIRED/);
  });

  it("BF-4: the commit binds to the approved figures — a job whose after isn't the approved one is listed, not written", async () => {
    const untouched = await jobPrint(SPAN.jobId);
    const approved = parseV7BackfillApproved(dryRunCsv);
    approved.set(SPAN.number, { ...approved.get(SPAN.number)!, "2": approved.get(SPAN.number)!["2"] + 0.5 });
    const result = await run({ commit: true, jobNumbers: [SPAN.number], approved });
    assert.deepEqual(result.jobs.map((entry) => [entry.status, entry.codes]), [["changed-since-approval", ["CHANGED_SINCE_APPROVAL"]]]);
    assert.equal(await jobPrint(SPAN.jobId), untouched);
  });

  it("--commit: the approved jobs are written, checked for drift (trigger backfill), and nothing else is touched", async () => {
    const untouched = await Promise.all([ISSUED, OFF, CHANGED].map((entry) => jobPrint(entry.jobId)));
    const approved = parseV7BackfillApproved(dryRunCsv);
    const result = await run({ commit: true, jobNumbers: [SPAN.number, OFF.number, UAE.number, UNMATCHED.number], approved });
    assert.deepEqual(result.jobs.map((entry) => [entry.jobNumber, entry.status]),
      [[SPAN.number, "written"], [OFF.number, "not-approved"], [UAE.number, "written"], [UNMATCHED.number, "written"]]);
    assert.equal(result.auditEvents, 3);

    // A: the months are calendar months, the figure V7's, the row back to pending; the annual gas untouched (BF-5), still approved.
    const elec = await liveRow(SPAN.elec);
    assert.deepEqual(elec.monthly.slice(0, 1).concat(elec.monthly.slice(9, 10)), [{ month: "2025-04", quantity: 4000 }, { month: "2026-01", quantity: 1000 }]);
    assert.ok(close(elec.tco2e, V7_ELEC), `${elec.tco2e}`);
    assert.equal(elec.review_status, "pending", "a moved row returns to pending: v7:batch-attest re-attests it");
    assert.ok(elec.lineage.some((entry) => entry.title === "Re-ingested from NZ Insights Pro v7"), "the import's marks carried forward");
    assert.ok(elec.lineage.some((entry) => entry.title === "Months re-read by calendar month"));
    assert.ok(elec.reingest, "the re-ingest's provenance kept");
    assert.equal((await liveRow(SPAN.gas)).review_status, "approved", "a row that doesn't change is never written (BF-5)");
    assert.deepEqual(await selections(SPAN.jobId), ["ceda-es-2025-edition-2026-rc:manual", "uk-ghg-gb-2025:automatic", "uk-ghg-gb-2026:automatic"]);
    const reason = (await db.query<{ reason: string }>(`SELECT reason FROM nzi_console.job_dataset_selections WHERE organisation_id = $1 AND job_id = $2 AND dataset_id = 'ceda-es-2025-edition-2026-rc'`,
      [ORG, SPAN.jobId])).rows[0]!.reason;
    assert.match(reason, /^Spain spend \(test\) \(moved from ceda-es-2025/, "the manual pick's reason kept (L-4)");
    // The drift check after the write, stored with its own trigger: level.
    const checks = (await db.query<{ job_id: string; trigger: string; outcome: string }>(
      `SELECT job_id, trigger, outcome FROM nzi_console.v7_drift_checks WHERE organisation_id = $1 ORDER BY job_id`, [ORG])).rows;
    assert.deepEqual(checks, [{ job_id: SPAN.jobId, trigger: "backfill", outcome: "level" }, { job_id: UAE.jobId, trigger: "backfill", outcome: "level" },
      { job_id: UNMATCHED.jobId, trigger: "backfill", outcome: "level" }], "drift reads level after each write");
    const audit = (await db.query<{ actor_id: string; reason: string; after_json: { monthsMoved: number; repriced: number } }>(
      `SELECT actor_id, reason, after_json FROM nzi_console.audit_events WHERE organisation_id = $1 AND action = $2 AND entity_id = $3`, [ORG, V7_BACKFILL_AUDIT_ACTION, SPAN.jobId])).rows;
    assert.deepEqual(audit.map((row) => [row.actor_id, row.reason, row.after_json.monthsMoved, row.after_json.repriced]), [["staff-admin", "R2 backfill (test)", 1, 1]], "one audit event, the person's");

    // C + D: AE, the equal rows on UAE A&S, the rest where they were; DESNZ GB 2025 still selected, as a row cites it.
    assert.equal(await country(UAE.jobId), "AE");
    const spend = await liveRow(UAE.spend);
    assert.deepEqual([spend.factor_source, spend.dataset_id, spend.factor_id, spend.client_factor_id], ["dataset", "uk-ghg-ae-2025", "uk-ghg-SWC-SPEND-77", null]);
    assert.ok(close(spend.tco2e, 0.5));
    assert.deepEqual([(await liveRow(UAE.gas)).dataset_id, (await liveRow(UAE.gbOnly)).dataset_id, (await liveRow(UAE.spendOff)).factor_source],
      ["uk-ghg-ae-2025", "uk-ghg-gb-2025", "client"], "equal rows re-pointed; the unequal one and the one with no twin listed, unmoved");
    assert.deepEqual(await selections(UAE.jobId), ["uk-ghg-ae-2025:automatic", "uk-ghg-gb-2025:automatic"], "no row is left on an edition the job doesn't select");
    const uaeTotals = await withTenantRead(database.pool, ORG, (client) => readConsoleScopeTotals(client, ORG, UAE.jobId));
    assert.ok(close(uaeTotals["1"], 0.23) && close(uaeTotals["3"], 1.1));
    assert.deepEqual([await country(UNMATCHED.jobId), await selections(UNMATCHED.jobId)], ["GB", ["uk-ghg-gb-2025:automatic"]], "an unmatched country keeps GB");

    assert.deepEqual(await Promise.all([ISSUED, OFF, CHANGED].map((entry) => jobPrint(entry.jobId))), untouched,
      "the issued job, the one that doesn't reconcile and the changed one: nothing written — not even their datasets (BF-6)");
  });

  it("a re-run is unchanged: nothing moves, nothing is written, no audit event", async () => {
    const print = await fingerprint();
    const dry = await run({ jobNumbers: [SPAN.number, UAE.number, UNMATCHED.number] });
    assert.deepEqual(dry.jobs.map((entry) => entry.status), ["unchanged", "unchanged", "unchanged"]);
    const commit = await run({ commit: true, jobNumbers: [SPAN.number, UAE.number, UNMATCHED.number], approved: parseV7BackfillApproved(dryRunCsv) });
    assert.deepEqual([commit.jobs.map((entry) => entry.status), commit.auditEvents], [["unchanged", "unchanged", "unchanged"], 0]);
    assert.deepEqual(await fingerprint(), print);
  });

  it("the breaker: three jobs in a row with the previous system not answering stop the run", async () => {
    const down: V7RowFiguresClient = async ({ v7JobId }) => { calls.push(v7JobId); return { ok: false, reason: "unreachable" }; };
    calls.length = 0;
    const result = await run({ rowFigures: down });
    assert.deepEqual([result.stopped, result.jobs.map((entry) => entry.status)], ["source-unresponsive", ["figures-unread", "listed-issued", "figures-unread", "figures-unread"]]);
    assert.deepEqual(calls, [SPAN.v7JobId, OFF.v7JobId, CHANGED.v7JobId]);
  });
});
