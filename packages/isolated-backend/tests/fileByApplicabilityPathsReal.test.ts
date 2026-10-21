import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { commandGrantForRole, composeReportAudit, composeScopedEmissions, roleCapabilityGrants, V7_REINGEST_ACTOR, type CommandContext } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import {
  calculateScopeRow, createReviewedCrpSnapshot, createScopeRow, createScopeRowInTransaction, recalculateScopeRowInTransaction, rollforwardScopeRows,
  runPostgresCommandInTransaction, syncEmissionSourceGroupToScope, syncEmissionSourceToScope,
} from "../src/postgresCommands";
import { setPortalDataEntryBucketGrant } from "../src/portalDataEntry";
import { createPortalDataEntryRecord, decidePortalDataEntryReview, submitPortalDataEntryRecord } from "../src/portalDataEntryRecords";
import { previewDeclaredFactor } from "../src/declarativeResolution";
import { listScopeRows } from "../src/readModels";
import { withTenantRead, withTenantWrite } from "../src/postgres";
import type { PortalPrincipal, StaffPrincipal } from "../src/index";

/**
 * Dedup slice 5, Step A (REPORT_FACTOR_APPLICABILITY): every write path files by applicability — a create, the v7 re-ingest, register
 * sync, portal acceptance, the group roll-up and roll-forward. Each is handed J000663's **variant ids**, as it is today; with the flag on
 * each writes the base filed under the pair instead, so once the variants retire nothing new cites one.
 *
 * **The gate**: the same inputs, through the same paths, written flag off into one job and flag on into another, price, label, freeze and
 * compose byte-identically. A scope-shifted `-bcp` copy is never folded, on any path. Seeded between 0169 and 0170, so 0170's
 * applicability backfill and 0172's label relocation run on it as they ran on the library (slice 3's shapes).
 */
const ORG = "org-s5a", CLIENT = "client-s5a", ACTOR = "ada", PORTAL_USER = "portal-s5a";
const OLD = "job-s5a-old", NEW = "job-s5a-new", PRIOR = "job-s5a-prior", ROLL_OLD = "job-s5a-roll-old", ROLL_NEW = "job-s5a-roll-new", REIN_OLD = "job-s5a-rein-old", REIN_NEW = "job-s5a-rein-new";
const DS = "gb-2025", DS_VERSION = "2025.1";

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
  // The scope-shifted copy (staging's 8 -bcp rows): a Scope 3 business-travel copy of a Scope 1 company car. Never folded.
  F("uk-ghg-4_301_3070_4_1", "km", 0.16272, ["1"], "Passenger vehicles - Large car - Diesel", "Company Vehicles: Large Car Diesel"),
  F("uk-ghg-4_301_3070_4_1-bcp", "km", 0.16272, ["3"], "Business travel - Large car - Diesel", "Business Travel: Large Car Diesel"),
];
const byId = new Map(FACTORS.map((factor) => [factor.id, factor]));

/** Each path's J000663 entry: the variant id it is handed, the base it files as with the flag on (null: never folded). */
const PATHS = {
  create: { key: "Car commute (create)", scope: "3.7", variant: "uk-ghg-25_301_3070_9_1-c", base: "uk-ghg-25_301_3070_9_1", suffix: "-c", quantity: 1200 },
  reingest: { key: "Rail commute (re-ingest)", scope: "3.7", variant: "uk-ghg-25_315_3147_11_1-c", base: "uk-ghg-25_315_3147_11_1", suffix: "-c", quantity: 5000 },
  sync: { key: "Travel spend (sync)", scope: "3.6", variant: "uk-ghg-SPEND-SIC-49.3-5-b", base: "uk-ghg-SPEND-SIC-49.3-5", suffix: "-b", quantity: 10000 },
  syncShifted: { key: "Large car travel (sync)", scope: "3.6", variant: "uk-ghg-4_301_3070_4_1-bcp", base: null, suffix: null, quantity: 300 },
  portal: { key: "Outbound shipping (portal)", scope: "3.9", variant: "uk-ghg-27_320_3235_14_1-d", base: "uk-ghg-27_320_3235_14_1", suffix: "-d", quantity: 20000 },
  rollup: { key: "Inbound haulage (group)", scope: "3.4", variant: "uk-ghg-SPEND-SIC-49.3-5-u", base: "uk-ghg-SPEND-SIC-49.3-5", suffix: "-u", quantity: 8000 },
  rollforward: { key: "Outbound haulage (roll-forward)", scope: "3.9", variant: "uk-ghg-SPEND-SIC-49.3-5-d", base: "uk-ghg-SPEND-SIC-49.3-5", suffix: "-d", quantity: 6000 },
} as const;
type Path = typeof PATHS[keyof typeof PATHS];

describe("dedup slice 5 Step A: every write path files by applicability (REPORT_FACTOR_APPLICABILITY)", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let keys = 0;
  const context = (actorId = ACTOR, principal: "staff" | "system" = "staff", reason?: string): CommandContext => {
    keys += 1;
    return { organisationId: ORG, actorId, principal, idempotencyKey: `s5a-${keys}`, correlationId: `corr-s5a-${keys}`, grant: commandGrantForRole("admin", ORG, actorId), ...(reason ? { reason } : {}) };
  };
  const staff = { organisationId: ORG, userId: ACTOR, sessionId: "s", issuedAt: 1, expiresAt: 2, role: "admin", matrixVersion: 1, capabilities: roleCapabilityGrants("admin") } as StaffPrincipal;
  const portal = { principal: "portal", organisationId: ORG, userId: PORTAL_USER, clientId: CLIENT, sessionId: "p", issuedAt: 1, expiresAt: 2, displayName: "P", email: "p@example.invalid" } as unknown as PortalPrincipal;
  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => {
    const db = await database.admin();
    try { return (await db.query(sql, params)).rows as T[]; } finally { await db.end(); }
  };
  // Both states set explicitly: absent is on since slice 5 Step D, and "false" is the kill-switch (kept until Step E).
  const withFlag = async <T>(value: "true" | "false", work: () => Promise<T>): Promise<T> => {
    const saved = process.env.REPORT_FACTOR_APPLICABILITY;
    process.env.REPORT_FACTOR_APPLICABILITY = value;
    try { return await work(); } finally { if (saved === undefined) delete process.env.REPORT_FACTOR_APPLICABILITY; else process.env.REPORT_FACTOR_APPLICABILITY = saved; }
  };
  type Stored = { scope_row_id: string; factor_id: string | null; filed_suffix_code: string | null; factor_label: string | null; calculated_tco2e: string | null; provenance_json: Record<string, unknown>; version: number };
  const rowOf = async (jobId: string, sourceLabel: string) => (await q<Stored>(
    `SELECT scope_row_id, factor_id, filed_suffix_code, factor_label, calculated_tco2e, provenance_json, version FROM nzi_console.job_scope_rows WHERE job_id=$1 AND source_label=$2 AND origin='live'`, [jobId, sourceLabel]))[0]!;
  const entry = (path: Path) => byId.get(path.variant)!;

  /** The v7 re-ingest's own write, into a job of its own: a job holding v7 history is never snapshotted (decision 12). */
  const writeReingest = async (jobId: string, tag: string) => {
    // v7's variant id, the declared pick exempt, as `reingestV7JobInTransaction` makes it, then calculated.
    const reingest = PATHS.reingest;
    await q(`INSERT INTO nzi_console.job_scope_rows (organisation_id,scope_row_id,job_id,scope,source_label,report_label,level_1,level_2,quantity,unit,calculated_tco2e,enabled,origin,migrated_record,source_system,legacy_db_id)
             VALUES ($1,$2,$3,'3.7','v7 rail','v7 rail','v7','v7',5000,'passenger.km',0.1773,false,'migrated',$4::jsonb,'nzi-pro-v7',$2)`,
      [ORG, `v7-${tag}`, jobId, JSON.stringify({ qty: 5000, uom: "passenger.km", factor: 0.03546, ghg_unit: "kgCO2e", original_id: "25_315_3147_11_1-c", reported_tco2e: 0.1773, data_source: "Company Data", enabled: true })]);
    const system = context(V7_REINGEST_ACTOR, "system", "v7 re-ingest (test)");
    await withTenantWrite(database.pool, ORG, async (db) => {
      const created = await createScopeRowInTransaction(db, { jobId, scope: reingest.scope, categoryCode: reingest.scope, sourceLabel: reingest.key, reportLabel: reingest.key, quantity: reingest.quantity,
        unit: entry(reingest).unit, datasetId: DS, factorId: reingest.variant, factorVersion: DS_VERSION, factorLabel: null, qualityTier: "measured", factorSource: "dataset", applyPct: 100 } as never,
        system, { reingestedFrom: `v7-${tag}`, historicalUnit: true, declaredResolutionExempt: true });
      const calc = { jobId, rowId: created.data.rowId, expectedVersion: created.data.version };
      await runPostgresCommandInTransaction(db, "scope.row.calculate", calc, { ...system, idempotencyKey: `${system.idempotencyKey}:calc` },
        (inner) => recalculateScopeRowInTransaction(inner, calc, { ...system, idempotencyKey: `${system.idempotencyKey}:calc` }));
    });
  };

  /** Every other path, writing its entry into `jobId` — the same inputs whatever the flag. */
  const writeAll = async (jobId: string, tag: string) => {
    // A create, as the CRM writes it.
    const create = PATHS.create;
    await createScopeRow(database.pool, { jobId, scope: create.scope, categoryCode: create.scope, sourceLabel: create.key, reportLabel: create.key, quantity: create.quantity,
      unit: entry(create).unit, datasetId: DS, factorId: create.variant, factorVersion: DS_VERSION, factorLabel: entry(create).label, qualityTier: "measured" } as never, context());
    // Register sync: the register holds the variant id.
    for (const [path, type] of [[PATHS.sync, "travel"], [PATHS.syncShifted, "travel"]] as const) {
      const sourceId = `src-${tag}-${path.variant}`;
      await q(`INSERT INTO nzi_console.job_emission_sources (organisation_id,source_id,job_id,scope,source_type,source_name,dataset_id,factor_id,factor_source,quantity,unit,data_source)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'dataset',$9,$10,'Test')`, [ORG, sourceId, jobId, path.scope, type, path.key, DS, path.variant, path.quantity, entry(path).unit]);
      await syncEmissionSourceToScope(database.pool, { jobId, sourceId }, context());
    }
    // Portal acceptance: the client picks the variant on a row granted to them.
    const portalPath = PATHS.portal;
    const portalRow = `row-${tag}-portal`;
    await q(`INSERT INTO nzi_console.job_scope_rows (organisation_id,scope_row_id,job_id,scope,source_label,report_label,level_1,level_2,category_code) VALUES ($1,$2,$3,'3.9',$4,$4,'Scope 3','Downstream transport',$5)`,
      [ORG, portalRow, jobId, portalPath.key, portalPath.scope]);
    const bucket = (await setPortalDataEntryBucketGrant(database.pool, staff, { portalUserId: PORTAL_USER, jobId, scopeRowId: portalRow, entryKind: "manual_activity", factorIds: [portalPath.variant], siteIds: [] })).bucketGrantId;
    const saved = await createPortalDataEntryRecord(database.pool, portal, jobId, { bucketGrantId: bucket, quantity: portalPath.quantity, unit: entry(portalPath).unit, factorId: portalPath.variant, siteId: null, note: "" });
    const submitted = await submitPortalDataEntryRecord(database.pool, portal, jobId, saved.recordId, saved.version);
    await decidePortalDataEntryReview(database.pool, staff, { queueId: submitted.queueId, expectedSubmittedVersion: submitted.version, decision: "accept", note: "" });
    // The group roll-up: the group's factor is the variant.
    const rollup = PATHS.rollup, groupId = `grp-${tag}`;
    await q(`INSERT INTO nzi_console.job_emission_groups (organisation_id,group_id,job_id,name,dataset_id,factor_id,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [ORG, groupId, jobId, rollup.key, DS, rollup.variant, ACTOR]);
    for (const [index, share] of [[1, 5000], [2, 3000]] as const) {
      await q(`INSERT INTO nzi_console.job_emission_sources (organisation_id,source_id,job_id,group_id,scope,source_type,source_name,dataset_id,factor_id,factor_source,quantity,unit,data_source)
               VALUES ($1,$2,$3,$4,'3.4','spend',$5,$6,$7,'dataset',$8,'GBP','Test')`, [ORG, `src-${tag}-g${index}`, jobId, groupId, `Haulier ${index}`, DS, rollup.variant, share]);
    }
    await syncEmissionSourceGroupToScope(database.pool, { jobId, groupId }, context());
  };

  before(async () => {
    database = (await createDisposableDatabase("s5afiling", {
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
    await q(`INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,$2,'Slice Five Co','active')`, [ORG, CLIENT]);
    for (const [job, seq, year] of [[PRIOR, 1, 2024], [OLD, 2, 2025], [NEW, 3, 2025], [ROLL_OLD, 4, 2025], [ROLL_NEW, 5, 2025], [REIN_OLD, 6, 2025], [REIN_NEW, 7, 2025]] as const) {
      await q(`INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage,reporting_year,reporting_period_start,reporting_period_end)
               VALUES ($1,$2,$3,$4,'crp','CRP','open','Data entry',$5,$6,$7)`, [ORG, job, CLIENT, seq, year, `${year}-01-01`, `${year}-12-31`]);
      await q(`INSERT INTO nzi_console.job_emissions_config (organisation_id,job_id,reporting_from,reporting_to,country_code) VALUES ($1,$2,$3,$4,'GB')`, [ORG, job, `${year}-01-01`, `${year}-12-31`]);
      await q(`INSERT INTO nzi_console.job_dataset_selections (organisation_id,job_id,dataset_id,selection_source,reason,selected_by) VALUES ($1,$2,$3,'automatic','Fixture',$4)`, [ORG, job, DS, ACTOR]);
    }
    await q(`INSERT INTO nzi_console.portal_users (organisation_id,portal_user_id,client_id,status) VALUES ($1,$2,$3,'active')`, [ORG, PORTAL_USER, CLIENT]);
    for (const job of [OLD, NEW]) {
      await q(`INSERT INTO nzi_console.portal_access_grants (organisation_id,grant_id,client_id,portal_user_id,job_id,data_entry_starts_at,data_entry_expires_at)
               VALUES ($1,$2,$3,$4,$5,now() - interval '1 day', now() + interval '30 days')`, [ORG, `grant-${job}`, CLIENT, PORTAL_USER, job]);
    }
  });
  after(async () => { await database?.end(); });

  it("J000663 through every path: flag off writes the variant ids as today; flag on files the bases — and both price, label, freeze and compose identically", async () => {
    await withFlag("false", () => writeAll(OLD, "old"));
    await withFlag("true", () => writeAll(NEW, "new"));
    const paths = Object.values(PATHS).filter((path) => path !== PATHS.rollforward && path !== PATHS.reingest);

    for (const job of [OLD, NEW]) {
      for (const path of paths) {
        const stored = await rowOf(job, path.key);
        if (stored.calculated_tco2e === null) await calculateScopeRow(database.pool, { jobId: job, rowId: stored.scope_row_id, expectedVersion: stored.version }, context());
      }
      // Approved as a reviewer would, setting the tier a synced, accepted or rolled-up row arrives without — on both jobs alike.
      await q(`UPDATE nzi_console.job_scope_rows SET review_status='approved', quality_tier=coalesce(quality_tier,'measured'), reviewed_by=$2, reviewed_row_version=version, reviewed_at=now() WHERE job_id=$1 AND origin='live'`, [job, ACTOR]);
    }
    for (const path of paths) {
      const before = await rowOf(OLD, path.key), now = await rowOf(NEW, path.key);
      assert.deepEqual([before.factor_id, before.filed_suffix_code], [path.variant, null], `${path.key}: flag off, the variant id exactly as today`);
      assert.ok(!("filedUnder" in before.provenance_json), `${path.key}: flag off adds no provenance key`);
      if (path.base) {
        assert.deepEqual([now.factor_id, now.filed_suffix_code], [path.base, path.suffix], `${path.key}: flag on, the base filed under the pair`);
        assert.deepEqual(now.provenance_json.filedUnder, { suffixCode: path.suffix, by: "applicability" }, `${path.key}: provenance records the filing`);
      } else {
        assert.deepEqual([now.factor_id, now.filed_suffix_code], [path.variant, null], `${path.key}: a scope-shifted copy is never folded`);
      }
      assert.equal(now.calculated_tco2e, before.calculated_tco2e, `${path.key}: priced identically`);
      assert.equal(now.factor_label, before.factor_label, `${path.key}: the factor label the audit names`);
    }
    const reads = async (jobId: string) => new Map((await withTenantRead(database.pool, ORG, (db) => listScopeRows(db, jobId))).filter((row) => paths.some((path) => path.key === row.sourceLabel)).map((row) => [row.sourceLabel, row.reportLabel]));
    assert.deepEqual(await reads(NEW), await reads(OLD), "the scope-row read model's labels");
    assert.equal((await reads(NEW)).get(PATHS.create.key), "Employee Commuting: Average Car Petrol", "commuting reads as commuting, never the business-travel base");

    const snapshot = async (jobId: string) => {
      const version = (await q<{ version: number }>(`SELECT version FROM nzi_console.jobs WHERE job_id=$1`, [jobId]))[0]!.version;
      const created = await createReviewedCrpSnapshot(database.pool, { jobId, expectedJobVersion: version }, context());
      return (await q<{ payload_json: { measurements: Array<Record<string, unknown>>; provenance: unknown } }>(`SELECT payload_json FROM nzi_console.reviewed_crp_snapshots WHERE snapshot_id=$1`, [created.data.snapshotId]))[0]!.payload_json;
    };
    const before = await snapshot(OLD), now = await snapshot(NEW);
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
  });

  it("the v7 re-ingest: v7's variant id written as today flag off, and as its base filed under the pair flag on — priced and labelled identically", async () => {
    await withFlag("false", () => writeReingest(REIN_OLD, "old"));
    await withFlag("true", () => writeReingest(REIN_NEW, "new"));
    const path = PATHS.reingest;
    const [before, now] = [await rowOf(REIN_OLD, path.key), await rowOf(REIN_NEW, path.key)];
    assert.deepEqual([before.factor_id, before.filed_suffix_code], [path.variant, null], "flag off: v7's own variant id");
    assert.deepEqual([now.factor_id, now.filed_suffix_code], [path.base, path.suffix], "flag on: the base, filed");
    assert.ok(before.calculated_tco2e !== null && now.calculated_tco2e === before.calculated_tco2e, "priced identically, by the re-ingest's own calculation");
    assert.equal(now.factor_label, before.factor_label);
    assert.deepEqual(now.provenance_json.filedUnder, { suffixCode: path.suffix, by: "applicability" });
    const label = async (jobId: string) => (await withTenantRead(database.pool, ORG, (db) => listScopeRows(db, jobId))).find((row) => row.sourceLabel === path.key)!.reportLabel;
    assert.equal(await label(REIN_NEW), await label(REIN_OLD));
    assert.equal(await label(REIN_NEW), "Employee Commuting: Rail National Rail");
  });

  it("roll-forward: a prior row on a variant id rolls forward as today flag off, and as its base filed under the pair flag on", async () => {
    const path = PATHS.rollforward;
    const prior = await withFlag("false", async () => (await createScopeRow(database.pool, { jobId: PRIOR, scope: path.scope, categoryCode: path.scope, sourceLabel: path.key, reportLabel: path.key,
      quantity: path.quantity, unit: entry(path).unit, datasetId: DS, factorId: path.variant, factorVersion: DS_VERSION, factorLabel: entry(path).label, qualityTier: "spend-based" } as never, context())).data.rowId);
    const rolled = {
      old: (await withFlag("false", () => rollforwardScopeRows(database.pool, { jobId: ROLL_OLD, priorJobId: PRIOR, rowIds: [prior] }, context()))).data.createdRowIds[0]!,
      new: (await withFlag("true", () => rollforwardScopeRows(database.pool, { jobId: ROLL_NEW, priorJobId: PRIOR, rowIds: [prior] }, context()))).data.createdRowIds[0]!,
    };
    const [before, now] = [await rowOf(ROLL_OLD, path.key), await rowOf(ROLL_NEW, path.key)];
    assert.deepEqual([before.scope_row_id, before.factor_id, before.filed_suffix_code], [rolled.old, path.variant, null], "flag off: today's roll-forward");
    assert.deepEqual([now.scope_row_id, now.factor_id, now.filed_suffix_code], [rolled.new, path.base, path.suffix], "flag on: the base, filed");
    assert.equal(now.factor_label, before.factor_label);
    assert.deepEqual(now.provenance_json.filedUnder, { suffixCode: path.suffix, by: "applicability" });
    const label = async (jobId: string) => (await withTenantRead(database.pool, ORG, (db) => listScopeRows(db, jobId))).find((row) => row.sourceLabel === path.key)!.reportLabel;
    assert.equal(await label(ROLL_NEW), await label(ROLL_OLD));
  });

  it("portal acceptance always writes the row's suffix: a row once filed, accepting a factor it doesn't file under, keeps no stale pair", async () => {
    const rowId = (await rowOf(NEW, PATHS.portal.key)).scope_row_id;
    assert.equal((await rowOf(NEW, PATHS.portal.key)).filed_suffix_code, "-d");
    // The container ship used natively under a category its pair isn't for (3.4, upstream) — the row now carries a base it doesn't file.
    await q(`UPDATE nzi_console.job_scope_rows SET category_code='3.4', scope='3.4' WHERE scope_row_id=$1`, [rowId]);
    const bucket = (await setPortalDataEntryBucketGrant(database.pool, staff, { portalUserId: PORTAL_USER, jobId: NEW, scopeRowId: rowId, entryKind: "manual_activity", factorIds: [PATHS.portal.base!], siteIds: [] })).bucketGrantId;
    const saved = await createPortalDataEntryRecord(database.pool, portal, NEW, { bucketGrantId: bucket, quantity: 100, unit: "tonne.km", factorId: PATHS.portal.base!, siteId: null, note: "" });
    const submitted = await submitPortalDataEntryRecord(database.pool, portal, NEW, saved.recordId, saved.version);
    await withFlag("true", () => decidePortalDataEntryReview(database.pool, staff, { queueId: submitted.queueId, expectedSubmittedVersion: submitted.version, decision: "accept", note: "" }));
    const stored = (await q<{ factor_id: string; filed_suffix_code: string | null }>(`SELECT factor_id, filed_suffix_code FROM nzi_console.job_scope_rows WHERE scope_row_id=$1`, [rowId]))[0]!;
    assert.deepEqual([stored.factor_id, stored.filed_suffix_code], [PATHS.portal.base, null], "upstream: the base natively, its old -d pair cleared");
  });

  it("a folded edition (bases only, as slice 4 imports it): a variant id files as its base with the pair's labels; flag off it is refused as today", async () => {
    // 2026: the bases alone — no category copy, as a folded import leaves it. The pairs are per factor, so they already apply.
    const FOLDED = "gb-2026", FOLD_JOB = "job-s5a-folded";
    await q(`INSERT INTO nzi_console.emission_factor_datasets (organisation_id,dataset_id,name,version,valid_from,valid_to,country_code,status,source_name,licence)
             VALUES ($1,$2,'DESNZ GB 2026','2026.1','2026-01-01','2026-12-31','GB','active','DESNZ','OGL')`, [ORG, FOLDED]);
    for (const factor of FACTORS.filter((entry) => !/-(c|b|u|d|bcp)$/.test(entry.id))) {
      await q(`INSERT INTO nzi_console.emission_factors (organisation_id,dataset_id,factor_id,label,activity_unit,kgco2e_per_unit,scopes) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [ORG, FOLDED, factor.id, factor.label, factor.unit, factor.value, factor.scopes]);
    }
    await q(`INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage,reporting_year,reporting_period_start,reporting_period_end)
             VALUES ($1,$2,$3,8,'crp','CRP','open','Data entry',2026,'2026-01-01','2026-12-31')`, [ORG, FOLD_JOB, CLIENT]);
    await q(`INSERT INTO nzi_console.job_emissions_config (organisation_id,job_id,reporting_from,reporting_to,country_code) VALUES ($1,$2,'2026-01-01','2026-12-31','GB')`, [ORG, FOLD_JOB]);
    await q(`INSERT INTO nzi_console.job_dataset_selections (organisation_id,job_id,dataset_id,selection_source,reason,selected_by) VALUES ($1,$2,$3,'automatic','Fixture',$4)`, [ORG, FOLD_JOB, FOLDED, ACTOR]);
    const create = (factorId: string, scope: string, sourceLabel: string, unit: string) => createScopeRow(database.pool, { jobId: FOLD_JOB, scope, categoryCode: scope, sourceLabel, reportLabel: sourceLabel,
      quantity: 100, unit, datasetId: FOLDED, factorId, factorVersion: "2026.1", factorLabel: null, qualityTier: "measured" } as never, context());

    await withFlag("false", async () => {
      await assert.rejects(create("uk-ghg-25_301_3070_9_1-c", "3.7", "Commute (folded, flag off)", "miles"), /Command validation failed/, "flag off: the variant id is not in a folded edition — refused, as today");
    });
    await withFlag("true", async () => {
      const commute = (await create("uk-ghg-25_301_3070_9_1-c", "3.7", "Commute (folded)", "miles")).data.rowId;
      const stored = (await q<Stored>(`SELECT factor_id, filed_suffix_code, factor_label FROM nzi_console.job_scope_rows WHERE scope_row_id=$1`, [commute]))[0]!;
      assert.deepEqual([stored.factor_id, stored.filed_suffix_code, stored.factor_label], ["uk-ghg-25_301_3070_9_1", "-c", "Employee commuting- land - Cars (by size) - Average car - Petrol"],
        "the base, filed, with the pair's factor label — never the business-travel base's");
      // Sync, the register naming a variant the folded edition has no row for.
      await q(`INSERT INTO nzi_console.job_emission_sources (organisation_id,source_id,job_id,scope,source_type,source_name,dataset_id,factor_id,factor_source,quantity,unit,data_source)
               VALUES ($1,'src-folded',$2,'3.6','travel','Travel spend (folded)',$3,'uk-ghg-SPEND-SIC-49.3-5-b','dataset',100,'GBP','Test')`, [ORG, FOLD_JOB, FOLDED]);
      await syncEmissionSourceToScope(database.pool, { jobId: FOLD_JOB, sourceId: "src-folded" }, context());
      const synced = await rowOf(FOLD_JOB, "Travel spend (folded)");
      assert.deepEqual([synced.factor_id, synced.filed_suffix_code, synced.factor_label], ["uk-ghg-SPEND-SIC-49.3-5", "-b", "Land transport services"], "sync files the base, with the pair's label");
      const labels = new Map((await withTenantRead(database.pool, ORG, (db) => listScopeRows(db, FOLD_JOB))).map((row) => [row.sourceLabel, row.reportLabel]));
      assert.equal(labels.get("Commute (folded)"), "Employee Commuting: Average Car Petrol");
      // A scope-shifted copy is not folded even where its row is missing: its Scope 1 base cannot stand for business travel. Through
      // sync, which runs no validity of its own — so this is the fold's own scope rule, not a later refusal, that keeps it.
      await q(`INSERT INTO nzi_console.job_emission_sources (organisation_id,source_id,job_id,scope,source_type,source_name,dataset_id,factor_id,factor_source,quantity,unit,data_source)
               VALUES ($1,'src-folded-bcp',$2,'3.6','travel','Large car travel (folded)',$3,'uk-ghg-4_301_3070_4_1-bcp','dataset',100,'km','Test')`, [ORG, FOLD_JOB, FOLDED]);
      await syncEmissionSourceToScope(database.pool, { jobId: FOLD_JOB, sourceId: "src-folded-bcp" }, context());
      const shifted = await rowOf(FOLD_JOB, "Large car travel (folded)");
      assert.deepEqual([shifted.factor_id, shifted.filed_suffix_code], ["uk-ghg-4_301_3070_4_1-bcp", null], "-bcp is never filed as its Scope 1 base");
      await assert.rejects(create("uk-ghg-4_301_3070_4_1-bcp", "3.6", "Large car travel (folded, create)", "km"), /Command validation failed/, "and a create of it is refused, as today");
      // A base withdrawn from the edition is nothing to file a variant as — again through sync, which runs no validity of its own.
      await q(`UPDATE nzi_console.emission_factors SET active=false WHERE organisation_id=$1 AND dataset_id=$2 AND factor_id='uk-ghg-27_320_3235_14_1'`, [ORG, FOLDED]);
      await q(`INSERT INTO nzi_console.job_emission_sources (organisation_id,source_id,job_id,scope,source_type,source_name,dataset_id,factor_id,factor_source,quantity,unit,data_source)
               VALUES ($1,'src-folded-inactive',$2,'3.9','travel','Shipping (base withdrawn)',$3,'uk-ghg-27_320_3235_14_1-d','dataset',100,'tonne.km','Test')`, [ORG, FOLD_JOB, FOLDED]);
      await syncEmissionSourceToScope(database.pool, { jobId: FOLD_JOB, sourceId: "src-folded-inactive" }, context());
      const withdrawn = await rowOf(FOLD_JOB, "Shipping (base withdrawn)");
      assert.deepEqual([withdrawn.factor_id, withdrawn.filed_suffix_code], ["uk-ghg-27_320_3235_14_1-d", null], "never filed as an inactive base");
    });
  });

  it("a variant id under a category that is not its own is written as sent", async () => {
    await withFlag("true", async () => {
      const rowId = (await createScopeRow(database.pool, { jobId: NEW, scope: "3.4", categoryCode: "3.4", sourceLabel: "Haulage (a -d copy, upstream)", reportLabel: "Haulage (a -d copy, upstream)",
        quantity: 10, unit: "GBP", datasetId: DS, factorId: "uk-ghg-SPEND-SIC-49.3-5-d", factorVersion: DS_VERSION, factorLabel: "Land transport services", qualityTier: "spend-based" } as never, context())).data.rowId;
      const stored = (await q<Stored>(`SELECT factor_id, filed_suffix_code FROM nzi_console.job_scope_rows WHERE scope_row_id=$1`, [rowId]))[0]!;
      assert.deepEqual([stored.factor_id, stored.filed_suffix_code], ["uk-ghg-SPEND-SIC-49.3-5-d", null], "upstream files the base under -u, never this -d copy");
    });
  });
  it("Step D, the pick list: a category's preview labels a filed base by its pair and folds the variant that files as it; off, neither", async () => {
    const preview = (categoryCode: string, scope: string) => withTenantRead(database.pool, ORG, (db) => previewDeclaredFactor(db, ORG, NEW,
      { scope, unit: null, supplySource: null, assertedVehicleAttributes: null }, categoryCode));
    await withFlag("true", async () => {
      const commuting = await preview("3.7", "3.7");
      assert.deepEqual(commuting.optionLabels, {
        "uk-ghg-25_301_3070_9_1": "Employee commuting- land - Cars (by size) - Average car - Petrol",
        "uk-ghg-25_315_3147_11_1": "Employee commuting- land - Rail - National rail",
      }, "each commuting base under its pair's own label — never the business-travel wording");
      assert.deepEqual([...commuting.foldedOptions!].sort((a, b) => a.factorId.localeCompare(b.factorId)),
        [{ datasetId: DS, factorId: "uk-ghg-25_301_3070_9_1-c" }, { datasetId: DS, factorId: "uk-ghg-25_315_3147_11_1-c" }]);
      const travel = await preview("3.6", "3.6");
      assert.equal(travel.optionLabels!["uk-ghg-SPEND-SIC-49.3-5"], "Land transport services");
      assert.ok(travel.foldedOptions!.some((option) => option.factorId === "uk-ghg-SPEND-SIC-49.3-5-b"));
      assert.ok(!travel.foldedOptions!.some((option) => option.factorId === "uk-ghg-4_301_3070_4_1-bcp"), "a scope-shifted copy is never folded");
      const upstream = await preview("3.4", "3.4");
      assert.ok(!("uk-ghg-27_320_3235_14_1" in upstream.optionLabels!), "the container ship upstream is used natively: no pair, no relabel");
      assert.ok(!upstream.foldedOptions!.some((option) => option.factorId === "uk-ghg-SPEND-SIC-49.3-5-d"), "a -d copy is not 3.4's pair");
    });
    await withFlag("false", async () => {
      const off = await preview("3.7", "3.7");
      assert.ok(!("optionLabels" in off) && !("foldedOptions" in off), "the kill-switch: the preview is as it was");
    });
  });
});
