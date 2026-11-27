import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { commandGrantForRole, type CommandContext } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { jobCountryNotes, NO_NATIONAL_SPEND_LABEL } from "../src/datasetScope";
import { listCategoryVariants } from "../src/factorCategoryVariants";
import { factorCountryIssue } from "../src/monthlyPricing";
import { addManualDataset, calculateScopeRow, createJob } from "../src/postgresCommands";
import { withTenantRead } from "../src/postgres";
import { parseCsv, planV7Load, type ExtractRow, type LoadPlan } from "../src/v7ReferenceImport";
import { loadV7Plan, plannedSupersessions, V7LoadRefused, WATERSHED_SOURCE } from "../src/v7ReferenceLoad";

/**
 * The library matches V7 (BRIEF-library-cornerstone-activity-spend Part 2, DESIGN ruled 27 Nov), on a database built by every
 * migration, 0242 included, in the real operating organisation:
 * - 0242: one V7 factor row backs a value row in each dataset, still once within one;
 * - the load: Cornerstone as `ceda` editions (L-1) and the UAE's Activity & Spend as AE (L-5), Watershed superseded in the same
 *   transaction, every set of it (L-2, L-3), one audit event per run; a re-load changes nothing; the final release is a new
 *   edition beside the old, which is superseded; the same release re-cut is refused;
 * - what superseding blocks: new selection and a manual add (DATASET_NOT_ACTIVE), never a row or a snapshot already on it;
 * - selection on J000663's shape (UK, Poland, India, Dubai, Singapore, Spain; Apr 2025 – Mar 2026);
 * - a row in INR priced as V7 prices it (local spend × the local factor, to 1 dp), and across two Cornerstone years by month;
 * - L-3: a country with no spend series of its own is flagged; L-5: the AE electricity switch.
 * Synthetic extracts (NZC-020): `fixtures/v7-library-*-synthetic.csv`.
 */
const ORG = "net-zero-international";
const here = dirname(fileURLToPath(import.meta.url));
const extract = (name: string) => parseCsv(readFileSync(resolve(here, `fixtures/${name}`), "utf8"));
const WATERSHED = extract("v7-library-watershed-synthetic.csv");
const CORNERSTONE_RC = extract("v7-library-cornerstone-synthetic.csv");
/** The final release, as V7 re-runs it: the same datasets and db_ids, a new source and name, one value revised. */
const CORNERSTONE_FINAL: ExtractRow[] = CORNERSTONE_RC.filter((row) => (row.source ?? "").startsWith("Cornerstone")).map((row) => ({
  ...row, source: "Cornerstone EEIO 2026", dataset_name: (row.dataset_name ?? "").replace("2026-rc", "2026"),
  factor: row.db_id === "8002" ? "0.0075" : row.factor ?? "",
}));
const IND_2025_RC = 0.007268628736385697;
const IND_2026_RC = 0.0053470217089081375;

describe("the library matches V7: Cornerstone, the UAE's Activity & Spend, CEDA 2025 (Watershed) superseded", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let keys = 0;
  const ctx = (reason?: string): CommandContext => {
    keys += 1;
    return { organisationId: ORG, actorId: "admin-lib", principal: "staff", idempotencyKey: `lib-${keys}`, correlationId: `corr-lib-${keys}`,
      grant: commandGrantForRole("admin", ORG, "admin-lib"), ...(reason ? { reason } : {}) };
  };
  const q = async (sql: string, params: unknown[] = []) => { const db = await database.admin(); try { return (await db.query(sql, params)).rows; } finally { await db.end(); } };
  const planOf = async (rows: readonly ExtractRow[]) => { const db = await database.admin(); try { return planV7Load(rows, await listCategoryVariants(db)); } finally { await db.end(); } };
  const status = async (id: string) => (await q(`SELECT status FROM nzi_console.emission_factor_datasets WHERE organisation_id = $1 AND dataset_id = $2`, [ORG, id]))[0]?.status;
  const refusedWith = (code: string) => (error: any) => error.issues?.some((issue: any) => issue.code === code);
  const dataset = (id: string, year: number, country: string, source: string) => q(
    `INSERT INTO nzi_console.emission_factor_datasets (organisation_id, dataset_id, name, version, valid_from, valid_to, country_code, status, source_name, licence)
     VALUES ($1, $2, $2, $3, $4, $5, $6, 'active', $7, 'test')`, [ORG, id, `${id}#v`, `${year}-01-01`, `${year}-12-31`, country, source]);
  const factor = (datasetId: string, factorId: string, label: string, unit: string, kg: string, scope: string) => q(
    `INSERT INTO nzi_console.emission_factors (organisation_id, dataset_id, factor_id, label, activity_unit, kgco2e_per_unit, scopes) VALUES ($1, $2, $3, $4, $5, $6, ARRAY[$7])`,
    [ORG, datasetId, factorId, label, unit, kg, scope]);
  const client = (id: string, country: string) => q(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status, registered_country) VALUES ($1, $2, $2, 'active', $3)`, [ORG, id, country]);
  const site = (id: string, clientId: string, country: string | null) => q(`INSERT INTO nzi_console.client_sites (organisation_id, client_id, site_id, name, created_by, country) VALUES ($1, $2, $3, $3, 'seed', $4)`, [ORG, clientId, id, country]);
  const job = async (clientId: string, from: string, to: string) => (await createJob(database.pool, { clientId, family: "crp", title: `CRP ${from}`, workflowStage: "Setup", owner: "Ada",
    startDate: from, dueDate: to, reportingPeriodStart: from, reportingPeriodEnd: to }, ctx())).data.jobId;
  const selected = async (jobId: string) => (await q(`SELECT dataset_id FROM nzi_console.job_dataset_selections WHERE organisation_id = $1 AND job_id = $2 ORDER BY 1`, [ORG, jobId])).map((row) => row.dataset_id as string);
  const scopeRow = (jobId: string, id: string, cols: Record<string, unknown>) => {
    const fields = { organisation_id: ORG, scope_row_id: id, job_id: jobId, scope: "3.1", source_label: id, report_label: id, level_1: "Scope 3", level_2: "x", factor_source: "dataset", ...cols };
    const names = Object.keys(fields);
    return q(`INSERT INTO nzi_console.job_scope_rows (${names.join(",")}) VALUES (${names.map((_, i) => `$${i + 1}`).join(",")})`, Object.values(fields).map((v) => (Array.isArray(v) ? JSON.stringify(v) : v)));
  };
  const row = async (id: string) => (await q(`SELECT calculated_tco2e::text AS calc, version, dataset_id, lineage_json FROM nzi_console.job_scope_rows WHERE scope_row_id = $1`, [id]))[0];
  const calc = async (jobId: string, id: string) => { const before = await row(id); await calculateScopeRow(database.pool, { jobId, rowId: id, expectedVersion: before.version }, ctx()); return row(id); };
  const auditRuns = async () => Number((await q(`SELECT count(*) AS n FROM nzi_console.audit_events WHERE organisation_id = $1 AND action = 'reference.library.loaded'`, [ORG]))[0].n);
  const issue = (jobId: string, siteId: string, datasetId: string, factorId: string, factorLabel: string, scopes: string[]) =>
    withTenantRead(database.pool, ORG, (db) => factorCountryIssue(db, ORG, { jobId, siteId, datasetId, factorId, factorLabel, scopes }));

  let indianJob = "";
  let snapshotBefore: unknown;

  before(async () => {
    database = (await createDisposableDatabase("librarycornerstone"))!;
    await q(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name) VALUES ($1, 'admin-lib', 'admin', 'active', 'Ada')`, [ORG]);
    // Today's library, in miniature: Watershed as the 25 Sep load holds it; DESNZ GB, NZI GB and IEA seeded directly.
    const watershed = await planOf(WATERSHED);
    assert.deepEqual(watershed.refusals, []);
    await loadV7Plan(database.pool, watershed);
    for (const year of [2025, 2026]) { await dataset(`uk-ghg-gb-${year}`, year, "GB", "DESNZ"); await dataset(`nzi-gb-${year}`, year, "GB", "NZI"); }
    await factor("uk-ghg-gb-2025", "uk-ghg-gas", "Natural gas", "kWh", "0.183", "1");
    for (const country of ["IN", "PL", "SG", "ES", "AE"]) await dataset(`iea-${country.toLowerCase()}-2025`, 2025, country, "IEA 2025");
    await client("c-in", "India"); await client("c-eff", "United Kingdom"); await client("c-ke", "Kenya");
    for (const [id, country] of [["s-uk", "GB"], ["s-pl", "PL"], ["s-in", "IN"], ["s-ae", "AE"], ["s-sg", "SG"], ["s-es", "ES"]] as const) await site(id, "c-eff", country);
    // A job priced on Watershed before the switch: its row, and a snapshot citing it, must not move.
    indianJob = await job("c-in", "2025-01-01", "2025-12-31");
    assert.ok((await selected(indianJob)).includes("ceda-in-2025"), "before the load, Watershed India is the Indian job's spend series");
    await scopeRow(indianJob, "r-watershed", { dataset_id: "ceda-in-2025", factor_id: "ceda-1111A0", quantity: 1000000, unit: "INR" });
    await calc(indianJob, "r-watershed");
    const payload = { rows: [{ rowId: "r-watershed", datasetId: "ceda-in-2025", factorId: "ceda-1111A0", tco2e: "8.1" }] };
    await q(`INSERT INTO nzi_console.reviewed_crp_snapshots (organisation_id, snapshot_id, job_id, snapshot_version, job_version, data_hash, payload_json, created_by)
             VALUES ($1, 'snap-watershed', $2, 1, 1, $3, $4::jsonb, 'admin-lib')`,
      [ORG, indianJob, `sha256:${createHash("sha256").update(JSON.stringify(payload)).digest("hex")}`, JSON.stringify(payload)]);
    snapshotBefore = (await q(`SELECT data_hash, payload_json FROM nzi_console.reviewed_crp_snapshots WHERE organisation_id = $1 AND snapshot_id = 'snap-watershed'`, [ORG]))[0];
  });
  after(async () => { await database?.end(); });

  it("0242: one V7 factor row may back a value row in each dataset, and still only one within a dataset", async () => {
    await dataset("m242-a-2025", 2025, "GB", "Test"); await dataset("m242-b-2025", 2025, "GB", "Test");
    await q(`UPDATE nzi_console.emission_factor_datasets SET source_family = 'm242' WHERE organisation_id = $1 AND dataset_id LIKE 'm242-%'`, [ORG]);
    for (const [factorId, original] of [["m242-x", "X"], ["m242-y", "Y"]]) await q(
      `INSERT INTO nzi_console.factor_identities (organisation_id, factor_id, label, source_label, source_system, source_family, legacy_original_id, legacy_db_id, created_by)
       VALUES ($1, $2, 'x', 'x', 'm242-test', 'm242', $3, '424242', 'seed')`, [ORG, factorId, original]);
    const insert = (datasetId: string, factorId: string, original: string) => q(
      `INSERT INTO nzi_console.emission_factors (organisation_id, dataset_id, factor_id, label, activity_unit, kgco2e_per_unit, scopes, source_system, legacy_original_id, legacy_db_id)
       VALUES ($1, $2, $3, 'x', 'kWh', 1, ARRAY['1'], 'm242-test', $4, '424242')`, [ORG, datasetId, factorId, original]);
    await insert("m242-a-2025", "m242-x", "X");
    await insert("m242-b-2025", "m242-x", "X");
    await assert.rejects(() => insert("m242-a-2025", "m242-y", "Y"), /emission_factors_legacy_db_key/);
  });

  describe("the release candidate's load", () => {
    let plan: LoadPlan;
    before(async () => { plan = await planOf(CORNERSTONE_RC); assert.deepEqual(plan.refusals, []); });

    it("the dry run shows exactly what the load supersedes: every Watershed set, by its successor or by none", async () => {
      const preview = await withTenantRead(database.pool, ORG, (db) => plannedSupersessions(db, plan));
      assert.deepEqual(preview.map((entry) => [entry.datasetId, entry.why, entry.by]), [
        ["ceda-ae-2025", "watershed", null], ["ceda-es-2025", "watershed", "ceda-es-2025-edition-2026-rc"], ["ceda-gb-2025", "watershed", null],
        ["ceda-in-2025", "watershed", "ceda-in-2025-edition-2026-rc"], ["ceda-pl-2025", "watershed", "ceda-pl-2025-edition-2026-rc"], ["ceda-row-2025", "watershed", null]]);
      assert.equal(await status("ceda-in-2025"), "active", "a preview writes nothing");
    });

    it("writes the editions and the UAE sets, supersedes Watershed in the same transaction, and records the run once", async () => {
      const outcome = await loadV7Plan(database.pool, plan);
      assert.equal(outcome.datasetsInserted, 11);
      assert.equal(outcome.datasetsSuperseded, 6);
      for (const id of ["ceda-in-2025", "ceda-gb-2025", "ceda-ae-2025", "ceda-row-2025", "ceda-es-2025", "ceda-pl-2025"]) assert.equal(await status(id), "superseded", id);
      for (const id of ["ceda-in-2025-edition-2026-rc", "uk-ghg-ae-2025", "uk-ghg-ae-2026"]) assert.equal(await status(id), "active", id);
      assert.equal((await q(`SELECT count(*) AS n FROM nzi_console.emission_factor_datasets WHERE organisation_id = $1 AND source_name = $2 AND status = 'active'`, [ORG, WATERSHED_SOURCE]))[0].n, "0");
      const audit = (await q(`SELECT after_json FROM nzi_console.audit_events WHERE organisation_id = $1 AND action = 'reference.library.loaded' ORDER BY occurred_at DESC LIMIT 1`, [ORG]))[0].after_json;
      assert.equal(audit.outcome.datasetsSuperseded, 6);
      assert.equal(audit.inserted.length, 11);
      assert.ok(audit.inserted.some((entry: any) => entry.datasetId === "ceda-in-2025-edition-2026-rc" && entry.legacyDatasetId === "402" && entry.version === "2026-rc"));
    });

    it("never moves a row or a snapshot already on Watershed: the row recalculates to the same figure, the snapshot is byte-for-byte as it was", async () => {
      const before = await row("r-watershed");
      const after = await calc(indianJob, "r-watershed");
      assert.equal(after.calc, before.calc);
      assert.equal(after.dataset_id, "ceda-in-2025");
      assert.ok((await selected(indianJob)).includes("ceda-in-2025"), "the selection a row cites stays");
      assert.deepEqual((await q(`SELECT data_hash, payload_json FROM nzi_console.reviewed_crp_snapshots WHERE organisation_id = $1 AND snapshot_id = 'snap-watershed'`, [ORG]))[0], snapshotBefore);
    });

    it("a superseded dataset can't be newly added to a job (DATASET_NOT_ACTIVE); its Cornerstone successor can", async () => {
      const fresh = await job("c-in", "2025-01-01", "2025-12-31");
      await assert.rejects(() => addManualDataset(database.pool, { jobId: fresh, scope: "all", datasetId: "ceda-gb-2025", reportingFrom: "2025-01-01", reportingTo: "2025-12-31" }, ctx("Old habit")),
        refusedWith("DATASET_NOT_ACTIVE"));
      assert.ok(!(await selected(fresh)).some((id) => id.startsWith("ceda-") && !id.includes("-edition-")), "no Watershed set is selected automatically any more");
      assert.ok((await selected(fresh)).includes("ceda-in-2025-edition-2026-rc"));
    });

    it("J000663's shape: UK spend on UK A&S, India by year on Cornerstone IND, Dubai on the UAE's A&S, Poland's activity on DESNZ — and no Watershed", async () => {
      const eff = await job("c-eff", "2025-04-01", "2026-03-31");
      const ids = await selected(eff);
      for (const id of ["uk-ghg-gb-2025", "uk-ghg-gb-2026", "nzi-gb-2025", "nzi-gb-2026",
        "ceda-in-2025-edition-2026-rc", "ceda-in-2026-edition-2026-rc", "ceda-pl-2025-edition-2026-rc", "ceda-pl-2026-edition-2026-rc",
        "ceda-sg-2025-edition-2026-rc", "ceda-sg-2026-edition-2026-rc", "ceda-es-2025-edition-2026-rc", "ceda-es-2026-edition-2026-rc",
        "uk-ghg-ae-2025", "uk-ghg-ae-2026", "iea-in-2025", "iea-pl-2025", "iea-sg-2025", "iea-es-2025", "iea-ae-2025"]) assert.ok(ids.includes(id), `${id} is not selected: ${ids.join(", ")}`);
      assert.deepEqual(ids.filter((id) => /^ceda-[a-z]+-2025$/.test(id) || id.startsWith("ceda-gb") || id.startsWith("ceda-ae") || id.startsWith("ceda-row")), [],
        "no Watershed, no CEDA GB, AE or ROW: the UK and the UAE price spend on their own series");
      assert.equal(await issue(eff, "s-pl", "uk-ghg-gb-2025", "uk-ghg-gas", "Natural gas", ["1"]), null, "Poland's activity: DESNZ, under D-A");
      assert.equal(await issue(eff, "s-in", "ceda-in-2025-edition-2026-rc", "ceda-CEDA-IND-1111A0", "Oilseed farming - India", ["3"]), null, "India's spend: Cornerstone IND");
      assert.equal(await issue(eff, "s-ae", "uk-ghg-ae-2025", "uk-ghg-SPEND-SIC-49.3-5", "Land transport services", ["3"]), null, "Dubai's spend: the UAE's A&S");
      assert.match((await issue(eff, "s-in", "ceda-pl-2025-edition-2026-rc", "ceda-CEDA-POL-1111A0", "Oilseed farming - Poland", ["3"]))!, /the row is for IN/, "never another country's");
    });

    it("an INR row is priced as V7 prices it: local spend × the local factor, no FX — and across Cornerstone's years by month", async () => {
      const calendar = await job("c-in", "2025-01-01", "2025-12-31");
      await scopeRow(calendar, "r-inr", { dataset_id: "ceda-in-2025-edition-2026-rc", factor_id: "ceda-CEDA-IND-1111A0", quantity: 1000000, unit: "INR" });
      const priced = await calc(calendar, "r-inr");
      const v7 = 1000000 * IND_2025_RC / 1000;
      assert.equal(Number(priced.calc).toFixed(1), v7.toFixed(1));
      assert.ok(Math.abs(Number(priced.calc) - v7) < 1e-9, `${priced.calc} vs V7's ${v7}`);

      const spanning = await job("c-in", "2025-04-01", "2026-03-31");
      const months = Array.from({ length: 12 }, (_, index) => ({ month: `${index < 9 ? 2025 : 2026}-${String(((index + 3) % 12) + 1).padStart(2, "0")}`, quantity: 100000 }));
      await scopeRow(spanning, "r-inr-months", { dataset_id: "ceda-in-2025-edition-2026-rc", factor_id: "ceda-CEDA-IND-1111A0", quantity: 1200000, unit: "INR", monthly_activity_json: months });
      const byMonth = await calc(spanning, "r-inr-months");
      const expected = (9 * 100000 * IND_2025_RC + 3 * 100000 * IND_2026_RC) / 1000;
      assert.ok(Math.abs(Number(byMonth.calc) - expected) < 1e-9, `${byMonth.calc} vs ${expected}: 9 months @ 2025, 3 @ 2026`);
      assert.ok((byMonth.lineage_json as Array<{ detail: string }>).some((step) => /9 months @ .*2025.* · 3 @ .*2026/.test(step.detail)));
    });

    it("L-3: a country with no spend series of its own is flagged; one with Cornerstone, or the UK's and UAE's own, is not", async () => {
      const kenya = await job("c-ke", "2025-01-01", "2025-12-31");
      const notes = await withTenantRead(database.pool, ORG, (db) => jobCountryNotes(db, ORG, kenya));
      assert.ok(notes.includes(`${NO_NATIONAL_SPEND_LABEL} for KE: spend rows there aren't priced.`), notes.join(" | "));
      const eff = await job("c-eff", "2025-01-01", "2025-12-31");
      const effNotes = await withTenantRead(database.pool, ORG, (db) => jobCountryNotes(db, ORG, eff));
      assert.ok(!effNotes.some((note) => note.startsWith(NO_NATIONAL_SPEND_LABEL)), effNotes.join(" | "));
    });

    it("L-5 (ruled): AE grid electricity always takes IEA AE — the UAE A&S's grid lines are refused; its spend and activity are not", async () => {
      const eff = await job("c-eff", "2026-01-01", "2026-12-31");
      assert.match((await issue(eff, "s-ae", "uk-ghg-ae-2026", "uk-ghg-7_400_4000_5_1", "UK electricity - Electricity generated - Electricity: UK - kWh", ["2"]))!, /IEA AE/);
      assert.equal(await issue(eff, "s-ae", "uk-ghg-ae-2026", "uk-ghg-SPEND-SIC-49.3-5", "Land transport services", ["3"]), null, "spend");
      assert.equal(await issue(eff, "s-ae", "uk-ghg-ae-2026", "uk-ghg-10_100_1000_1_1", "Passenger vehicles - Cars - Average car - Diesel", ["1"]), null, "activity");
      assert.equal(await issue(eff, "s-ae", "iea-ae-2025", "iea-ae-elec", "United Arab Emirates grid", ["2"]), null, "IEA AE serves AE electricity");
    });

    it("a re-load changes nothing but its own record", async () => {
      const runs = await auditRuns();
      const outcome = await loadV7Plan(database.pool, plan);
      assert.equal(outcome.datasetsInserted, 0);
      assert.equal(outcome.datasetsUnchanged, 11);
      assert.equal(outcome.datasetsSuperseded, 0);
      assert.equal(outcome.factorsInserted, 0);
      assert.equal(await auditRuns(), runs + 1, "one audit event per run");
    });
  });

  describe("the final release", () => {
    it("is a new edition beside the candidate, which is superseded; rows on the candidate keep it, new jobs take the final", async () => {
      const final = await planOf(CORNERSTONE_FINAL);
      assert.deepEqual(final.refusals, []);
      const onCandidate = await row("r-inr");
      const outcome = await loadV7Plan(database.pool, final);
      assert.equal(outcome.datasetsInserted, 9);
      assert.equal(outcome.datasetsSuperseded, 9);
      assert.equal(await status("ceda-in-2025-edition-2026-rc"), "superseded");
      assert.equal(await status("ceda-in-2025-edition-2026"), "active");
      assert.equal(await status("uk-ghg-ae-2025"), "active", "a Cornerstone release never supersedes another series");
      assert.deepEqual((await q(`SELECT kgco2e_per_unit::text AS kg, legacy_db_id FROM nzi_console.emission_factors WHERE organisation_id = $1 AND dataset_id = 'ceda-in-2025-edition-2026' AND factor_id = 'ceda-CEDA-IND-1111A0'`, [ORG]))[0],
        { kg: "0.0075", legacy_db_id: "8002" }, "the revised value, on V7's same db_id (0242)");
      const recalculated = await calc((await q(`SELECT job_id FROM nzi_console.job_scope_rows WHERE scope_row_id = 'r-inr'`))[0].job_id, "r-inr");
      assert.deepEqual([recalculated.dataset_id, recalculated.calc], [onCandidate.dataset_id, onCandidate.calc], "a row on the candidate keeps it");
      const fresh = await job("c-in", "2025-01-01", "2025-12-31");
      const ids = await selected(fresh);
      assert.ok(ids.includes("ceda-in-2025-edition-2026") && !ids.includes("ceda-in-2025-edition-2026-rc"), ids.join(", "));
    });

    it("the same release re-cut with different content is refused, and writes nothing", async () => {
      const recut = await planOf(CORNERSTONE_FINAL.map((row) => (row.db_id === "8011" ? { ...row, factor: "0.21" } : row)));
      const runs = await auditRuns();
      await assert.rejects(() => loadV7Plan(database.pool, recut), (error) => error instanceof V7LoadRefused && /ceda-pl-2025-edition-2026 is already loaded with different content/.test(error.message));
      assert.equal(await auditRuns(), runs);
    });
  });
});
