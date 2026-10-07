import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { commandGrantForRole, type CommandContext } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import {
  calculateScopeRow, createEmissionSource, createEmissionSourceGroup, createScopeRow, syncEmissionSourceGroupToScope, syncEmissionSourceToScope,
} from "../src/postgresCommands";

/**
 * RULING-apply-pct (7 Oct) against a real database: `scope.row.calculate` scales by `apply_pct`. `quantity` is the
 * source's full amount and `apply_pct` the share attributed to the row, so the figure is quantity × factor ÷ 1000 ×
 * apply_pct/100 — applied once: an ungrouped register source at 50% equals the same source inside a group (whose roll-up
 * is already scaled, at 100). A real 0% is 0. The seed's gas factor is 0.18 kgCO₂e/kWh, so 1000 kWh is 0.18 t at 100%.
 */
const ORG = "demo-nzi-console"; // the synthetic factor seed's organisation
const CLIENT = "client-pct";
const JOB = "job-pct";
const ACTOR = "ada";
const here = dirname(fileURLToPath(import.meta.url));
const close = (actual: number, expected: number, message: string) => assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: ${actual}, not ${expected}`);

describe("calculate applies apply_pct once, against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;
  let keys = 0;
  const context = (): CommandContext => {
    keys += 1;
    return { organisationId: ORG, actorId: ACTOR, principal: "staff", idempotencyKey: `pct-${keys}`, correlationId: `corr-pct-${keys}`, grant: commandGrantForRole("admin", ORG, ACTOR) };
  };
  // Typed loosely: these build command inputs, and the command validates them.
  const entry = (over: Record<string, unknown> = {}): any => ({
    jobId: JOB, scope: "1", sourceLabel: "Boiler", reportLabel: "Boiler", categoryCode: "1.natural-gas",
    quantity: 1000, unit: "kWh", datasetId: "synthetic-gb-2026", factorId: "gas-demo", factorVersion: "2026 demo v1", factorLabel: "Gas", qualityTier: "measured", ...over,
  });
  const source = (over: Record<string, unknown> = {}): any => ({
    jobId: JOB, groupId: null, scope: "1", sourceType: "asset", sourceSubtype: null, siteId: null, sourceName: "Boiler",
    assetIdentifier: null, purchasedGoodsCategoryId: null, datasetId: "synthetic-gb-2026", factorId: "gas-demo", factorSource: "dataset", clientFactorId: null,
    quantity: 1000, unit: "kWh", applyPct: 50, dataSource: "Meter read", dataConfidence: null, monthlyActivity: [], detail: { kind: "asset" }, notes: null, ...over,
  });
  const calculate = async (rowId: string) => {
    const { rows: [row] } = await db.query<{ version: number }>(`SELECT version FROM nzi_console.job_scope_rows WHERE scope_row_id=$1`, [rowId]);
    return (await calculateScopeRow(database.pool, { jobId: JOB, rowId, expectedVersion: row!.version }, context())).data.calculatedTco2e;
  };
  const stored = async (rowId: string) => (await db.query<{ calculated_tco2e: string; apply_pct: string; provenance_json: Record<string, any>; lineage_json: Array<{ title: string; detail: string }> }>(
    `SELECT calculated_tco2e, apply_pct, provenance_json, lineage_json FROM nzi_console.job_scope_rows WHERE scope_row_id=$1`, [rowId])).rows[0]!;

  before(async () => {
    database = (await createDisposableDatabase("applypct"))!;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,$1)`, [ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    await db.query(`INSERT INTO nzi_console.memberships (organisation_id,user_id,role_id,status,display_name) VALUES ($1,$2,'admin','active','Ada Admin')`, [ORG, ACTOR]);
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
    await db.query(`INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,$2,'Co','active')`, [ORG, CLIENT]);
    await db.query(
      `INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage,reporting_year,reporting_period_start,reporting_period_end)
       VALUES ($1,$2,$3,1,'crp','CRP','open','Data entry',2026,'2026-01-01','2026-12-31')`, [ORG, JOB, CLIENT]);
    await db.query(
      `INSERT INTO nzi_console.job_emissions_config (organisation_id,job_id,reporting_from,reporting_to,country_code) VALUES ($1,$2,'2026-01-01','2026-12-31','GB')`, [ORG, JOB]);
    await db.query(readFileSync(resolve(here, "../seeds/0003_synthetic_factors.sql"), "utf8"));
  });
  after(async () => { await db?.end(); await database?.end(); });

  it("a row at 100% is the full figure, unchanged — and states no apportionment", async () => {
    const rowId = (await createScopeRow(database.pool, entry(), context())).data.rowId;
    close(await calculate(rowId), 0.18, "1000 kWh × 0.18 ÷ 1000");
    assert.ok(!(await stored(rowId)).lineage_json.some((step) => step.title === "Apportioned"));
  });

  it("a manually calculated row at 60% reports 60% of quantity × factor, and says so in its provenance and lineage", async () => {
    const rowId = (await createScopeRow(database.pool, entry({ applyPct: 60, sourceLabel: "Shared boiler" }), context())).data.rowId;
    close(await calculate(rowId), 0.108, "60% of 0.18");
    const row = await stored(rowId);
    close(Number(row.calculated_tco2e), 0.108, "the stored figure");
    assert.equal(row.provenance_json.applyPct, 60);
    assert.deepEqual(row.lineage_json.find((step) => step.title === "Apportioned"), { title: "Apportioned", detail: "60% of the source attributed to this row" });
  });

  it("an ungrouped register source at 50% gives the same figure as the same source inside a group — applied once", async () => {
    const alone = (await createEmissionSource(database.pool, source({ sourceName: "Boiler alone" }), context())).data.sourceId;
    const aloneRow = (await syncEmissionSourceToScope(database.pool, { jobId: JOB, sourceId: alone }, context())).data.rowId;
    assert.equal(Number((await stored(aloneRow)).apply_pct), 50, "the ungrouped row carries the share, its quantity the full source");
    const ungrouped = await calculate(aloneRow);

    const groupId = (await createEmissionSourceGroup(database.pool, { jobId: JOB, name: "Boilers", datasetId: "synthetic-gb-2026", factorId: "gas-demo", factorLabel: "Gas", unit: "kWh" }, context())).data.groupId;
    await createEmissionSource(database.pool, source({ sourceName: "Boiler grouped", groupId }), context());
    const rollupRow = (await syncEmissionSourceGroupToScope(database.pool, { jobId: JOB, groupId }, context())).data.rowId!;
    assert.equal(Number((await stored(rollupRow)).apply_pct), 100, "the roll-up arrives scaled, at 100");
    const grouped = await calculate(rollupRow);

    close(ungrouped, 0.09, "50% of 0.18");
    close(grouped, ungrouped, "grouped equals ungrouped");
  });

  it("a real 0% calculates as 0 — v7's \"0 means 100\" is not carried over", async () => {
    const rowId = (await createScopeRow(database.pool, entry({ applyPct: 0, sourceLabel: "Sublet boiler" }), context())).data.rowId;
    close(await calculate(rowId), 0, "0% of 0.18");
  });
});
