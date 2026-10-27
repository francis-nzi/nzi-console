import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { commandGrantForRole, type StaffRole } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { calculateScopeRow, createClientSite, createScopeRow, editSite, readJobCurrencies, readJobEntryBasis, setJobSiteFxRate, withTenantRead } from "../src/index";
import { VersionConflictError } from "../src/errors";

/**
 * Data entry D3 (R1, R7) against Postgres: local-first currency. A site spends in its own currency; a spend line there is captured in
 * it and priced by a spend factor in that currency (the country's own), so the emissions are local spend × local factor — and an FX
 * rate, set per site per job, never changes them. The rate is the CRM's, versioned and audited, and exists only to express money in
 * the client's currency. Factors are invented, named as such.
 */
const ORG = "demo-nzi-console";
const CLIENT = "client-d3";
const JOB = "job-d3";
const STAFF = "staff-d3";
const VIEWER = "staff-d3-viewer";
const DS = "d3-dataset";

describe("Data entry D3: a site's own currency, local emissions, and an FX rate only for money", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;
  let keys = 0;
  let paris = "";
  let leeds = "";
  const context = (actor = STAFF, role: StaffRole = "admin") => {
    keys += 1;
    return { organisationId: ORG, actorId: actor, principal: "staff" as const, idempotencyKey: `d3-${keys}`, correlationId: `corr-d3-${keys}`, grant: commandGrantForRole(role, ORG, actor) };
  };
  const issues = async (promise: Promise<unknown>) => {
    try { await promise; return []; } catch (error: any) { return (error.issues ?? [{ code: error.name }]).map((issue: any) => issue.code); }
  };
  const tonnes = async (rowId: string) => Number((await db.query<{ t: string }>(`SELECT calculated_tco2e::text AS t FROM nzi_console.job_scope_rows WHERE scope_row_id = $1`, [rowId])).rows[0]!.t);
  const version = async (rowId: string) => (await db.query<{ version: number }>(`SELECT version FROM nzi_console.job_scope_rows WHERE scope_row_id = $1`, [rowId])).rows[0]!.version;

  before(async () => {
    database = (await createDisposableDatabase("dataentryd3"))!;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $1)`, [ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
    await db.query(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status, currency) VALUES ($1, $2, 'Co', 'active', 'GBP')`, [ORG, CLIENT]);
    for (const [user, role] of [[STAFF, "admin"], [VIEWER, "viewer"]]) await db.query(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status) VALUES ($1, $2, $3, 'active')`, [ORG, user, role]);
    await db.query(
      `INSERT INTO nzi_console.jobs (organisation_id, job_id, client_id, sequence, job_family, title, status, workflow_stage, reporting_year, reporting_period_start, reporting_period_end)
       VALUES ($1, $2, $3, 1, 'crp', 'CRP', 'open', 'Data entry', 2026, '2026-01-01', '2026-12-31')`, [ORG, JOB, CLIENT]);
    await db.query(`INSERT INTO nzi_console.job_emissions_config (organisation_id, job_id, reporting_from, reporting_to, country_code) VALUES ($1, $2, '2026-01-01', '2026-12-31', 'GB')`, [ORG, JOB]);
    await db.query(
      `INSERT INTO nzi_console.emission_factor_datasets (organisation_id, dataset_id, name, version, valid_from, valid_to, country_code, status, source_name, licence)
       VALUES ($1, $2, 'D3 test factors', 'd3', '2026-01-01', '2026-12-31', 'GB', 'active', 'Test', 'Test only')`, [ORG, DS]);
    await db.query(
      `INSERT INTO nzi_console.emission_factors (organisation_id, dataset_id, factor_id, label, activity_unit, kgco2e_per_unit, scopes) VALUES
         ($1, $2, 'd3-fr-services', 'Services — France, spend (test)', 'EUR', 0.2, ARRAY['3']),
         ($1, $2, 'd3-uk-services', 'Services — UK, spend (test)', 'GBP', 0.3, ARRAY['3'])`, [ORG, DS]);
    await db.query(`INSERT INTO nzi_console.job_dataset_selections (organisation_id, job_id, dataset_id, selection_source, reason, selected_by) VALUES ($1, $2, $3, 'manual', 'Test', 'test')`, [ORG, JOB, DS]);
    paris = (await createClientSite(database.pool, { clientId: CLIENT, name: "Paris office", inServiceFrom: null, country: "FR", currency: "EUR" } as never, context())).data.siteId;
    leeds = (await createClientSite(database.pool, { clientId: CLIENT, name: "Leeds depot", inServiceFrom: null, country: "GB" } as never, context())).data.siteId;
  });
  after(async () => { await db?.end(); await database?.end(); });

  it("R1: a site holds its own currency (create and edit); an unknown code is refused; the job's read lists it", async () => {
    const stored = (await db.query<{ currency: string | null }>(`SELECT currency FROM nzi_console.client_sites WHERE site_id = $1`, [paris])).rows[0]!.currency;
    assert.equal(stored, "EUR");
    const leedsVersion = (await db.query<{ version: number }>(`SELECT version FROM nzi_console.client_sites WHERE site_id = $1`, [leeds])).rows[0]!.version;
    assert.deepEqual(await issues(editSite(database.pool, { siteId: leeds, name: "Leeds depot", inServiceFrom: null, expectedVersion: leedsVersion, currency: "euro" }, context())), ["INVALID"]);
    const read = await withTenantRead(database.pool, ORG, (tx) => readJobCurrencies(tx, ORG, JOB));
    assert.equal(read.clientCurrency, "GBP");
    assert.deepEqual(read.sites.map((site) => [site.name, site.currency, site.ownCurrency, site.needsRate]), [["Leeds depot", "GBP", false, false], ["Paris office", "EUR", true, true]]);
    const basis = await withTenantRead(database.pool, ORG, (tx) => readJobEntryBasis(tx, ORG, JOB));
    assert.deepEqual(basis.siteCurrencies, { [paris]: "EUR" }, "the drawer opens a Paris spend line in EUR");
  });

  it("R1: a spend line at the Paris site is captured in EUR and priced by the French factor — emissions are local × local", async () => {
    const row = await createScopeRow(database.pool, { jobId: JOB, scope: "3.1", categoryCode: "3.1", sourceLabel: "Paris consultancy", siteId: paris, quantity: 10000, unit: "EUR",
      datasetId: DS, factorId: "d3-fr-services", factorVersion: "d3", factorLabel: "Services FR", qualityTier: "spend-based", entryBasis: "spend" }, context());
    await calculateScopeRow(database.pool, { jobId: JOB, rowId: row.data.rowId, expectedVersion: await version(row.data.rowId) }, context());
    assert.equal(await tonnes(row.data.rowId), 2, "€10,000 × 0.2 kg/€ = 2 t — no exchange rate anywhere");
    // A EUR line cannot be priced by the UK factor: it would need converting, and the carbon maths never converts.
    assert.deepEqual(await issues(createScopeRow(database.pool, { jobId: JOB, scope: "3.1", categoryCode: "3.1", sourceLabel: "x", siteId: paris, quantity: 1, unit: "EUR",
      datasetId: DS, factorId: "d3-uk-services", factorVersion: "d3", factorLabel: "x", qualityTier: "spend-based" }, context())), ["UNIT_INCOMPATIBLE"]);
  });

  it("R1/R7: the CRM sets Paris's FX rate for the job — versioned, audited — and the emissions do not move", async () => {
    const before = (await db.query<{ scope_row_id: string; calculated_tco2e: string }>(`SELECT scope_row_id, calculated_tco2e::text FROM nzi_console.job_scope_rows WHERE source_label = 'Paris consultancy'`)).rows[0]!;
    const set = await setJobSiteFxRate(database.pool, { jobId: JOB, siteId: paris, rate: 0.86, expectedVersion: null }, context());
    assert.deepEqual(set.data, { siteId: paris, fromCurrency: "EUR", toCurrency: "GBP", rate: 0.86, version: 1 });
    const audit = (await db.query<{ action: string; after_json: any }>(`SELECT action, after_json FROM nzi_console.audit_events WHERE audit_event_id = $1`, [set.auditEventId])).rows[0]!;
    assert.equal(audit.action, "job_site_fx_rate_set");
    await calculateScopeRow(database.pool, { jobId: JOB, rowId: before.scope_row_id, expectedVersion: await version(before.scope_row_id) }, context());
    assert.equal(String(await tonnes(before.scope_row_id)), String(Number(before.calculated_tco2e)), "recalculated with a rate held: the same tonnes");
    const updated = await setJobSiteFxRate(database.pool, { jobId: JOB, siteId: paris, rate: 0.85, expectedVersion: 1 }, context());
    assert.equal(updated.data.version, 2);
    await assert.rejects(setJobSiteFxRate(database.pool, { jobId: JOB, siteId: paris, rate: 0.9, expectedVersion: 1 }, context()), VersionConflictError);
    assert.deepEqual(await issues(setJobSiteFxRate(database.pool, { jobId: JOB, siteId: paris, rate: 0.85, expectedVersion: 2 }, context())), ["UNCHANGED"]);
    const read = await withTenantRead(database.pool, ORG, (tx) => readJobCurrencies(tx, ORG, JOB));
    assert.deepEqual(read.sites.find((site) => site.siteId === paris)!.rate, { siteId: paris, fromCurrency: "EUR", toCurrency: "GBP", rate: 0.85, version: 2 });
  });

  it("a site in the client's currency needs no rate; a viewer cannot set one", async () => {
    assert.deepEqual(await issues(setJobSiteFxRate(database.pool, { jobId: JOB, siteId: leeds, rate: 1.1, expectedVersion: null }, context())), ["NOT_NEEDED"]);
    await assert.rejects(setJobSiteFxRate(database.pool, { jobId: JOB, siteId: paris, rate: 0.8, expectedVersion: 2 }, context(VIEWER, "viewer")),
      (error: any) => /Authori[sz]ation|Forbidden|permission/i.test(`${error.name} ${error.message}`));
  });

  it("a rate recorded for EUR is not re-meant when the site's currency changes: the read matches both currencies", async () => {
    const parisVersion = (await db.query<{ version: number }>(`SELECT version FROM nzi_console.client_sites WHERE site_id = $1`, [paris])).rows[0]!.version;
    await editSite(database.pool, { siteId: paris, name: "Paris office", inServiceFrom: null, expectedVersion: parisVersion, currency: "CHF" }, context());
    const read = await withTenantRead(database.pool, ORG, (tx) => readJobCurrencies(tx, ORG, JOB));
    const site = read.sites.find((entry) => entry.siteId === paris)!;
    assert.deepEqual([site.currency, site.needsRate, site.rate], ["CHF", true, null], "the EUR rate is not offered as a CHF one");
  });
});
