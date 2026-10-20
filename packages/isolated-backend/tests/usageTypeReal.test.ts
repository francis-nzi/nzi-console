import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { commandGrantForRole, composeReportAudit, composeScopedEmissions, type CommandContext } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import {
  CommandValidationError, createEmissionSource, createReviewedCrpSnapshot, createScopeRow, rollforwardScopeRows,
  syncEmissionSourceToScope, updateScopeRow,
} from "../src/postgresCommands";

/**
 * Dedup slice 2 (migration 0171): a record's usage type — Car, Van, HGV… — governed, carried, and reported.
 *
 * Real Postgres, because the guarantees are the database's and the write path's: a CHECK and a foreign key on two tables, a
 * vocabulary seeded per organisation by a trigger, the spec field that asks for it, the commands that accept only a value of it,
 * and a snapshot that carries its label only when a row has one — so nothing that has no usage moves.
 */
const ORG = "org-usage", CLIENT = "client-usage", JOB = "job-usage", PRIOR = "job-usage-prior", ACTOR = "ada";
const CAR = "emission_usage_type:car", VAN = "emission_usage_type:van", HGV = "emission_usage_type:hgv";

describe("usage type on the record (0171)", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let keys = 0;
  const context = (): CommandContext => {
    keys += 1;
    return { organisationId: ORG, actorId: ACTOR, principal: "staff", idempotencyKey: `usage-${keys}`, correlationId: `corr-usage-${keys}`, grant: commandGrantForRole("admin", ORG, ACTOR) };
  };
  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => {
    const db = await database.admin();
    try { return (await db.query(sql, params)).rows as T[]; } finally { await db.end(); }
  };
  // Typed loosely: these build command inputs, and the command validates them.
  const entry = (over: Record<string, unknown> = {}): any => ({
    jobId: JOB, scope: "1", sourceLabel: "Diesel", reportLabel: "Diesel", categoryCode: null, siteId: "site-depot",
    quantity: 100, unit: "litres", datasetId: "ds-1", factorId: "f-diesel", factorVersion: "2025.1", factorLabel: "Diesel", qualityTier: "measured", ...over,
  });
  const usageOf = async (rowId: string) => (await q<{ usage_type_id: string | null }>(`SELECT usage_type_id FROM nzi_console.job_scope_rows WHERE scope_row_id=$1`, [rowId]))[0]!.usage_type_id;
  const versionOf = async (rowId: string) => (await q<{ version: number }>(`SELECT version FROM nzi_console.job_scope_rows WHERE scope_row_id=$1`, [rowId]))[0]!.version;
  const refused = (code: string) => (error: unknown) => error instanceof CommandValidationError && error.issues.some((issue) => issue.field === "usageTypeId" && issue.code === code);

  before(async () => {
    database = (await createDisposableDatabase("usagetype"))!;
    await q(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,$1)`, [ORG]);
    await q(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    await q(`INSERT INTO nzi_console.memberships (organisation_id,user_id,role_id,status,display_name) VALUES ($1,$2,'admin','active','Ada')`, [ORG, ACTOR]);
    await q(`INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,$2,'Usage Co','active')`, [ORG, CLIENT]);
    for (const [job, year, seq] of [[PRIOR, 2024, 1], [JOB, 2025, 2]] as const) {
      await q(`INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage,reporting_year,reporting_period_start,reporting_period_end)
               VALUES ($1,$2,$3,$4,'crp','CRP','open','Data entry',$5,$6,$7)`, [ORG, job, CLIENT, seq, year, `${year}-01-01`, `${year}-12-31`]);
      await q(`INSERT INTO nzi_console.job_emissions_config (organisation_id,job_id,reporting_from,reporting_to,country_code) VALUES ($1,$2,$3,$4,'GB')`, [ORG, job, `${year}-01-01`, `${year}-12-31`]);
    }
    await q(`INSERT INTO nzi_console.emission_factor_datasets (organisation_id,dataset_id,name,version,valid_from,valid_to,country_code,status,source_name,licence)
             VALUES ($1,'ds-1','Synthetic GB factors','2025.1','2024-01-01','2025-12-31','GB','active','Synthetic','OGL')`, [ORG]);
    await q(`INSERT INTO nzi_console.emission_factors (organisation_id,dataset_id,factor_id,label,activity_unit,kgco2e_per_unit,scopes) VALUES ($1,'ds-1','f-diesel','Diesel','litres',2.5,ARRAY['1','3'])`, [ORG]);
    for (const job of [PRIOR, JOB]) {
      await q(`INSERT INTO nzi_console.job_dataset_selections (organisation_id,job_id,dataset_id,selection_source,reason,selected_by) VALUES ($1,$2,'ds-1','automatic','Fixture',$3)`, [ORG, job, ACTOR]);
    }
    for (const [site, name] of [["site-depot", "Depot"], ["site-office", "Office"]]) {
      await q(`INSERT INTO nzi_console.client_sites (organisation_id,client_id,site_id,name,created_by) VALUES ($1,$2,$3,$4,'seed')`, [ORG, CLIENT, site, name]);
    }
  });
  after(async () => { await database?.end(); });

  // ── The vocabulary and the columns ──────────────────────────────────────────────────────────────────────────

  it("seeds the usage vocabulary for every organisation, a new one included, as a curated lookup", async () => {
    const values = await q<{ value_id: string; label: string; active: boolean }>(
      `SELECT value_id, label, active FROM nzi_console.reference_values WHERE organisation_id=$1 AND category_key='emission_usage_type' ORDER BY sort_order`, [ORG]);
    assert.deepEqual(values.map((value) => `${value.value_id}=${value.label}`),
      [`${CAR}=Car`, `${VAN}=Van`, `${HGV}=HGV`, "emission_usage_type:motorcycle=Motorcycle", "emission_usage_type:generator=Generator"]);
    assert.ok(values.every((value) => value.active));
    const category = (await q<{ scope: string }>(`SELECT scope FROM nzi_console.reference_categories WHERE category_key='emission_usage_type'`))[0];
    assert.equal(category?.scope, "organisation");
  });

  it("puts a nullable usage_type_id on scope rows and register sources, held to the vocabulary for every writer", async () => {
    for (const table of ["job_scope_rows", "job_emission_sources"]) {
      const column = (await q<{ is_nullable: string }>(`SELECT is_nullable FROM information_schema.columns WHERE table_schema='nzi_console' AND table_name=$1 AND column_name='usage_type_id'`, [table]))[0];
      assert.equal(column?.is_nullable, "YES", `${table}: optional`);
    }
    const rowId = (await createScopeRow(database.pool, entry(), context())).data.rowId;
    // Even the owner cannot name another category's value, or one that does not exist.
    await assert.rejects(q(`UPDATE nzi_console.job_scope_rows SET usage_type_id='activity_types:fieldwork' WHERE scope_row_id=$1`, [rowId]), /job_scope_rows_usage_type_vocabulary/);
    await assert.rejects(q(`UPDATE nzi_console.job_scope_rows SET usage_type_id='emission_usage_type:tractor' WHERE scope_row_id=$1`, [rowId]), /job_scope_rows_usage_type_fk/);
    await assert.rejects(q(`UPDATE nzi_console.job_emission_sources SET usage_type_id='industries:x' WHERE organisation_id=$1`, [ORG]).then(async () => {
      // No source exists yet, so the update touched nothing — prove the CHECK on an inserted one instead.
      await q(`INSERT INTO nzi_console.job_emission_sources (organisation_id,source_id,job_id,scope,source_type,source_name,data_source,usage_type_id) VALUES ($1,'src-bad',$2,'1','vehicle','Bad','Test','industries:x')`, [ORG, JOB]);
    }), /job_emission_sources_usage_type_vocabulary/);
  });

  it("asks for it in the governed input spec: three categories, the consultant's form only, optional, not under lean capture", async () => {
    const fields = await q<{ category_code: string; control: string; optional: boolean; when_audiences: string[]; when_lean: boolean }>(
      `SELECT category_code, control, optional, when_audiences, when_lean FROM nzi_console.input_spec_fields WHERE field_key='usageType' AND active ORDER BY category_code`);
    // Not Other Stationary Fuels: NZC-168 holds it to Natural Gas's form, field for field.
    assert.deepEqual(fields.map((field) => field.category_code), ["1.company-vehicles", "3.6", "3.7"]);
    assert.ok(fields.every((field) => field.control === "select" && field.optional === true && field.when_lean === false && JSON.stringify(field.when_audiences) === "[\"crm\"]"));
  });

  // ── The commands ─────────────────────────────────────────────────────────────────────────────────────────────

  it("a scope row is created with a usage type; an unknown or withdrawn one is refused", async () => {
    const rowId = (await createScopeRow(database.pool, entry({ usageTypeId: VAN }), context())).data.rowId;
    assert.equal(await usageOf(rowId), VAN);
    await assert.rejects(createScopeRow(database.pool, entry({ usageTypeId: "emission_usage_type:tractor" }), context()), refused("NOT_FOUND"));
    await assert.rejects(createScopeRow(database.pool, entry({ usageTypeId: "Van" }), context()), refused("INVALID"), "free text is not a usage type");
    await q(`UPDATE nzi_console.reference_values SET active=false WHERE organisation_id=$1 AND value_id='emission_usage_type:motorcycle'`, [ORG]);
    await assert.rejects(createScopeRow(database.pool, entry({ usageTypeId: "emission_usage_type:motorcycle" }), context()), refused("INACTIVE"));
  });

  it("an update keeps the usage when the field is absent, clears it on null, and keeps a held value that was later withdrawn", async () => {
    const rowId = (await createScopeRow(database.pool, entry({ usageTypeId: CAR }), context())).data.rowId;
    const update = async (over: Record<string, unknown>) =>
      updateScopeRow(database.pool, { ...entry(), rowId, expectedVersion: await versionOf(rowId), enabled: true, ...over }, context());
    await update({ quantity: 120 });
    assert.equal(await usageOf(rowId), CAR, "a caller that does not know the field never clears it");
    await q(`UPDATE nzi_console.reference_values SET active=false WHERE organisation_id=$1 AND value_id=$2`, [ORG, CAR]);
    await update({ usageTypeId: CAR, quantity: 130 });
    assert.equal(await usageOf(rowId), CAR, "a value the row already holds stays valid after it is withdrawn");
    await q(`UPDATE nzi_console.reference_values SET active=true WHERE organisation_id=$1 AND value_id=$2`, [ORG, CAR]);
    await update({ usageTypeId: null });
    assert.equal(await usageOf(rowId), null);
  });

  it("a register source carries it, and its sync copies it to the scope row; a spend line has none", async () => {
    const base: any = {
      jobId: JOB, groupId: null, scope: "1", sourceType: "vehicle", sourceSubtype: null, siteId: "site-depot", sourceName: "Fleet HGV",
      assetIdentifier: null, purchasedGoodsCategoryId: null, datasetId: "ds-1", factorId: "f-diesel", factorSource: "dataset", clientFactorId: null,
      quantity: 400, unit: "litres", applyPct: 100, dataSource: "Fuel card", dataConfidence: null, monthlyActivity: [],
      detail: { kind: "vehicle", vehicleRegistration: null, make: null, model: null, fuel: "Diesel" }, notes: null, usageTypeId: HGV,
    };
    const sourceId = (await createEmissionSource(database.pool, base, context())).data.sourceId;
    const synced = await syncEmissionSourceToScope(database.pool, { jobId: JOB, sourceId }, context());
    assert.equal(await usageOf(synced.data.rowId), HGV);
    await assert.rejects(createEmissionSource(database.pool, { ...base, sourceType: "spend", detail: { kind: "spend" }, purchasedGoodsCategoryId: "pg-1" }, context()), refused("INVALID"));
  });

  it("roll-forward carries the prior usage while it is still offered, and drops a withdrawn one", async () => {
    const prior = async (usageTypeId: string) => (await createScopeRow(database.pool, entry({ jobId: PRIOR, usageTypeId, sourceLabel: `Prior ${usageTypeId}`, reportLabel: `Prior ${usageTypeId}` }), context())).data.rowId;
    const offered = await prior(VAN), withdrawn = await prior(HGV);
    await q(`UPDATE nzi_console.reference_values SET active=false WHERE organisation_id=$1 AND value_id=$2`, [ORG, HGV]);
    const rolled = await rollforwardScopeRows(database.pool, { jobId: JOB, priorJobId: PRIOR, rowIds: [offered, withdrawn] }, context());
    const created = await q<{ rolled_forward_from_row_id: string; usage_type_id: string | null }>(
      `SELECT rolled_forward_from_row_id, usage_type_id FROM nzi_console.job_scope_rows WHERE scope_row_id = ANY($1::text[])`, [rolled.data.createdRowIds]);
    const by = new Map(created.map((row) => [row.rolled_forward_from_row_id, row.usage_type_id]));
    assert.equal(by.get(offered), VAN);
    assert.equal(by.get(withdrawn), null, "a rolled-forward row is a new row, so it may not newly cite a withdrawn usage type");
    await q(`UPDATE nzi_console.reference_values SET active=true WHERE organisation_id=$1 AND value_id=$2`, [ORG, HGV]);
  });

  // ── The snapshot and the report ──────────────────────────────────────────────────────────────────────────────

  it("one diesel factor, three usages: the snapshot carries each usage label, and the report draws three labelled lines that sum to one", async () => {
    // A fresh job of approved, calculated rows: three diesel rows at the depot (Car / Van / HGV), one with no usage at the office.
    const SNAP_JOB = "job-usage-snap";
    await q(`INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage,reporting_year,reporting_period_start,reporting_period_end)
             VALUES ($1,$2,$3,3,'crp','CRP','open','Review & QA',2025,'2025-01-01','2025-12-31')`, [ORG, SNAP_JOB, CLIENT]);
    await q(`INSERT INTO nzi_console.job_emissions_config (organisation_id,job_id,reporting_from,reporting_to,country_code) VALUES ($1,$2,'2025-01-01','2025-12-31','GB')`, [ORG, SNAP_JOB]);
    await q(`INSERT INTO nzi_console.job_dataset_selections (organisation_id,job_id,dataset_id,selection_source,reason,selected_by) VALUES ($1,$2,'ds-1','automatic','Fixture',$3)`, [ORG, SNAP_JOB, ACTOR]);
    const rows: Array<[string, string, number, string | null]> = [["r-car", "site-depot", 2.5, CAR], ["r-van", "site-depot", 5, VAN], ["r-hgv", "site-depot", 10, HGV], ["r-none", "site-office", 1.25, null]];
    for (const [id, site, tco2e, usage] of rows) {
      await q(`INSERT INTO nzi_console.job_scope_rows
                 (organisation_id,scope_row_id,job_id,scope,source_label,report_label,level_1,level_2,quantity,unit,calculated_tco2e,quality_tier,review_status,reviewed_by,
                  reviewed_row_version,reviewed_at,dataset_id,factor_id,factor_label,factor_version,enabled,version,site_id,usage_type_id)
               VALUES ($1,$2,$3,'1','Diesel','Diesel','Scope 1','Direct',1000,'litres',$4,'measured','approved',$5,1,now(),'ds-1','f-diesel','Diesel','2025.1',true,1,$6,$7)`,
        [ORG, id, SNAP_JOB, tco2e, ACTOR, site, usage]);
    }
    const created = await createReviewedCrpSnapshot(database.pool, { jobId: SNAP_JOB, expectedJobVersion: 1 }, context());
    const payload = (await q<{ payload_json: { measurements: Array<Record<string, unknown>> } }>(
      `SELECT payload_json FROM nzi_console.reviewed_crp_snapshots WHERE snapshot_id=$1`, [created.data.snapshotId]))[0]!.payload_json;
    const byRow = new Map(payload.measurements.map((measurement) => [measurement.rowId as string, measurement]));
    assert.deepEqual(["r-car", "r-van", "r-hgv"].map((id) => byRow.get(id)!.usageLabel), ["Car", "Van", "HGV"]);
    assert.ok(!("usageLabel" in byRow.get("r-none")!), "a row with no usage carries no field at all — its serialisation, and so the evidence hash, is unchanged");

    const measurements = payload.measurements as unknown as Parameters<typeof composeScopedEmissions>[0];
    const scoped = composeScopedEmissions(measurements, { kind: "whole" }, new Map([["site-depot", "Depot"], ["site-office", "Office"]]));
    const depot = scoped.sites.find((site) => site.siteId === "site-depot")!;
    assert.deepEqual(depot.activities.map((activity) => [activity.label, activity.tco2e]), [["Diesel — HGV", 10], ["Diesel — Van", 5], ["Diesel — Car", 2.5]]);
    assert.equal(depot.activities.reduce((sum, activity) => sum + activity.tco2e, 0), 17.5, "the three lines sum to what one combined line would");
    const office = scoped.sites.find((site) => site.siteId === "site-office")!;
    assert.deepEqual(office.activities.map((activity) => activity.label), ["Diesel"], "no usage: one line, labelled as today");

    const audit = composeReportAudit({ measurements: measurements as never, scope: { kind: "whole" } });
    assert.deepEqual(audit.rows.map((row) => row.activity).sort(), ["Diesel", "Diesel — Car", "Diesel — HGV", "Diesel — Van"]);
    assert.equal(audit.totalTco2e, 18.75);
  });
});
