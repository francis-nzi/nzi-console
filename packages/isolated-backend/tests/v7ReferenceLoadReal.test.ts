import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { commandGrantForRole } from "@nzi/contracts";
import { createJob } from "../src/index";
import { listCategoryVariants } from "../src/factorCategoryVariants";
import { parseCsv, planV7Load, type LoadPlan } from "../src/v7ReferenceImport";
import { loadV7Plan, V7LoadRefused } from "../src/v7ReferenceLoad";

/**
 * Loading a v7 plan into the real operating organisation, on a database built by every migration (0125–0127 included):
 * what lands, that a second run changes nothing, that a changed edition is refused rather than overwritten, that a plan
 * carrying a refusal writes nothing, and that the organisation must exist. Synthetic extract (NZC-020).
 */

const DATABASE_URL = TEST_DATABASE_URL;
const ORG = "net-zero-international";
const here = dirname(fileURLToPath(import.meta.url));

describe("loading v7 reference data into net-zero-international", { skip: DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;
  let plan: LoadPlan;
  const count = async (sql: string) => Number((await db.query<{ n: string }>(sql, [ORG])).rows[0]!.n);
  const counts = async () => ({
    datasets: await count(`SELECT count(*) AS n FROM nzi_console.emission_factor_datasets WHERE organisation_id=$1 AND source_system='nzi-pro-v7'`),
    factors: await count(`SELECT count(*) AS n FROM nzi_console.emission_factors WHERE organisation_id=$1 AND source_system='nzi-pro-v7'`),
    identities: await count(`SELECT count(*) AS n FROM nzi_console.factor_identities WHERE organisation_id=$1 AND source_system='nzi-pro-v7'`),
  });

  before(async () => {
    database = (await createDisposableDatabase("v7load"))!;
    db = await database.admin();
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
    const rows = parseCsv(readFileSync(resolve(here, "fixtures/v7-factor-lookup-synthetic.csv"), "utf8"));
    plan = planV7Load(rows, await listCategoryVariants(db));
    assert.deepEqual(plan.refusals, [], "the synthetic plan should be loadable");
  });

  after(async () => { await db?.end(); await database?.end(); });

  it("writes every dataset, identity and value row the plan holds", async () => {
    const outcome = await loadV7Plan(database.pool, plan);
    assert.deepEqual(outcome, { datasetsInserted: 8, datasetsUnchanged: 0, identitiesInserted: plan.identities.length, identitiesKept: 0, factorsInserted: 15 }); // the fixture's -w row is excluded (retired-w)
    assert.deepEqual(await counts(), { datasets: 8, factors: 15, identities: plan.identities.length });
  });

  it("lands v7's curated identity, the code verbatim and the lookup row, not the trigger's fallback", async () => {
    const identity = (await db.query<{ label: string; report_label: string; business_category: string; legacy_original_id: string; legacy_db_id: string; source_family: string; created_by: string }>(
      `SELECT label, report_label, business_category, legacy_original_id, legacy_db_id, source_family, created_by
         FROM nzi_console.factor_identities WHERE organisation_id=$1 AND factor_id='iea-puerto-rico'`, [ORG])).rows[0]!;
    assert.deepEqual(identity, { label: "Electricity - Puerto Rico", report_label: "Electricity - Puerto Rico",
      business_category: "Electricity Generation", legacy_original_id: "Puerto Rico", legacy_db_id: "10", source_family: "iea", created_by: "import:v7" });
    const value = (await db.query<{ kgco2e_per_unit: string; scopes: string[]; source_levels: string[]; legacy_db_id: string }>(
      `SELECT kgco2e_per_unit::text, scopes, source_levels, legacy_db_id FROM nzi_console.emission_factors
        WHERE organisation_id=$1 AND dataset_id='uk-ghg-gb-2025' AND factor_id='uk-ghg-10_100_1000_1_1-c'`, [ORG])).rows[0]!;
    assert.deepEqual(value, { kgco2e_per_unit: "0.2", scopes: ["3"], source_levels: ["Passenger vehicles", "Cars", "Average car"], legacy_db_id: "2" });
  });

  it("stores each dataset's provenance, licence and content hash", async () => {
    const dataset = (await db.query<{ status: string; country_code: string; source_family: string; legacy_dataset_id: string; licence: string; content_sha256: string }>(
      `SELECT status, country_code, source_family, legacy_dataset_id, licence, content_sha256
         FROM nzi_console.emission_factor_datasets WHERE organisation_id=$1 AND dataset_id='ceda-row-2025'`, [ORG])).rows[0]!;
    assert.equal(dataset.status, "active");
    assert.equal(dataset.country_code, "ROW");
    assert.equal(dataset.source_family, "ceda");
    assert.equal(dataset.legacy_dataset_id, "193");
    assert.match(dataset.licence, /^Source: CEDA 2025 \(Watershed\)\. Free public information/);
    assert.equal(dataset.content_sha256, plan.datasets.find((planned) => planned.datasetId === "ceda-row-2025")!.contentSha256);
  });

  it("changes nothing on a second run", async () => {
    const outcome = await loadV7Plan(database.pool, plan);
    assert.deepEqual(outcome, { datasetsInserted: 0, datasetsUnchanged: 8, identitiesInserted: 0, identitiesKept: plan.identities.length, factorsInserted: 0 });
    assert.deepEqual(await counts(), { datasets: 8, factors: 15, identities: plan.identities.length });
  });

  it("refuses a changed edition of a loaded dataset, and writes nothing", async () => {
    const changed: LoadPlan = { ...plan, datasets: plan.datasets.map((dataset) => dataset.datasetId === "ice-gb-2026" ? { ...dataset, contentSha256: "f".repeat(64) } : dataset) };
    await assert.rejects(() => loadV7Plan(database.pool, changed), (error) => error instanceof V7LoadRefused && /ice-gb-2026 is already loaded with different content/.test(error.message));
    assert.deepEqual(await counts(), { datasets: 8, factors: 15, identities: plan.identities.length });
  });

  it("writes nothing from a plan that carries a refusal", async () => {
    const refused: LoadPlan = { ...plan, refusals: [{ code: "edition-collision", message: "x", count: 1, examples: [] }] };
    await assert.rejects(() => loadV7Plan(database.pool, refused), (error) => error instanceof V7LoadRefused && /Nothing was written/.test(error.message));
  });

  it("refuses to load into an organisation that does not exist", async () => {
    await assert.rejects(() => loadV7Plan(database.pool, { ...plan, organisationId: "no-such-org" }),
      (error) => error instanceof V7LoadRefused && /does not exist; it is created by migration 0127/.test(error.message));
  });

  it("never auto-selects Rest of World for a job — ROW is not GLOBAL", async () => {
    // Ruled 25 Sep 2026: ROW is a no-country-match fallback, never attached beside a country match. Job creation selects
    // the job's own country and GLOBAL; ROW is neither.
    await db.query(`INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,'client-row','Co','active')`, [ORG]);
    await db.query(`INSERT INTO nzi_console.memberships (organisation_id,user_id,role_id,status) VALUES ($1,'admin-row','admin','active')`, [ORG]);
    const created = await createJob(database.pool, { clientId: "client-row", family: "crp", title: "FY2025", workflowStage: "Setup", owner: "A",
      startDate: "2026-01-01", dueDate: "2026-06-30", reportingPeriodStart: "2025-01-01", reportingPeriodEnd: "2025-12-31" } as never,
      { organisationId: ORG, actorId: "admin-row", principal: "staff", idempotencyKey: "row-job", correlationId: "row-job", grant: commandGrantForRole("admin", ORG, "admin-row") }) as { data: { jobId: string } };
    const selected = (await db.query<{ dataset_id: string }>(
      `SELECT dataset_id FROM nzi_console.job_dataset_selections WHERE organisation_id=$1 AND job_id=$2 ORDER BY 1`, [ORG, created.data.jobId])).rows.map((r) => r.dataset_id);
    assert.ok(selected.includes("uk-ghg-gb-2025"), `the job's own country was not selected: ${selected.join(", ")}`);
    assert.ok(!selected.includes("ceda-row-2025"), "Rest of World was auto-selected beside the job's own country");
  });

  it("is what an operator in the organisation sees through the display view, and only there", async () => {
    await db.query("BEGIN");
    try {
      await db.query("SET LOCAL ROLE nzi_console_app");
      await db.query(`SELECT set_config('app.organisation_id', $1, true)`, [ORG]);
      const seen = await db.query<{ label: string }>(
        `SELECT label FROM nzi_console.emission_factors_display WHERE dataset_id='iea-no-2025' AND factor_id='iea-norway'`);
      assert.deepEqual(seen.rows, [{ label: "Electricity - Norway" }]);
      await db.query(`SELECT set_config('app.organisation_id', 'demo-nzi-console', true)`);
      const other = await db.query(`SELECT 1 FROM nzi_console.emission_factors_display WHERE dataset_id='iea-no-2025'`);
      assert.equal(other.rows.length, 0, "another organisation can see net-zero-international's reference data");
    } finally { await db.query("ROLLBACK"); }
  });
});
