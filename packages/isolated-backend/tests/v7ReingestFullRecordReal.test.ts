import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { commandGrantForRole, V7_REINGEST_ACTOR, type CommandContext, type V7ReingestJobInput, type V7ReingestPlanRow } from "@nzi/contracts";
import { CommandValidationError } from "../src/postgresCommands";
import { withTenantWrite } from "../src/postgres";
import { reingestV7JobInTransaction, v7MonthSlots } from "../src/v7Reingest";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";

/**
 * RULING-v7-reingest-full-record against a real database: the re-ingest reproduces the full v7 record of account, not only the
 * figures. Each live row carries its v7 row's site, data confidence, column text and monthly activity — read from the stored v7
 * row, never the plan — with v7's data source as a lineage line; nothing of the not-carried list (evidence, register / auto-pair
 * markers, money). An unusable site or months that do not fit refuse the run, named, before anything is written. D7 reconciles
 * per site (Unallocated its own bucket) and checks each carried field per row — so J000663's dropped sites cannot commit.
 */
const ORG = "v7-full";
const CROSSWALK_SHA = "d4c14407379377d20aeccebd9256eaf7ef7124846b07e05b3a0bf4afd233c8f2";
type V7 = { id: string; scope: string; label: string; qty: number; unit: string; reported: number; site: string | null; confidence?: "H" | "M" | null;
  columnText?: string | null; months?: Array<number | null>; source?: string; autoPair?: boolean };
const months12 = (values: Record<number, number>) => Array.from({ length: 12 }, (_, i) => values[i + 1] ?? null);

describe("the re-ingest carries the full v7 record, and D7 reconciles per site", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;
  let keys = 0;
  const reingest = (): CommandContext => {
    keys += 1;
    return { organisationId: ORG, actorId: V7_REINGEST_ACTOR, principal: "system", idempotencyKey: `ri-${keys}`, correlationId: `corr-${keys}`,
      reason: "v7 re-ingest (test)", grant: commandGrantForRole("admin", ORG, V7_REINGEST_ACTOR) };
  };
  const codes = (error: unknown) => error instanceof CommandValidationError ? error.issues.map((issue) => issue.code) : [String(error)];
  const messages = (error: unknown) => error instanceof CommandValidationError ? error.issues.map((issue) => issue.message).join(" | ") : String(error);
  const count = async (sql: string, params: unknown[] = []) => Number((await db.query(sql, params)).rows[0]!.n);

  async function seedJob(job: string, sequence: number, period: [string, string], rows: V7[]) {
    await db.query(`INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage,reporting_year,reporting_period_start,reporting_period_end,source_system,legacy_db_id)
      VALUES ($1,$2,'c1',$3,'crp','CRP','open','Data entry',2025,$4,$5,'nzi-pro-v7',$6)`, [ORG, job, sequence, period[0], period[1], String(sequence)]);
    await db.query(`INSERT INTO nzi_console.job_emissions_config (organisation_id,job_id,reporting_from,reporting_to,country_code) VALUES ($1,$2,$3,$4,'GB')`, [ORG, job, period[0], period[1]]);
    for (const row of rows) {
      const record: Record<string, unknown> = { qty: row.qty, uom: row.unit, factor: 0, ghg_unit: "kgCO2e", original_id: "7_x", reported_tco2e: row.reported,
        data_source: row.source ?? "Company Data", data_confidence: row.confidence ?? null, enabled: true, apply_pct: 100, stored_calc_tco2e: row.reported, override_tco2e: null, review_status: null };
      if (row.months) record.months = row.months;
      if (row.source === "Spend Data") record.evidence = { spend: { entry_ids: ["1", "2"], count: 2, amount_gross: 4502003.46, currencies: ["GBP"] } };
      await db.query(`INSERT INTO nzi_console.job_scope_rows (organisation_id,scope_row_id,job_id,scope,source_label,report_label,level_1,level_2,level_3,quantity,unit,
          calculated_tco2e,review_status,enabled,origin,migrated_record,source_system,legacy_db_id,site_id,data_confidence,column_text,is_auto_generated,auto_pair_kind)
        VALUES ($1,$2,$3,$4,$5,$5,'v7 level 1','v7 level 2','v7 level 3',$6,$7,$8,'pending',true,'migrated',$9::jsonb,'nzi-pro-v7',$2,$10,$11,$12,$13,$14)`,
        [ORG, row.id, job, row.scope, row.label, row.qty, row.unit, row.reported, JSON.stringify(record), row.site, row.confidence ?? null, row.columnText ?? null,
          row.autoPair ?? false, row.autoPair ? "employee_commuting" : null]);
    }
  }
  const planRow = (row: V7): V7ReingestPlanRow => ({ v7RowId: row.id, disposition: "RE-INGEST", categoryCode: "1.natural-gas", scope: "1", sourceLabel: row.label,
    quantity: row.qty, unit: "kWh", datasetId: "v7-vintage-2025", factorId: "gas", qualityTier: "measured", v7Tco2e: row.reported, rule: "S1-GAS" });
  const plan = (job: string, rows: V7[]): V7ReingestJobInput => ({ jobId: job, runId: `v7-reingest-${randomUUID()}`, crosswalkVersion: "v1", crosswalkSha256: CROSSWALK_SHA,
    vintageDatasetIds: ["v7-vintage-2025"], rows: rows.map(planRow) });
  const run = (input: V7ReingestJobInput) => withTenantWrite(database.pool, ORG, (client) => reingestV7JobInTransaction(client, input, reingest()));
  const liveFor = async (job: string, v7: string) => (await db.query(
    `SELECT site_id, data_confidence, column_text, monthly_activity_json AS monthly, quantity::float AS q, coalesce(override_tco2e, calculated_tco2e)::float AS t,
            is_auto_generated, auto_pair_kind, source_id, provenance_json::text AS provenance, lineage_json AS lineage, level_3
       FROM nzi_console.job_scope_rows WHERE job_id=$1 AND origin='live' AND enabled AND reingested_from_row_id=$2`, [job, v7])).rows[0]!;

  before(async () => {
    database = (await createDisposableDatabase("v7full"))!;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,$1)`, [ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
    await db.query(`INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,'c1','EFF Test','active'), ($1,'c2','Other','active')`, [ORG]);
    for (const [client, site, archived] of [["c1", "v7-site-uk", false], ["c1", "v7-site-pl", false], ["c1", "v7-site-old", true], ["c1", "v7-site-out", false], ["c2", "v7-site-other", false]] as const)
      await db.query(`INSERT INTO nzi_console.client_sites (organisation_id,client_id,site_id,name,created_by,archived) VALUES ($1,$2,$3,$3,'seed',$4)`, [ORG, client, site, archived]);
    await db.query(`INSERT INTO nzi_console.emission_factor_datasets (organisation_id,dataset_id,name,version,valid_from,valid_to,country_code,status,source_name,licence)
                    VALUES ($1,'v7-vintage-2025','DESNZ GB 2025 (v7 vintage)','1','2025-01-01','2025-12-31','GB','active','Test','Source: test.')`, [ORG]);
    await db.query(`INSERT INTO nzi_console.emission_factors (organisation_id,dataset_id,factor_id,label,activity_unit,kgco2e_per_unit,scopes) VALUES ($1,'v7-vintage-2025','gas','Natural gas','kWh',0.2,ARRAY['1'])`, [ORG]);
  });
  after(async () => { await db?.end(); await database?.end(); });

  describe("a faithful run", () => {
    const JOB = "full-job";
    const rows: V7[] = [
      { id: "v7-gas-uk", scope: "1", label: "Natural gas", qty: 1200, unit: "kWh", reported: 0.24, site: "v7-site-uk", confidence: "H", columnText: "Mains gas",
        months: months12({ 1: 100, 2: 100, 3: 100, 4: 100, 5: 100, 6: 100, 7: 100, 8: 100, 9: 100, 10: 100, 11: 100, 12: 100 }), source: "Company Data" },
      { id: "v7-gas-pl", scope: "1", label: "Natural gas", qty: 0, unit: "kWh", reported: 0, site: "v7-site-pl", confidence: "M", source: "Spend Data" },
      { id: "v7-gas-none", scope: "1", label: "Natural gas (no site)", qty: 500, unit: "kWh", reported: 0.1, site: null, confidence: null, months: months12({ 3: 250, 9: 250 }), autoPair: true },
    ];
    let outcome: Awaited<ReturnType<typeof run>>;
    before(async () => { await seedJob(JOB, 1, ["2025-01-01", "2025-12-31"], rows); });

    it("commits: D7 holds — total, scope, each site, each row and each of its carried fields", async () => {
      outcome = await run(plan(JOB, rows));
      assert.equal(outcome.data.nativeTotalTco2e, outcome.data.v7TotalTco2e);
    });

    it("carries each v7 row's site, data confidence, column text and monthly activity onto its live row", async () => {
      const uk = await liveFor(JOB, "v7-gas-uk");
      assert.deepEqual([uk.site_id, uk.data_confidence, uk.column_text], ["v7-site-uk", "H", "Mains gas"]);
      assert.deepEqual((uk.monthly as Array<{ month: string; quantity: number }>).map((slot) => [slot.month, Number(slot.quantity)]),
        Array.from({ length: 12 }, (_, i) => [`2025-${String(i + 1).padStart(2, "0")}`, 100]), "slot i on reporting month i");
      const pl = await liveFor(JOB, "v7-gas-pl");
      assert.deepEqual([pl.site_id, pl.data_confidence, pl.monthly], ["v7-site-pl", "M", []], "a site at 0 t keeps its site");
      const none = await liveFor(JOB, "v7-gas-none");
      assert.deepEqual([none.site_id, none.data_confidence], [null, null], "where v7 named no site, Unallocated — faithfully");
    });

    it("months are figure-inert: each row's quantity and tCO₂e are v7's", async () => {
      assert.deepEqual([(await liveFor(JOB, "v7-gas-uk")).q, (await liveFor(JOB, "v7-gas-uk")).t], [1200, 0.24]);
      assert.deepEqual([(await liveFor(JOB, "v7-gas-none")).q, (await liveFor(JOB, "v7-gas-none")).t], [500, 0.1]);
    });

    it("v7's data source is a lineage line; nothing of the not-carried list reaches the live row", async () => {
      const uk = await liveFor(JOB, "v7-gas-uk"), pl = await liveFor(JOB, "v7-gas-pl"), none = await liveFor(JOB, "v7-gas-none");
      assert.ok((uk.lineage as Array<{ title: string; detail: string }>).some((line) => line.title === "v7 data source" && line.detail === "Company Data"));
      assert.ok((pl.lineage as Array<{ title: string; detail: string }>).some((line) => line.title === "v7 data source" && line.detail === "Spend Data"));
      assert.doesNotMatch(pl.provenance, /4502003|amount_gross|entry_ids|"evidence"|"spend"/, "NZC-120: v7's spend evidence (gross money) stays on the v7 row");
      assert.doesNotMatch(JSON.stringify(pl.lineage), /4502003|amount_gross|entry_ids/, "nor in its lineage");
      assert.deepEqual([none.is_auto_generated, none.auto_pair_kind, none.source_id], [false, null, null], "register / auto-pair markers are not carried");
      assert.equal(uk.level_3, null, "v7's category path is not carried — the crosswalk's category is the row's");
    });

    it("the run reports per site (Unallocated its own bucket) and what it carried", () => {
      assert.deepEqual(outcome.data.siteTotals, {
        "v7-site-pl": { rows: 1, v7: 0, native: 0 }, "v7-site-uk": { rows: 1, v7: 0.24, native: 0.24 }, unallocated: { rows: 1, v7: 0.1, native: 0.1 } });
      assert.deepEqual(outcome.data.carried, { site: 2, dataConfidence: 2, columnText: 1, months: 2 });
    });
  });

  describe("refused, named, before anything is written", () => {
    it("SITE_NOT_USABLE: an archived site, a site the job excludes, another client's site, no such site", async () => {
      const JOB = "site-job";
      const rows: V7[] = [
        { id: "s-ok", scope: "1", label: "Gas", qty: 10, unit: "kWh", reported: 0.002, site: "v7-site-uk" },
        { id: "s-old", scope: "1", label: "Gas", qty: 10, unit: "kWh", reported: 0.002, site: "v7-site-old" },
        { id: "s-out", scope: "1", label: "Gas", qty: 10, unit: "kWh", reported: 0.002, site: "v7-site-out" },
        { id: "s-other", scope: "1", label: "Gas", qty: 10, unit: "kWh", reported: 0.002, site: "v7-site-other" },
      ];
      await seedJob(JOB, 2, ["2025-01-01", "2025-12-31"], rows);
      await db.query(`INSERT INTO nzi_console.job_site_inclusions (organisation_id,job_id,site_id,version,included,reason,decided_by,correlation_id)
                      VALUES ($1,$2,'v7-site-out',1,false,'not reported this year','seed','c')`, [ORG, JOB]);
      await assert.rejects(run(plan(JOB, rows)), (error) => {
        assert.deepEqual(codes(error), ["SITE_NOT_USABLE", "SITE_NOT_USABLE", "SITE_NOT_USABLE"]);
        assert.match(messages(error), /s-old .*archived/);
        assert.match(messages(error), /s-out .*excluded from this job/);
        assert.match(messages(error), /s-other .*another client's site/);
        return true;
      });
      assert.equal(await count(`SELECT count(*) AS n FROM nzi_console.job_scope_rows WHERE job_id=$1 AND origin='live'`, [JOB]), 0);
      assert.equal(await count(`SELECT count(*) AS n FROM nzi_console.v7_reingest_runs WHERE job_id=$1`, [JOB]), 0);
    });

    it("MONTHS_DO_NOT_FIT: activity in a month outside a short period; months that do not sum to the quantity", async () => {
      const JOB = "months-job";
      const rows: V7[] = [
        // A six-month period: v7's month 9 has activity, so it falls outside.
        { id: "m-outside", scope: "1", label: "Gas", qty: 300, unit: "kWh", reported: 0.06, site: "v7-site-uk", months: months12({ 1: 100, 2: 100, 9: 100 }) },
        // Months whose sum is not the row's quantity: carrying them would move the figure.
        { id: "m-sum", scope: "1", label: "Gas", qty: 999, unit: "kWh", reported: 0.1998, site: "v7-site-uk", months: months12({ 1: 100 }) },
        // Zero outside the period carries nothing and is no refusal.
        { id: "m-zero-outside", scope: "1", label: "Gas", qty: 100, unit: "kWh", reported: 0.02, site: "v7-site-uk", months: months12({ 1: 100, 10: 0 }) },
      ];
      await seedJob(JOB, 3, ["2025-01-01", "2025-06-30"], rows);
      await assert.rejects(run(plan(JOB, rows)), (error) => {
        assert.deepEqual(codes(error), ["MONTHS_DO_NOT_FIT", "MONTHS_DO_NOT_FIT"]);
        assert.match(messages(error), /m-outside has activity in month 9 of 12, outside this job's 6-month/);
        assert.match(messages(error), /m-sum's months sum to 100, not its quantity 999/);
        return true;
      });
      assert.equal(await count(`SELECT count(*) AS n FROM nzi_console.job_scope_rows WHERE job_id=$1 AND origin='live'`, [JOB]), 0);
    });

    it("positional months on a short period: slot i on reporting month i, nothing beyond", () => {
      const { slots, outside } = v7MonthSlots(months12({ 1: 5, 6: 7, 10: 0 }), ["2025-04", "2025-05", "2025-06", "2025-07", "2025-08", "2025-09"]);
      assert.deepEqual(outside, []);
      assert.deepEqual(slots, [{ month: "2025-04", quantity: 5 }, { month: "2025-05", quantity: null }, { month: "2025-06", quantity: null },
        { month: "2025-07", quantity: null }, { month: "2025-08", quantity: null }, { month: "2025-09", quantity: 7 }]);
      assert.deepEqual(v7MonthSlots(months12({}), ["2025-01"]), { slots: null, outside: [] }, "no months in v7, none carried");
    });
  });

  describe("D7 per site and per field: J000663's dropped site cannot commit", () => {
    it("a site stripped on the way in refuses the whole run — POSTCONDITION_FAILED — and nothing is written", async () => {
      const JOB = "drop-job";
      const rows: V7[] = [{ id: "d-uk", scope: "1", label: "Gas", qty: 1000, unit: "kWh", reported: 0.2, site: "v7-site-uk", confidence: "H" }];
      await seedJob(JOB, 4, ["2025-01-01", "2025-12-31"], rows);
      // A stand-in for the old code path: whatever lands, the live row's site is dropped.
      await db.query(`CREATE FUNCTION public.test_drop_site() RETURNS trigger LANGUAGE plpgsql AS $$
                        BEGIN IF NEW.origin = 'live' AND NEW.job_id = 'drop-job' THEN NEW.site_id := NULL; END IF; RETURN NEW; END $$`);
      await db.query(`CREATE TRIGGER test_drop_site BEFORE INSERT OR UPDATE ON nzi_console.job_scope_rows FOR EACH ROW EXECUTE FUNCTION public.test_drop_site()`);
      try {
        await assert.rejects(run(plan(JOB, rows)), (error) => {
          assert.deepEqual(codes(error), ["POSTCONDITION_FAILED"]);
          // RULING-v7-book-runner R3: the per-site emission totals are the delta report's now, not a refusal — the row's own carried
          // site is what refuses it, and still does.
          assert.match(messages(error), /site none ≠ v7's "v7-site-uk"/);
          assert.doesNotMatch(messages(error), /live 0\.000000 t ≠ v7/, "no emission total refuses the run");
          return true;
        });
      } finally {
        await db.query(`DROP TRIGGER test_drop_site ON nzi_console.job_scope_rows`);
        await db.query(`DROP FUNCTION public.test_drop_site()`);
      }
      assert.equal(await count(`SELECT count(*) AS n FROM nzi_console.job_scope_rows WHERE job_id=$1 AND origin='live'`, [JOB]), 0);
      assert.equal(await count(`SELECT count(*) AS n FROM nzi_console.job_scope_rows WHERE job_id=$1 AND origin='migrated' AND enabled`, [JOB]), 1, "the v7 row stays on");
    });
  });
});
