import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { commandGrantForRole, composeReportAudit, composeScopedEmissions, type CommandContext } from "@nzi/contracts";
import type { StaffPrincipal } from "../src/auth";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { calculateScopeRow, createReviewedCrpSnapshot, createScopeRow, rollforwardScopeRows } from "../src/postgresCommands";
import { retireFactorApplicability } from "../src/factorApplicability";
import { listScopeRows } from "../src/readModels";
import { withTenantRead } from "../src/postgres";

/**
 * Dedup slice 5 Steps C and E (migrations 0174, 0175). C: every live row on a covered variant id is re-filed as its base under the pair — base,
 * `filed_suffix_code`, the pair's factor label, `filedUnder` — with nothing priced or printed moving, and nothing else touched:
 * not a scope-shifted `-bcp` row, not a variant under a category that isn't its pair's, not a re-ingested row (ruled 21 Oct: those
 * move by revert and re-run), and never a frozen snapshot.
 *
 * **The gate**: the same J000663 entries written on variant ids into two jobs; one frozen before 0174, the other frozen after it —
 * identical, measurement for measurement, in totals and in the composed report. 0174 is pure data, so its own SQL is run here over
 * rows written as they were before it (the migration itself already ran, over an empty table, when the database was built).
 *
 * E: then every covered variant row nothing cites is retired (`active = false`, never deleted) — not the scope-shifted `-bcp`, not one a
 * live row still cites (J000663's re-ingested rows, ruled 21 Oct 2026 "Option 2"), not one whose base is withdrawn or whose pair is
 * retired — and the inert scope-mismatched pair is retired. The report frozen after both is the report frozen before either.
 *
 * Rows "as written before Step A" are written through the commands (which file them, since Step A) and put back on their variant ids
 * in SQL — exactly the representation 0174 reverses.
 *
 * Also here, from the Step B review: roll-forward's active-recheck — a prior row whose pair has since been retired carries neither the
 * pair nor its label forward.
 */
const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(resolve(here, "../migrations/0174_scope_rows_filed_by_applicability.sql"), "utf8");
const RETIREMENT = readFileSync(resolve(here, "../migrations/0175_retire_covered_variants.sql"), "utf8");
const ORG = "org-s5c", CLIENT = "client-s5c", ACTOR = "ada";
const OLD = "job-s5c-frozen-before", NEW = "job-s5c-frozen-after", REIN = "job-s5c-reingested", PRIOR = "job-s5c-prior", NEXT = "job-s5c-next", MISC = "job-s5c-misc";
const DS = "gb-2025", DS_VERSION = "2025.1", DS_ALT = "gb-2025-alt";

type Factor = { id: string; unit: string; value: number; scopes: string[]; label: string; reportLabel: string };
const F = (id: string, unit: string, value: number, scopes: string[], label: string, reportLabel: string): Factor => ({ id, unit, value, scopes, label, reportLabel });
const FACTORS: Factor[] = [
  F("uk-ghg-25_301_3070_9_1", "miles", 0.26187, ["3"], "Business travel- land - Cars (by size) - Average car - Petrol", "Business Travel: Average Car Petrol"),
  F("uk-ghg-25_301_3070_9_1-c", "miles", 0.26187, ["3"], "Employee commuting- land - Cars (by size) - Average car - Petrol", "Employee Commuting: Average Car Petrol"),
  F("uk-ghg-25_315_3147_11_1", "passenger.km", 0.03546, ["3"], "Business travel- land - Rail - National rail", "Business Travel: Rail National Rail"),
  F("uk-ghg-25_315_3147_11_1-c", "passenger.km", 0.03546, ["3"], "Employee commuting- land - Rail - National rail", "Employee Commuting: Rail National Rail"),
  F("uk-ghg-SPEND-SIC-49.3-5", "GBP", 0.57488070034094, ["3"], "Land transport services", "Spend: Land Transport"),
  F("uk-ghg-SPEND-SIC-49.3-5-b", "GBP", 0.57488070034094, ["3"], "Land transport services", "Spend: Land Transport"),
  F("uk-ghg-SPEND-SIC-49.3-5-u", "GBP", 0.57488070034094, ["3"], "Land transport services", "Spend: Land Transport"),
  F("uk-ghg-SPEND-SIC-49.3-5-d", "GBP", 0.57488070034094, ["3"], "Land transport services", "Spend: Land Transport"),
  F("uk-ghg-27_320_3235_14_1", "tonne.km", 0.01612, ["3"], "Freighting goods - Cargo ship - Container ship", "Freight: Container Ship"),
  F("uk-ghg-27_320_3235_14_1-d", "tonne.km", 0.01612, ["3"], "Freighting goods - Cargo ship - Container ship", "Freight: Container Ship"),
  F("uk-ghg-4_301_3070_4_1", "km", 0.16272, ["1"], "Passenger vehicles - Large car - Diesel", "Company Vehicles: Large Car Diesel"),
  F("uk-ghg-4_301_3070_4_1-bcp", "km", 0.16272, ["3"], "Business travel - Large car - Diesel", "Business Travel: Large Car Diesel"),
  // A commuting copy whose pair is retired before 0174 runs.
  F("uk-ghg-25_301_3071_9_1", "miles", 0.27, ["3"], "Business travel- land - Cars (by size) - Average car - Diesel", "Business Travel: Average Car Diesel"),
  F("uk-ghg-25_301_3071_9_1-c", "miles", 0.27, ["3"], "Employee commuting- land - Cars (by size) - Average car - Diesel", "Employee Commuting: Average Car Diesel"),
  // A commuting copy nothing cites, whose pair is retired before 0175: not covered, so it stays.
  F("uk-ghg-25_301_3072_9_1", "miles", 0.28, ["3"], "Business travel- land - Cars (by size) - Average car - Hybrid", "Business Travel: Average Car Hybrid"),
  F("uk-ghg-25_301_3072_9_1-c", "miles", 0.28, ["3"], "Employee commuting- land - Cars (by size) - Average car - Hybrid", "Employee Commuting: Average Car Hybrid"),
];
const byId = new Map(FACTORS.map((factor) => [factor.id, factor]));

/** J000663's entries as written before Step A: each on its variant id. `refiled`: the base and pair 0174 moves it to, or null (left). */
const ENTRIES = [
  { key: "Car commute", scope: "3.7", factorId: "uk-ghg-25_301_3070_9_1-c", quantity: 1200, refiled: ["uk-ghg-25_301_3070_9_1", "-c"] },
  { key: "Rail commute", scope: "3.7", factorId: "uk-ghg-25_315_3147_11_1-c", quantity: 5000, refiled: ["uk-ghg-25_315_3147_11_1", "-c"] },
  { key: "Travel spend", scope: "3.6", factorId: "uk-ghg-SPEND-SIC-49.3-5-b", quantity: 10000, refiled: ["uk-ghg-SPEND-SIC-49.3-5", "-b"] },
  { key: "Inbound haulage spend", scope: "3.4", factorId: "uk-ghg-SPEND-SIC-49.3-5-u", quantity: 8000, refiled: ["uk-ghg-SPEND-SIC-49.3-5", "-u"] },
  { key: "Outbound haulage spend", scope: "3.9", factorId: "uk-ghg-SPEND-SIC-49.3-5-d", quantity: 6000, refiled: ["uk-ghg-SPEND-SIC-49.3-5", "-d"] },
  { key: "Outbound shipping", scope: "3.9", factorId: "uk-ghg-27_320_3235_14_1-d", quantity: 20000, refiled: ["uk-ghg-27_320_3235_14_1", "-d"] },
  // Left: the scope-shifted copy, and a -d copy filed upstream (3.4's own pair is -u).
  { key: "Large car travel", scope: "3.6", factorId: "uk-ghg-4_301_3070_4_1-bcp", quantity: 300, refiled: null },
  { key: "Haulage (a -d copy, upstream)", scope: "3.4", factorId: "uk-ghg-SPEND-SIC-49.3-5-d", quantity: 50, refiled: null },
] as const;

describe("dedup slice 5 Step C: 0174 re-files live rows off variant ids, byte-identical", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let keys = 0;
  const context = (): CommandContext => {
    keys += 1;
    return { organisationId: ORG, actorId: ACTOR, principal: "staff", idempotencyKey: `s5c-${keys}`, correlationId: `corr-s5c-${keys}`, grant: commandGrantForRole("admin", ORG, ACTOR) };
  };
  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => {
    const db = await database.admin();
    try { return (await db.query(sql, params)).rows as T[]; } finally { await db.end(); }
  };
  /** A migration's own SQL, in one transaction, as the runner applies it. */
  const migrate = async (sql = MIGRATION) => {
    const db = await database.admin();
    try { await db.query("BEGIN"); await db.query(sql); await db.query("COMMIT"); } catch (error) { await db.query("ROLLBACK"); throw error; } finally { await db.end(); }
  };
  /** Rows put back as they were written before Step A: on the variant id, unfiled, with the variant row's label and no `filedUnder`. */
  const asWrittenBeforeStepA = (jobIds: string[]) => q(
    `UPDATE nzi_console.job_scope_rows r
        SET factor_id = r.factor_id || r.filed_suffix_code, filed_suffix_code = NULL, provenance_json = r.provenance_json - 'filedUnder',
            factor_label = coalesce((SELECT f.label FROM nzi_console.emission_factors f WHERE f.organisation_id = r.organisation_id
                                       AND f.dataset_id = r.dataset_id AND f.factor_id = r.factor_id || r.filed_suffix_code), r.factor_label)
      WHERE r.job_id = ANY($1) AND r.origin = 'live' AND r.filed_suffix_code IS NOT NULL`, [jobIds]);
  type Stored = { scope_row_id: string; source_label: string; factor_id: string; filed_suffix_code: string | null; factor_label: string | null; calculated_tco2e: string | null;
    provenance_json: Record<string, unknown>; version: number; review_status: string; reviewed_row_version: number | null; enabled: boolean };
  const rowsOf = async (jobId: string) => new Map((await q<Stored>(
    `SELECT scope_row_id, source_label, factor_id, filed_suffix_code, factor_label, calculated_tco2e, provenance_json, version, review_status, reviewed_row_version, enabled
       FROM nzi_console.job_scope_rows WHERE job_id=$1 AND origin='live'`, [jobId])).map((row) => [row.source_label, row]));
  const write = (jobId: string, entry: typeof ENTRIES[number]) => createScopeRow(database.pool, { jobId, scope: entry.scope, categoryCode: entry.scope, sourceLabel: entry.key, reportLabel: entry.key,
    quantity: entry.quantity, unit: byId.get(entry.factorId)!.unit, datasetId: DS, factorId: entry.factorId, factorVersion: DS_VERSION, factorLabel: byId.get(entry.factorId)!.label, qualityTier: "measured" } as never, context());
  const reads = async (jobId: string) => new Map((await withTenantRead(database.pool, ORG, (db) => listScopeRows(db, jobId))).map((row) => [row.sourceLabel, row.reportLabel]));
  const snapshot = async (jobId: string) => {
    const version = (await q<{ version: number }>(`SELECT version FROM nzi_console.jobs WHERE job_id=$1`, [jobId]))[0]!.version;
    const created = await createReviewedCrpSnapshot(database.pool, { jobId, expectedJobVersion: version }, context());
    return created.data.snapshotId;
  };
  const payloadOf = async (snapshotId: string) => (await q<{ payload: string; json: { measurements: Array<Record<string, unknown>>; provenance: unknown } }>(
    `SELECT payload_json::text AS payload, payload_json AS json FROM nzi_console.reviewed_crp_snapshots WHERE snapshot_id=$1`, [snapshotId]))[0]!;

  before(async () => {
    database = (await createDisposableDatabase("s5crefile", {
      onMigration: async (filename, owner) => {
        if (!filename.startsWith("0169_")) return;
        await owner.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,$1)`, [ORG]);
        await owner.query(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
        await owner.query(`INSERT INTO nzi_console.emission_factor_datasets (organisation_id,dataset_id,name,version,valid_from,valid_to,country_code,status,source_name,licence)
                           VALUES ($1,$2,'DESNZ GB 2025',$3,'2025-01-01','2026-12-31','GB','active','DESNZ','OGL')`, [ORG, DS, DS_VERSION]);
        for (const factor of FACTORS) {
          await owner.query(`INSERT INTO nzi_console.emission_factors (organisation_id,dataset_id,factor_id,label,activity_unit,kgco2e_per_unit,scopes) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [ORG, DS, factor.id, factor.label, factor.unit, factor.value, factor.scopes]);
          await owner.query(`UPDATE nzi_console.factor_identities SET label=$3, report_label=$4 WHERE organisation_id=$1 AND factor_id=$2`, [ORG, factor.id, factor.label, factor.reportLabel]);
        }
      },
    }))!;
    await q(`INSERT INTO nzi_console.memberships (organisation_id,user_id,role_id,status,display_name) VALUES ($1,$2,'admin','active','Ada')`, [ORG, ACTOR]);
    // A second edition, whose spend base is withdrawn once a row cites its -b copy.
    await q(`INSERT INTO nzi_console.emission_factor_datasets (organisation_id,dataset_id,name,version,valid_from,valid_to,country_code,status,source_name,licence)
             VALUES ($1,$2,'DESNZ GB 2025 (alt)','2025.2','2025-01-01','2026-12-31','GB','active','DESNZ','OGL')`, [ORG, DS_ALT]);
    // Uncited here: a -d copy (its base withdrawn below) and the scope-shifted -bcp over its Scope 1 car — neither may retire.
    for (const id of ["uk-ghg-SPEND-SIC-49.3-5", "uk-ghg-SPEND-SIC-49.3-5-b", "uk-ghg-SPEND-SIC-49.3-5-d", "uk-ghg-4_301_3070_4_1", "uk-ghg-4_301_3070_4_1-bcp"]) {
      const factor = byId.get(id)!;
      await q(`INSERT INTO nzi_console.emission_factors (organisation_id,dataset_id,factor_id,label,activity_unit,kgco2e_per_unit,scopes) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [ORG, DS_ALT, id, factor.label, factor.unit, factor.value, factor.scopes]);
    }
    await q(`INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,$2,'Slice Five C Co','active')`, [ORG, CLIENT]);
    for (const [job, seq, year] of [[PRIOR, 1, 2024], [OLD, 2, 2025], [NEW, 3, 2025], [REIN, 4, 2025], [NEXT, 5, 2025], [MISC, 6, 2025]] as const) {
      await q(`INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage,reporting_year,reporting_period_start,reporting_period_end)
               VALUES ($1,$2,$3,$4,'crp','CRP','open','Data entry',$5,$6,$7)`, [ORG, job, CLIENT, seq, year, `${year}-01-01`, `${year}-12-31`]);
      await q(`INSERT INTO nzi_console.job_emissions_config (organisation_id,job_id,reporting_from,reporting_to,country_code) VALUES ($1,$2,$3,$4,'GB')`, [ORG, job, `${year}-01-01`, `${year}-12-31`]);
      await q(`INSERT INTO nzi_console.job_dataset_selections (organisation_id,job_id,dataset_id,selection_source,reason,selected_by) VALUES ($1,$2,$3,'automatic','Fixture',$4)`, [ORG, job, DS, ACTOR]);
    }
    await q(`INSERT INTO nzi_console.job_dataset_selections (organisation_id,job_id,dataset_id,selection_source,reason,selected_by) VALUES ($1,$2,$3,'manual','Fixture',$4)`, [ORG, MISC, DS_ALT, ACTOR]);
    // 0175 retired the seeded variants as the database was built (nothing cited them then). Before C and E, the library had them: held
    // active again, so the rows below are written over the library as it stood.
    await q(`UPDATE nzi_console.emission_factors SET active = true WHERE organisation_id = $1 AND NOT active`, [ORG]);
    // …and the inert pair it retired with them, so the 0175 run below is the one that retires it.
    await q(`UPDATE nzi_console.factor_identity_categories SET status = 'active', retired_at = NULL, retired_by = NULL, retired_reason = NULL
              WHERE organisation_id = $1 AND retired_by = 'migration:0175'`, [ORG]);
    // One citation of each other kind 0175 respects, each on a covered variant of its own, so each clause of the guard is observable:
    // a register source, an emission group and a client alias. (And v7 history naming car -c, which is no citation: it still retires.)
    await q(`INSERT INTO nzi_console.job_emission_sources (organisation_id,source_id,job_id,scope,source_type,source_name,dataset_id,factor_id,factor_source,data_source)
             VALUES ($1,'src-cites-freight',$2,'3.9','travel','Shipping (register)',$3,'uk-ghg-27_320_3235_14_1-d','dataset','Test')`, [ORG, MISC, DS]);
    await q(`INSERT INTO nzi_console.job_emission_groups (organisation_id,group_id,job_id,name,dataset_id,factor_id,created_by)
             VALUES ($1,'grp-cites-spend-b',$2,'Travel spend (group)',$3,'uk-ghg-SPEND-SIC-49.3-5-b',$4)`, [ORG, MISC, DS, ACTOR]);
    await q(`INSERT INTO nzi_console.client_factor_aliases (organisation_id,client_id,factor_id,label,created_by)
             VALUES ($1,$2,'uk-ghg-SPEND-SIC-49.3-5-u','Inbound haulage (our name)',$3)`, [ORG, CLIENT, ACTOR]);
    await q(`INSERT INTO nzi_console.job_scope_rows (organisation_id,scope_row_id,job_id,scope,source_label,report_label,level_1,level_2,category_code,quantity,unit,dataset_id,factor_id,factor_source,calculated_tco2e,enabled,origin,migrated_record,source_system,legacy_db_id)
             VALUES ($1,'v7-car',$2,'3.7','v7 car','v7 car','v7','v7','3.7',100,'miles',$4,'uk-ghg-25_301_3070_9_1-c','dataset',0.026,false,'migrated',$3::jsonb,'nzi-pro-v7','v7-car')`,
      [ORG, REIN, JSON.stringify({ qty: 100, uom: "miles", factor: 0.26187, ghg_unit: "kgCO2e", original_id: "25_301_3070_9_1-c", reported_tco2e: 0.026, data_source: "Company Data", enabled: true }), DS]);
    await retireFactorApplicability(database.pool, { userId: ACTOR, organisationId: ORG, role: "admin", capabilities: [{ capability: "factor.manage", scope: "all" }] } as unknown as StaffPrincipal,
      { organisationId: ORG, factorId: "uk-ghg-25_301_3072_9_1", suffixCode: "-c", reason: "Hybrid commuting moved to its own factor." });
  });
  after(async () => { await database?.end(); });

  it("J000663: rows on variant ids re-filed (0174), covered variants retired (0175) — the report frozen before and the one frozen after are identical", async () => {
    // As written before Step A: on variant ids.
    {
      for (const job of [OLD, NEW]) for (const entry of ENTRIES) await write(job, entry);
      // A re-ingested row (attest-only): v7's -c, linked to its migrated v7 row.
      // The migrated v7 row itself names the variant too: v7 history, immutable (0133) — 0174 reads live rows only.
      await q(`INSERT INTO nzi_console.job_scope_rows (organisation_id,scope_row_id,job_id,scope,source_label,report_label,level_1,level_2,category_code,quantity,unit,dataset_id,factor_id,factor_source,calculated_tco2e,enabled,origin,migrated_record,source_system,legacy_db_id)
               VALUES ($1,'v7-rail',$2,'3.7','v7 rail','v7 rail','v7','v7','3.7',5000,'passenger.km',$4,'uk-ghg-25_315_3147_11_1-c','dataset',0.1773,false,'migrated',$3::jsonb,'nzi-pro-v7','v7-rail')`,
        [ORG, REIN, JSON.stringify({ qty: 5000, uom: "passenger.km", factor: 0.03546, ghg_unit: "kgCO2e", original_id: "25_315_3147_11_1-c", reported_tco2e: 0.1773, data_source: "Company Data", enabled: true }), DS]);
      // Not yet calculated, still carrying an older edition's wording: re-filed, it takes the pair's label.
      await createScopeRow(database.pool, { jobId: MISC, scope: "3.7", categoryCode: "3.7", sourceLabel: "Commute (older wording)", reportLabel: "Commute (older wording)",
        quantity: 10, unit: "miles", datasetId: DS, factorId: "uk-ghg-25_301_3070_9_1-c", factorVersion: DS_VERSION, factorLabel: "Employee commuting - Average car - Petrol (2024 wording)", qualityTier: "measured" } as never, context());
      // A variant whose base has been withdrawn from its edition: nothing to re-file it as.
      await createScopeRow(database.pool, { jobId: MISC, scope: "3.6", categoryCode: "3.6", sourceLabel: "Travel spend (base withdrawn)", reportLabel: "Travel spend (base withdrawn)",
        quantity: 10, unit: "GBP", datasetId: DS_ALT, factorId: "uk-ghg-SPEND-SIC-49.3-5-b", factorVersion: "2025.2", factorLabel: "Land transport services", qualityTier: "spend-based" } as never, context());
      await q(`UPDATE nzi_console.emission_factors SET active=false WHERE organisation_id=$1 AND dataset_id=$2 AND factor_id='uk-ghg-SPEND-SIC-49.3-5'`, [ORG, DS_ALT]);
      // A variant whose pair has been retired: applicability no longer says the base may be filed so.
      await createScopeRow(database.pool, { jobId: MISC, scope: "3.7", categoryCode: "3.7", sourceLabel: "Diesel car commute (pair retired)", reportLabel: "Diesel car commute (pair retired)",
        quantity: 10, unit: "miles", datasetId: DS, factorId: "uk-ghg-25_301_3071_9_1-c", factorVersion: DS_VERSION, factorLabel: "Employee commuting- land - Cars (by size) - Average car - Diesel", qualityTier: "measured" } as never, context());
      await retireFactorApplicability(database.pool, { userId: ACTOR, organisationId: ORG, role: "admin", capabilities: [{ capability: "factor.manage", scope: "all" }] } as unknown as StaffPrincipal,
        { organisationId: ORG, factorId: "uk-ghg-25_301_3071_9_1", suffixCode: "-c", reason: "Diesel commuting moved to its own factor." });
      await q(`INSERT INTO nzi_console.job_scope_rows (organisation_id,scope_row_id,job_id,scope,source_label,report_label,level_1,level_2,category_code,quantity,unit,dataset_id,factor_id,factor_version,factor_label,factor_source,reingested_from_row_id)
               VALUES ($1,'row-reingested',$2,'3.7','Rail commute (re-ingested)','Rail commute (re-ingested)','Scope 3','Commuting','3.7',5000,'passenger.km',$3,'uk-ghg-25_315_3147_11_1-c',$4,$5,'dataset','v7-rail')`,
        [ORG, REIN, DS, DS_VERSION, byId.get("uk-ghg-25_315_3147_11_1-c")!.label]);
    }
    await asWrittenBeforeStepA([OLD, NEW, MISC]);
    await q(`UPDATE nzi_console.job_scope_rows SET factor_label='Employee commuting - Average car - Petrol (2024 wording)' WHERE job_id=$1 AND source_label='Commute (older wording)'`, [MISC]);
    for (const job of [OLD, NEW]) {
      for (const row of (await rowsOf(job)).values()) await calculateScopeRow(database.pool, { jobId: job, rowId: row.scope_row_id, expectedVersion: row.version }, context());
      await q(`UPDATE nzi_console.job_scope_rows SET review_status='approved', reviewed_by=$2, reviewed_row_version=version, reviewed_at=now() WHERE job_id=$1 AND origin='live'`, [job, ACTOR]);
    }
    const frozenBefore = await snapshot(OLD);
    const frozenText = (await payloadOf(frozenBefore)).payload;
    const [rowsBefore, readsBefore] = [await rowsOf(NEW), await reads(NEW)];
    const reingestedBefore = (await q(`SELECT * FROM nzi_console.job_scope_rows WHERE scope_row_id='row-reingested'`))[0];

    const retirementEvents = async (action: string) => (await q(`SELECT 1 FROM nzi_console.audit_events WHERE organisation_id=$1 AND action=$2 AND actor_id='migration:0175'`, [ORG, action])).length;
    const eventsBefore = { factors: await retirementEvents("emission_factor.retired"), pairs: await retirementEvents("factor.applicability.retired") };
    await migrate();
    await migrate(RETIREMENT);

    const rowsAfter = await rowsOf(NEW);
    for (const entry of ENTRIES) {
      const was = rowsBefore.get(entry.key)!, now = rowsAfter.get(entry.key)!;
      if (entry.refiled) {
        assert.deepEqual([now.factor_id, now.filed_suffix_code], entry.refiled, `${entry.key}: re-filed onto its base under the pair`);
        assert.equal(now.factor_label, byId.get(entry.factorId)!.label, `${entry.key}: the pair's factor label — the variant identity's own, as it printed`);
        assert.deepEqual(now.provenance_json.filedUnder, { suffixCode: entry.refiled[1], by: "applicability" });
      } else {
        assert.deepEqual([now.factor_id, now.filed_suffix_code, now.factor_label], [was.factor_id, null, was.factor_label], `${entry.key}: left as it was`);
        assert.ok(!("filedUnder" in now.provenance_json));
      }
      assert.equal(now.calculated_tco2e, was.calculated_tco2e, `${entry.key}: priced identically`);
      assert.deepEqual([now.version, now.review_status, now.reviewed_row_version], [was.version, was.review_status, was.reviewed_row_version], `${entry.key}: version and review untouched`);
    }
    assert.deepEqual(await reads(NEW), readsBefore, "every line prints what it printed");
    assert.deepEqual((await q(`SELECT * FROM nzi_console.job_scope_rows WHERE scope_row_id='row-reingested'`))[0], reingestedBefore, "a re-ingested row is never edited in place");
    assert.deepEqual((await q<{ factor_id: string }>(`SELECT factor_id FROM nzi_console.job_scope_rows WHERE scope_row_id='v7-rail'`))[0]!.factor_id, "uk-ghg-25_315_3147_11_1-c", "v7 history is never read");
    const misc = await rowsOf(MISC);
    assert.deepEqual([misc.get("Commute (older wording)")!.factor_id, misc.get("Commute (older wording)")!.filed_suffix_code, misc.get("Commute (older wording)")!.factor_label],
      ["uk-ghg-25_301_3070_9_1", "-c", "Employee commuting- land - Cars (by size) - Average car - Petrol"], "re-filed with the pair's own factor label");
    assert.deepEqual([misc.get("Travel spend (base withdrawn)")!.factor_id, misc.get("Travel spend (base withdrawn)")!.filed_suffix_code],
      ["uk-ghg-SPEND-SIC-49.3-5-b", null], "a withdrawn base is nothing to re-file onto");
    assert.deepEqual([misc.get("Diesel car commute (pair retired)")!.factor_id, misc.get("Diesel car commute (pair retired)")!.filed_suffix_code],
      ["uk-ghg-25_301_3071_9_1-c", null], "a retired pair is nothing to re-file under");
    assert.equal((await payloadOf(frozenBefore)).payload, frozenText, "the report frozen before is untouched, byte for byte");

    // The report frozen after the migration is the one frozen before it.
    const before = (await payloadOf(frozenBefore)).json, now = (await payloadOf(await snapshot(NEW))).json;
    const strip = ({ rowId: _rowId, rowVersion: _rowVersion, ...rest }: Record<string, unknown>) => rest;
    const byKey = (payload: typeof before) => new Map(payload.measurements.map((measurement) => [measurement.sourceLabel as string, strip(measurement)]));
    const [b, n] = [byKey(before), byKey(now)];
    assert.deepEqual([...n.keys()].sort(), [...b.keys()].sort());
    for (const key of b.keys()) assert.deepEqual(n.get(key), b.get(key), `${key}: the frozen measurement`);
    const ordered = (payload: typeof before) => [...payload.measurements].sort((x, y) => String(x.sourceLabel).localeCompare(String(y.sourceLabel)));
    const totals = (payload: typeof before, key: "scope" | "scopeCode") => Object.fromEntries([...ordered(payload).reduce((sum, m) => sum.set(m[key] as string, (sum.get(m[key] as string) ?? 0) + Number(m.tco2e)), new Map<string, number>())].sort());
    assert.deepEqual(totals(now, "scope"), totals(before, "scope"));
    assert.deepEqual(totals(now, "scopeCode"), totals(before, "scopeCode"));
    const compose = (payload: typeof before) => {
      const measurements = ordered(payload).map(strip) as never;
      return { emissions: composeScopedEmissions(measurements, { kind: "whole" }, new Map()), audit: composeReportAudit({ measurements, provenance: payload.provenance as never, scope: { kind: "whole" } }) };
    };
    assert.deepEqual(compose(now), compose(before), "the composed emissions and audit are identical");

    // One audit event per re-filed row (both jobs, and the older-wording row), naming the variant it cited and what it carries now.
    const refiledCount = ENTRIES.filter((entry) => entry.refiled).length * 2 + 1;
    const events = await q<{ entity_id: string; principal_type: string; before_json: { factorId: string }; after_json: { factorId: string; filedSuffixCode: string } }>(
      `SELECT entity_id, principal_type, before_json, after_json FROM nzi_console.audit_events WHERE organisation_id=$1 AND action='scope_row.factor.refiled'`, [ORG]);
    assert.equal(events.length, refiledCount);
    const car = events.find((event) => event.entity_id === rowsAfter.get("Car commute")!.scope_row_id)!;
    assert.deepEqual([car.principal_type, car.before_json.factorId, car.after_json.factorId, car.after_json.filedSuffixCode],
      ["system", "uk-ghg-25_301_3070_9_1-c", "uk-ghg-25_301_3070_9_1", "-c"]);

    // 0175: exactly the covered variants nothing cites are retired; everything a row still cites, or that is not covered, stays.
    const active = new Map((await q<{ dataset_id: string; factor_id: string; active: boolean }>(
      `SELECT f.dataset_id, f.factor_id, f.active FROM nzi_console.emission_factors f CROSS JOIN LATERAL nzi_console.factor_id_parts(f.factor_id) p WHERE f.organisation_id=$1 AND p.suffix_code IS NOT NULL`, [ORG])).map((row) => [`${row.dataset_id}|${row.factor_id}`, row.active]));
    const retiredNow = [...active].filter(([, isActive]) => !isActive).map(([key]) => key).sort();
    assert.deepEqual(retiredNow, [`${DS}|uk-ghg-25_301_3070_9_1-c`],
      "retired: the one covered variant every row has moved off and nothing else cites — v7 history naming it is no citation");
    for (const [key, why] of [
      [`${DS}|uk-ghg-4_301_3070_4_1-bcp`, "the scope-shifted copy (and a row cites it)"],
      [`${DS}|uk-ghg-25_315_3147_11_1-c`, "a re-ingested row still cites it (J000663, ruled Option 2)"],
      [`${DS}|uk-ghg-SPEND-SIC-49.3-5-d`, "a row filed upstream still cites the -d copy"],
      [`${DS}|uk-ghg-25_301_3071_9_1-c`, "its pair is retired, so it is not covered — and a row cites it"],
      [`${DS_ALT}|uk-ghg-SPEND-SIC-49.3-5-b`, "its base is withdrawn, so it is not covered — and a row cites it"],
      [`${DS_ALT}|uk-ghg-SPEND-SIC-49.3-5-d`, "its base is withdrawn, so it is not covered (nothing cites it)"],
      [`${DS_ALT}|uk-ghg-4_301_3070_4_1-bcp`, "the scope-shifted copy — kept although nothing cites it"],
      [`${DS}|uk-ghg-25_301_3072_9_1-c`, "its pair is retired, so it is not covered (nothing cites it)"],
      [`${DS}|uk-ghg-27_320_3235_14_1-d`, "a register source cites it"],
      [`${DS}|uk-ghg-SPEND-SIC-49.3-5-b`, "an emission group cites it"],
      [`${DS}|uk-ghg-SPEND-SIC-49.3-5-u`, "a client alias names it"],
    ] as const) assert.equal(active.get(key), true, `kept active: ${why}`);
    const inert = (await q<{ status: string; retired_by: string | null }>(`SELECT status, retired_by FROM nzi_console.factor_identity_categories WHERE organisation_id=$1 AND factor_id='uk-ghg-4_301_3070_4_1' AND suffix_code='-bcp'`, [ORG]))[0]!;
    assert.deepEqual([inert.status, inert.retired_by], ["retired", "migration:0175"], "the inert Scope 1 / business-travel pair is retired");
    const live = (await q<{ status: string }>(`SELECT status FROM nzi_console.factor_identity_categories WHERE organisation_id=$1 AND factor_id='uk-ghg-25_301_3070_9_1' AND suffix_code='-c'`, [ORG]))[0]!;
    assert.equal(live.status, "active", "a pair its base can be filed under is untouched");
    assert.equal(await retirementEvents("emission_factor.retired") - eventsBefore.factors, 1, "one event per retired variant row");
    assert.equal(await retirementEvents("factor.applicability.retired") - eventsBefore.pairs, 1, "one event for the inert pair");
    // After E a row prices off the base (the variant is retired), and a retired variant id sent is still filed as its base.
    const older = (await rowsOf(MISC)).get("Commute (older wording)")!;
    await calculateScopeRow(database.pool, { jobId: MISC, rowId: older.scope_row_id, expectedVersion: older.version }, context());
    assert.equal(Number((await rowsOf(MISC)).get("Commute (older wording)")!.calculated_tco2e), Number((10 * 0.26187 / 1000).toFixed(12)), "priced off the base's own value");
    const sent = (await write(MISC, ENTRIES[0])).data.rowId;
    assert.deepEqual((await q<{ factor_id: string; filed_suffix_code: string }>(`SELECT factor_id, filed_suffix_code FROM nzi_console.job_scope_rows WHERE scope_row_id=$1`, [sent]))
      .map((row) => [row.factor_id, row.filed_suffix_code])[0], ["uk-ghg-25_301_3070_9_1", "-c"], "a retired variant id sent is filed as its base");

    // Re-running either changes nothing: no row left to re-file, no variant left to retire, no second event.
    const settled = await rowsOf(NEW);
    await migrate();
    await migrate(RETIREMENT);
    assert.deepEqual(await rowsOf(NEW), settled);
    assert.equal(await retirementEvents("emission_factor.retired") - eventsBefore.factors, 1, "no second event on a re-run");
    assert.equal((await q(`SELECT 1 FROM nzi_console.audit_events WHERE organisation_id=$1 AND action='scope_row.factor.refiled'`, [ORG])).length, refiledCount);
  });

  it("roll-forward's active-recheck: a prior row whose pair has since been retired carries neither the pair nor its label forward", async () => {
    const rail = ENTRIES[1];
    const prior = (await write(PRIOR, rail)).data.rowId;
    assert.deepEqual((await q<{ factor_id: string; filed_suffix_code: string }>(`SELECT factor_id, filed_suffix_code FROM nzi_console.job_scope_rows WHERE scope_row_id=$1`, [prior]))
      .map((row) => [row.factor_id, row.filed_suffix_code])[0], ["uk-ghg-25_315_3147_11_1", "-c"], "the prior row is filed under -c");
    const admin = { userId: ACTOR, organisationId: ORG, role: "admin", capabilities: [{ capability: "factor.manage", scope: "all" }] } as unknown as StaffPrincipal;
    await retireFactorApplicability(database.pool, admin, { organisationId: ORG, factorId: "uk-ghg-25_315_3147_11_1", suffixCode: "-c", reason: "Rail commuting moved to its own factor." });
    {
      const rolledId = (await rollforwardScopeRows(database.pool, { jobId: NEXT, priorJobId: PRIOR, rowIds: [prior] }, context())).data.createdRowIds[0]!;
      const rolled = (await q<{ factor_id: string; filed_suffix_code: string | null; factor_label: string; provenance_json: Record<string, unknown> }>(
        `SELECT factor_id, filed_suffix_code, factor_label, provenance_json FROM nzi_console.job_scope_rows WHERE scope_row_id=$1`, [rolledId]))[0]!;
      assert.deepEqual([rolled.factor_id, rolled.filed_suffix_code], ["uk-ghg-25_315_3147_11_1", null], "the retired pair is dropped, and nothing else is applicable here");
      assert.equal(rolled.factor_label, "Business travel- land - Rail - National rail", "the factor's own label — never the retired pair's");
      assert.ok(!("filedUnder" in rolled.provenance_json));
      await q(`DELETE FROM nzi_console.job_scope_rows WHERE scope_row_id=$1`, [rolledId]);
    }
  });
});
