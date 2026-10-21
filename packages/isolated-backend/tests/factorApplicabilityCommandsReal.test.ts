import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { commandGrantForRole, type CommandContext } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { addFactorApplicabilityCommand, retireFactorApplicabilityCommand } from "../src/factorApplicabilityCommands";
import { calculateScopeRow, CommandValidationError, createScopeRow } from "../src/postgresCommands";
import { listScopeRows } from "../src/readModels";
import { withTenantRead } from "../src/postgres";
import { AuthorizationError } from "../src/auth";

/**
 * Dedup slice 5 Step B: applicability curated through registered commands. `factor.applicability.add` carries the pair's labels to
 * the row; both commands are gated on `factor.manage`, validated against the registry, audited by the runner with the pair before,
 * idempotent; neither deletes anything.
 */
const ORG = "org-s5b", ADMIN = "ada", CONSULTANT = "cole", CLIENT = "client-s5b", JOB = "job-s5b";
const DS = "gb-2025", DS_VERSION = "2025.1";
const LARGE_CAR = "uk-ghg-4_301_3070_4_1", BUS = "uk-ghg-25_315_3150_11_1";

describe("dedup slice 5 Step B: factor.applicability.add / .retire (factor.manage)", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let keys = 0;
  const context = (actorId = ADMIN, role: "admin" | "consultant" = "admin", over: Partial<CommandContext> = {}): CommandContext => {
    keys += 1;
    return { organisationId: ORG, actorId, principal: "staff", idempotencyKey: `s5b-${keys}`, correlationId: `corr-s5b-${keys}`, grant: commandGrantForRole(role, ORG, actorId), ...over };
  };
  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => {
    const db = await database.admin();
    try { return (await db.query(sql, params)).rows as T[]; } finally { await db.end(); }
  };
  const pair = async (factorId: string, suffixCode: string) => (await q<{ status: string; source: string; report_label: string | null; label: string | null; retired_reason: string | null; created_by: string }>(
    `SELECT status, source, report_label, label, retired_reason, created_by FROM nzi_console.factor_identity_categories WHERE organisation_id=$1 AND factor_id=$2 AND suffix_code=$3`, [ORG, factorId, suffixCode]))[0];
  const audits = async (entityId: string) => q<{ action: string; actor_id: string; reason: string | null; before_json: Record<string, unknown> | null; after_json: Record<string, unknown> | null }>(
    `SELECT action, actor_id, reason, before_json, after_json FROM nzi_console.audit_events WHERE organisation_id=$1 AND entity_id=$2 ORDER BY occurred_at, audit_event_id`, [ORG, entityId]);
  const refused = (code: string) => (error: unknown) => error instanceof CommandValidationError && error.issues.some((issue) => issue.code === code);
  // Runs a block of work. (The blocks once ran under a flag; there is no flag since dedup slice 5 Step E.)
  const run = <T>(work: () => Promise<T>): Promise<T> => work();

  before(async () => {
    database = (await createDisposableDatabase("s5bcommands"))!;
    await q(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,$1)`, [ORG]);
    await q(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    await q(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
    await q(`INSERT INTO nzi_console.memberships (organisation_id,user_id,role_id,status,display_name) VALUES ($1,$2,'admin','active','Ada'), ($1,$3,'consultant','active','Cole')`, [ORG, ADMIN, CONSULTANT]);
    await q(`INSERT INTO nzi_console.emission_factor_datasets (organisation_id,dataset_id,name,version,valid_from,valid_to,country_code,status,source_name,licence)
             VALUES ($1,$2,'DESNZ GB 2025',$3,'2025-01-01','2026-12-31','GB','active','DESNZ','OGL')`, [ORG, DS, DS_VERSION]);
    for (const [id, unit, value, scopes, label, reportLabel] of [
      [LARGE_CAR, "km", 0.16272, ["1", "3"], "Passenger vehicles - Large car - Diesel", "Company Vehicles: Large Car Diesel"],
      [`${BUS}`, "passenger.km", 0.1, ["3"], "Business travel- land - Bus", "Business Travel: Bus"],
      [`${BUS}-b`, "passenger.km", 0.1, ["3"], "Business travel- land - Bus", "Business Travel: Bus"],
    ] as const) {
      await q(`INSERT INTO nzi_console.emission_factors (organisation_id,dataset_id,factor_id,label,activity_unit,kgco2e_per_unit,scopes) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [ORG, DS, id, label, unit, value, scopes]);
      await q(`UPDATE nzi_console.factor_identities SET label=$3, report_label=$4 WHERE organisation_id=$1 AND factor_id=$2`, [ORG, id, label, reportLabel]);
    }
    await q(`INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,$2,'Slice Five B Co','active')`, [ORG, CLIENT]);
    await q(`INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage,reporting_year,reporting_period_start,reporting_period_end)
             VALUES ($1,$2,$3,1,'crp','CRP','open','Data entry',2025,'2025-01-01','2025-12-31')`, [ORG, JOB, CLIENT]);
    await q(`INSERT INTO nzi_console.job_emissions_config (organisation_id,job_id,reporting_from,reporting_to,country_code) VALUES ($1,$2,'2025-01-01','2025-12-31','GB')`, [ORG, JOB]);
    await q(`INSERT INTO nzi_console.job_dataset_selections (organisation_id,job_id,dataset_id,selection_source,reason,selected_by) VALUES ($1,$2,$3,'automatic','Fixture',$4)`, [ORG, JOB, DS, ADMIN]);
  });
  after(async () => { await database?.end(); });

  it("add carries the pair's labels to the record, the runner audits it, and a row filed under it prints them", async () => {
    const added = await addFactorApplicabilityCommand(database.pool, { factorId: LARGE_CAR, suffixCode: "-c",
      reportLabel: "Employee Commuting: Large Car Diesel", label: "Employee commuting- land - Large car - Diesel" }, context());
    assert.equal(added.data.outcome, "added");
    assert.deepEqual(await pair(LARGE_CAR, "-c"), { status: "active", source: "admin", report_label: "Employee Commuting: Large Car Diesel",
      label: "Employee commuting- land - Large car - Diesel", retired_reason: null, created_by: ADMIN });
    const [event] = await audits(`${LARGE_CAR}-c`);
    assert.deepEqual([event!.action, event!.actor_id, event!.before_json], ["factor.applicability.added", ADMIN, null], "the runner's audit, nothing before it");
    // The labels reach the row: a commuting entry on the Scope 1 car is filed under the pair and prints the pair's strings.
    await run(async () => {
      const rowId = (await createScopeRow(database.pool, { jobId: JOB, scope: "3.7", categoryCode: "3.7", sourceLabel: "Large car commute", reportLabel: "Large car commute",
        quantity: 400, unit: "km", datasetId: DS, factorId: LARGE_CAR, factorVersion: DS_VERSION, factorLabel: "Passenger vehicles - Large car - Diesel", qualityTier: "measured" } as never, context())).data.rowId;
      const stored = (await q<{ factor_label: string; filed_suffix_code: string; version: number }>(`SELECT factor_label, filed_suffix_code, version FROM nzi_console.job_scope_rows WHERE scope_row_id=$1`, [rowId]))[0]!;
      assert.deepEqual([stored.filed_suffix_code, stored.factor_label], ["-c", "Employee commuting- land - Large car - Diesel"]);
      await calculateScopeRow(database.pool, { jobId: JOB, rowId, expectedVersion: stored.version }, context());
      const read = (await withTenantRead(database.pool, ORG, (db) => listScopeRows(db, JOB))).find((row) => row.id === rowId)!;
      assert.equal(read.reportLabel, "Employee Commuting: Large Car Diesel");
    });
  });

  it("a pair added without labels is NULL, and a row filed under it never prints the base's label", async () => {
    await addFactorApplicabilityCommand(database.pool, { factorId: LARGE_CAR, suffixCode: "-b" }, context());
    assert.deepEqual([(await pair(LARGE_CAR, "-b"))!.report_label, (await pair(LARGE_CAR, "-b"))!.label], [null, null]);
    await run(async () => {
      const rowId = (await createScopeRow(database.pool, { jobId: JOB, scope: "3.6", categoryCode: "3.6", sourceLabel: "Large car trip", reportLabel: "Large car trip",
        quantity: 10, unit: "km", datasetId: DS, factorId: LARGE_CAR, factorVersion: DS_VERSION, factorLabel: "Passenger vehicles - Large car - Diesel", qualityTier: "measured" } as never, context())).data.rowId;
      const read = (await withTenantRead(database.pool, ORG, (db) => listScopeRows(db, JOB))).find((row) => row.id === rowId)!;
      assert.equal((await q<{ filed_suffix_code: string }>(`SELECT filed_suffix_code FROM nzi_console.job_scope_rows WHERE scope_row_id=$1`, [rowId]))[0]!.filed_suffix_code, "-b");
      assert.notEqual(read.reportLabel, "Company Vehicles: Large Car Diesel", "never the base's");
      assert.equal(read.reportLabel, "Large car trip", "it falls through to the row's own");
    });
  });

  it("refuses a variant id, an unknown factor, an unknown or retired suffix — as validation, with nothing written", async () => {
    await assert.rejects(addFactorApplicabilityCommand(database.pool, { factorId: `${BUS}-b`, suffixCode: "-c" }, context()), refused("VARIANT_ID"));
    await assert.rejects(addFactorApplicabilityCommand(database.pool, { factorId: "uk-ghg-no-such", suffixCode: "-c" }, context()), refused("UNKNOWN_FACTOR"));
    await assert.rejects(addFactorApplicabilityCommand(database.pool, { factorId: BUS, suffixCode: "-zz" }, context()), refused("UNKNOWN_SUFFIX"));
    await q(`UPDATE nzi_console.factor_category_variants SET status='retired', retired_at=now(), retired_by='test' WHERE suffix_code='-p'`);
    try {
      await assert.rejects(addFactorApplicabilityCommand(database.pool, { factorId: BUS, suffixCode: "-p" }, context()), refused("RETIRED_SUFFIX"));
    } finally {
      await q(`UPDATE nzi_console.factor_category_variants SET status='active', retired_at=NULL, retired_by=NULL WHERE suffix_code='-p'`);
    }
    assert.equal(await pair(`${BUS}-b`, "-c"), undefined);
    assert.equal(await pair("uk-ghg-no-such", "-c"), undefined);
  });

  it("refuses a caller without factor.manage — a consultant — before anything is written", async () => {
    await assert.rejects(addFactorApplicabilityCommand(database.pool, { factorId: BUS, suffixCode: "-c" }, context(CONSULTANT, "consultant")),
      (error) => error instanceof AuthorizationError);
    await assert.rejects(retireFactorApplicabilityCommand(database.pool, { factorId: LARGE_CAR, suffixCode: "-c" }, context(CONSULTANT, "consultant", { reason: "no" })),
      (error) => error instanceof AuthorizationError);
    assert.equal(await pair(BUS, "-c"), undefined);
    assert.equal((await pair(LARGE_CAR, "-c"))!.status, "active");
  });

  it("is idempotent: a replay of the same command changes nothing; an add of an active pair says so", async () => {
    const replayed = context();
    const first = await addFactorApplicabilityCommand(database.pool, { factorId: BUS, suffixCode: "-c", reportLabel: "Employee Commuting: Bus" }, replayed);
    const again = await addFactorApplicabilityCommand(database.pool, { factorId: BUS, suffixCode: "-c", reportLabel: "Employee Commuting: Bus" }, replayed);
    assert.deepEqual(again.data, first.data);
    assert.equal((await audits(`${BUS}-c`)).length, 1, "one audit for one command");
    const already = await addFactorApplicabilityCommand(database.pool, { factorId: BUS, suffixCode: "-c", reportLabel: "Something else" }, context());
    assert.equal(already.data.outcome, "already-applicable");
    assert.equal((await pair(BUS, "-c"))!.report_label, "Employee Commuting: Bus", "an add never relabels an active pair");
  });

  it("retire needs a reason, keeps the record, audits the pair before, and an add reinstates it keeping its labels", async () => {
    await assert.rejects(retireFactorApplicabilityCommand(database.pool, { factorId: LARGE_CAR, suffixCode: "-c" }, context()), refused("REQUIRED"));
    await assert.rejects(retireFactorApplicabilityCommand(database.pool, { factorId: BUS, suffixCode: "-u" }, context(ADMIN, "admin", { reason: "x" })), refused("UNKNOWN"));
    const retired = await retireFactorApplicabilityCommand(database.pool, { factorId: LARGE_CAR, suffixCode: "-c" }, context(ADMIN, "admin", { reason: "Commuting moved to its own factor." }));
    assert.equal(retired.data.alreadyRetired, false);
    assert.deepEqual([(await pair(LARGE_CAR, "-c"))!.status, (await pair(LARGE_CAR, "-c"))!.retired_reason], ["retired", "Commuting moved to its own factor."]);
    const event = (await audits(`${LARGE_CAR}-c`)).find((entry) => entry.action === "factor.applicability.retired")!;
    assert.equal(event.reason, "Commuting moved to its own factor.");
    assert.equal((event.before_json as { status: string }).status, "active", "the pair as it stood");
    assert.equal((await retireFactorApplicabilityCommand(database.pool, { factorId: LARGE_CAR, suffixCode: "-c" }, context(ADMIN, "admin", { reason: "again" }))).data.alreadyRetired, true);
    const reinstated = await addFactorApplicabilityCommand(database.pool, { factorId: LARGE_CAR, suffixCode: "-c" }, context());
    assert.equal(reinstated.data.outcome, "reinstated");
    assert.deepEqual([(await pair(LARGE_CAR, "-c"))!.status, (await pair(LARGE_CAR, "-c"))!.report_label], ["active", "Employee Commuting: Large Car Diesel"]);
    assert.equal(await q(`SELECT 1 FROM nzi_console.factor_identity_categories WHERE organisation_id=$1 AND status='retired' AND factor_id=$2`, [ORG, LARGE_CAR]).then((rows) => rows.length), 0);
  });
});
