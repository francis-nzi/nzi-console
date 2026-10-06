import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { commandGrantForRole, type CommandContext } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { createEmissionSource, createScopeRow, updateScopeRow } from "../src/postgresCommands";
import { archiveSite, createClientSite, unarchiveSite } from "../src/siteLifecycle";

/**
 * The archived-site write check (FOLLOWUP-site-archive-write-check, ruled 6 Oct): a row may cite an archived site only
 * if it already did. One current-vs-target comparison in requireSiteForJob — current is null on create and the stored
 * site_id on update — so a new row on an archived site is refused on both create paths, an edit moving a row onto one is
 * refused, an edit keeping one is allowed, and unarchiving lifts the refusal.
 */
const ORG = "demo-nzi-console"; // the synthetic factor seed's organisation
const CLIENT = "client-sw";
const JOB = "job-sw";
const ACTOR = "ada";
const here = dirname(fileURLToPath(import.meta.url));

describe("an archived site refuses new citations but keeps the rows that already cite it, against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;
  let keys = 0;
  const context = (reason?: string): CommandContext => {
    keys += 1;
    return { organisationId: ORG, actorId: ACTOR, principal: "staff", idempotencyKey: `sw-${keys}`, correlationId: `corr-sw-${keys}`,
      grant: commandGrantForRole("admin", ORG, ACTOR), ...(reason ? { reason } : {}) };
  };
  const refusedWith = (code: string) => (error: any) => error.issues?.some((issue: any) => issue.code === code);
  // Typed loosely: these build command inputs, and the command validates them.
  const entry = (over: Record<string, unknown> = {}): any => ({
    jobId: JOB, scope: "1", sourceLabel: "Boiler", reportLabel: "Boiler", categoryCode: "1.natural-gas",
    quantity: 10, unit: "kWh", datasetId: "synthetic-gb-2026", factorId: "gas-demo", factorVersion: "2026 demo v1", factorLabel: "Gas", qualityTier: "measured", ...over,
  });
  const source = (over: Record<string, unknown> = {}): any => ({
    jobId: JOB, groupId: null, scope: "1", sourceType: "asset", sourceSubtype: null, siteId: null, sourceName: "Forklift",
    assetIdentifier: null, purchasedGoodsCategoryId: null, datasetId: "synthetic-gb-2026", factorId: "gas-demo", factorSource: "dataset", clientFactorId: null,
    quantity: 10, unit: "kWh", applyPct: 100, dataSource: "Meter read", dataConfidence: null, monthlyActivity: [],
    detail: { kind: "asset" }, notes: null, ...over,
  });
  const stored = async (rowId: string) => (await db.query<{ site_id: string | null; version: number }>(
    `SELECT site_id, version FROM nzi_console.job_scope_rows WHERE scope_row_id=$1`, [rowId])).rows[0]!;
  const moveTo = async (rowId: string, siteId: string | null) => {
    const { version } = await stored(rowId);
    return updateScopeRow(database.pool, { ...entry({ siteId }), rowId, expectedVersion: version, enabled: true }, context());
  };
  const siteVersion = async (siteId: string) => (await db.query<{ version: number }>(
    `SELECT version FROM nzi_console.client_sites WHERE site_id=$1`, [siteId])).rows[0]!.version;
  let depot = "", office = "", kept = "", other = "";

  before(async () => {
    database = (await createDisposableDatabase("sitewrite"))!;
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
      `INSERT INTO nzi_console.job_emissions_config (organisation_id,job_id,reporting_from,reporting_to,country_code)
       VALUES ($1,$2,'2026-01-01','2026-12-31','GB')`, [ORG, JOB]);
    await db.query(readFileSync(resolve(here, "../seeds/0003_synthetic_factors.sql"), "utf8"));
    office = (await createClientSite(database.pool, { clientId: CLIENT, name: "Head Office", inServiceFrom: null, isRegisteredOffice: true } as never, context())).data.siteId;
    depot = (await createClientSite(database.pool, { clientId: CLIENT, name: "Depot", inServiceFrom: null } as never, context())).data.siteId;
    // Two rows before the archive: one already citing the depot, one at the office.
    kept = (await createScopeRow(database.pool, entry({ siteId: depot, sourceLabel: "Depot boiler" }), context())).data.rowId;
    other = (await createScopeRow(database.pool, entry({ siteId: office, sourceLabel: "Office boiler" }), context())).data.rowId;
    await archiveSite(database.pool, { siteId: depot, expectedVersion: await siteVersion(depot) }, context("closed"));
  });
  after(async () => { await db?.end(); await database?.end(); });

  it("refuses a new row on an archived site, on both create paths", async () => {
    await assert.rejects(() => createScopeRow(database.pool, entry({ siteId: depot }), context()), refusedWith("SITE_ARCHIVED"));
    await assert.rejects(() => createEmissionSource(database.pool, source({ siteId: depot }), context()), refusedWith("SITE_ARCHIVED"));
    const created = await createScopeRow(database.pool, entry({ siteId: office }), context());
    assert.equal((await stored(created.data.rowId)).site_id, office, "a live site is still accepted");
    const made = await createEmissionSource(database.pool, source({ siteId: office }), context());
    assert.ok(made.data.sourceId, "a live site is still accepted for a source");
  });

  it("refuses an edit that moves a row onto an archived site", async () => {
    await assert.rejects(() => moveTo(other, depot), refusedWith("SITE_ARCHIVED"));
    assert.equal((await stored(other)).site_id, office, "the row was not moved");
  });

  it("allows an edit that keeps an already-archived site — and once moved off, the row cannot come back", async () => {
    await moveTo(kept, depot);
    assert.equal((await stored(kept)).site_id, depot, "the archived site is kept on edit");
    await moveTo(kept, office);
    await assert.rejects(() => moveTo(kept, depot), refusedWith("SITE_ARCHIVED"));
  });

  it("unarchiving lifts the refusal", async () => {
    await unarchiveSite(database.pool, { siteId: depot, expectedVersion: await siteVersion(depot) }, context());
    const created = await createScopeRow(database.pool, entry({ siteId: depot }), context());
    assert.equal((await stored(created.data.rowId)).site_id, depot);
    assert.ok((await createEmissionSource(database.pool, source({ siteId: depot }), context())).data.sourceId);
    await moveTo(other, depot);
    assert.equal((await stored(other)).site_id, depot);
  });
});
