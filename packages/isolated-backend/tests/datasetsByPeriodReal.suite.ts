import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { commandGrantForRole, V7_REINGEST_ACTOR, type CommandContext } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { INTERNATIONAL_DEFAULT_LABEL, jobCountryNotes, registeredCountryCode } from "../src/datasetScope";
import { jobDatasetUpdates, ON_DAY_REASON, yearReason } from "../src/datasetSelection";
import { previewJobDatasetUpdate, updateJobDatasets } from "../src/jobDatasetUpdate";
import { calculateScopeRow, createJob, recalculateScopeRowInTransaction } from "../src/postgresCommands";
import { withTenantRead, withTenantWrite } from "../src/postgres";

/**
 * Datasets by period and site, increment 1 (DESIGN-datasets-by-period-and-site, ruled 25 Nov) against a real database:
 * selection per calendar year and per country (R1, R3, R4, D-A, D-D); pricing by month — monthly quantities across two
 * editions, the annual split (D-B), the previous system's basis for an imported row (D-B), the nearest edition (D-C), the
 * site's country (§2); a calendar-year job priced exactly as before (§3); the per-year update banner; and the acceptance
 * case, J000265 row 9278 = 15.3 (Apr–Dec 2025 at 0.177, Jan–Mar 2026 at 0.13096).
 */
describe("datasets by period and site", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  const ORG = "period-org";
  let database: DisposableDatabase;
  let keys = 0;
  const ctx = (reason?: string): CommandContext => {
    keys += 1;
    return { organisationId: ORG, actorId: "admin-dp", principal: "staff", idempotencyKey: `dp-${keys}`, correlationId: `corr-dp-${keys}`, grant: commandGrantForRole("admin", ORG, "admin-dp"), ...(reason ? { reason } : {}) };
  };
  const reingest = (): CommandContext => ({ organisationId: ORG, actorId: V7_REINGEST_ACTOR, principal: "system", idempotencyKey: `dp-ri-${++keys}`, correlationId: `corr-dp-ri-${keys}`, grant: commandGrantForRole("admin", ORG, V7_REINGEST_ACTOR) });
  const q = async (sql: string, params: unknown[] = []) => { const db = await database.admin(); try { return (await db.query(sql, params)).rows; } finally { await db.end(); } };
  const refusedWith = (code: string) => (error: any) => error.issues?.some((issue: any) => issue.code === code);
  const dataset = (id: string, year: number, country: string, source: string) => q(
    `INSERT INTO nzi_console.emission_factor_datasets (organisation_id, dataset_id, name, version, valid_from, valid_to, country_code, status, source_name, licence)
     VALUES ($1, $2, $2, $3, $4, $5, $6, 'active', $7, 'test')`, [ORG, id, `${id}#v`, `${year}-01-01`, `${year}-12-31`, country, source]);
  const factor = (datasetId: string, factorId: string, label: string, unit: string, kg: number | string, scope = "1") => q(
    `INSERT INTO nzi_console.emission_factors (organisation_id, dataset_id, factor_id, label, activity_unit, kgco2e_per_unit, scopes) VALUES ($1, $2, $3, $4, $5, $6, ARRAY[$7])`, [ORG, datasetId, factorId, label, unit, kg, scope]);
  const client = (id: string, country: string | null) => q(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status, registered_country) VALUES ($1, $2, $2, 'active', $3)`, [ORG, id, country]);
  const site = (id: string, clientId: string, country: string | null) => q(`INSERT INTO nzi_console.client_sites (organisation_id, client_id, site_id, name, created_by, country) VALUES ($1, $2, $3, $3, 'seed', $4)`, [ORG, clientId, id, country]);
  const job = async (clientId: string, from: string, to: string) => (await createJob(database.pool, { clientId, family: "crp", title: `CRP ${from}`, workflowStage: "Setup", owner: "Ada",
    startDate: from, dueDate: to, reportingPeriodStart: from, reportingPeriodEnd: to }, ctx())).data.jobId;
  const selections = (jobId: string) => q(`SELECT dataset_id, reason FROM nzi_console.job_dataset_selections WHERE job_id = $1 ORDER BY dataset_id`, [jobId]);
  const ids = async (jobId: string) => (await selections(jobId)).map((s) => s.dataset_id);
  const scopeRow = (jobId: string, id: string, cols: Record<string, unknown>) => {
    const fields = { organisation_id: ORG, scope_row_id: id, job_id: jobId, scope: "1", source_label: id, report_label: id, level_1: "Scope 1", level_2: "x", factor_source: "dataset", ...cols };
    const names = Object.keys(fields);
    return q(`INSERT INTO nzi_console.job_scope_rows (${names.join(",")}) VALUES (${names.map((_, i) => `$${i + 1}`).join(",")})`, Object.values(fields).map((v) => (Array.isArray(v) ? JSON.stringify(v) : v)));
  };
  const row = async (id: string) => (await q(`SELECT calculated_tco2e::text AS calc, version, provenance_json, lineage_json, dataset_id FROM nzi_console.job_scope_rows WHERE scope_row_id = $1`, [id]))[0];
  const calc = async (jobId: string, id: string) => { const r = await row(id); await calculateScopeRow(database.pool, { jobId, rowId: id, expectedVersion: r.version }, ctx()); return row(id); };
  const months = (from: string, values: number[]) => values.map((quantity, index) => {
    const start = new Date(`${from}-01T00:00:00Z`); start.setUTCMonth(start.getUTCMonth() + index);
    return { month: start.toISOString().slice(0, 7), quantity };
  });
  const lineageOf = (r: any) => (r.lineage_json as Array<{ title: string; detail: string }>);

  before(async () => {
    database = (await createDisposableDatabase("datasetsbyperiod"))!;
    await q(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $1)`, [ORG]);
    await q(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    await q(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name) VALUES ($1, 'admin-dp', 'admin', 'active', 'Ada')`, [ORG]);
    await q(`UPDATE nzi_console.emission_factor_datasets SET status = 'superseded' WHERE organisation_id = $1`, [ORG]);
    // GB: DESNZ and NZI 2024–2026 (no 2027); CEDA GB 2025. India and Spain: CEDA and IEA only (no activity series of their own).
    for (const year of [2024, 2025, 2026]) { await dataset(`uk-ghg-gb-${year}`, year, "GB", "DESNZ"); await dataset(`nzi-gb-${year}`, year, "GB", "NZI"); }
    await dataset("ceda-gb-2025", 2025, "GB", "CEDA"); await dataset("ceda-in-2025", 2025, "IN", "CEDA"); await dataset("iea-in-2025", 2025, "IN", "IEA");
    await dataset("ceda-es-2025", 2025, "ES", "CEDA"); await dataset("iea-es-2025", 2025, "ES", "IEA");
    await factor("uk-ghg-gb-2024", "uk-ghg-gas", "Natural gas", "kWh", "0.18");
    await factor("uk-ghg-gb-2025", "uk-ghg-gas", "Natural gas", "kWh", "0.183");
    await factor("uk-ghg-gb-2026", "uk-ghg-gas", "Natural gas", "kWh", "0.19");
    // J000265 row 9278's electricity: 2025 at 0.177, 2026 at 0.13096 (the previous system's own figures).
    await factor("uk-ghg-gb-2025", "uk-ghg-elec", "UK electricity - Electricity generated - Electricity: UK - kWh", "kWh", "0.177", "2");
    await factor("uk-ghg-gb-2026", "uk-ghg-elec", "UK electricity - Electricity generated - Electricity: UK - kWh", "kWh", "0.13096", "2");
    // D-C: a fuel DESNZ dropped in 2025.
    await factor("uk-ghg-gb-2024", "uk-ghg-coke", "Coke", "tonnes", "3000"); await factor("uk-ghg-gb-2026", "uk-ghg-coke", "Coke", "tonnes", "3100");
    await factor("iea-es-2025", "iea-es-elec", "Spain grid", "kWh", "0.12", "2");
    await client("c-gb", "United Kingdom"); await client("c-in", "India"); await client("c-in-uk", "India"); await client("c-none", null); await client("c-shire", "Aberdeenshire");
    await site("s-gb-null", "c-gb", null); await site("s-in-uk", "c-in-uk", "GB"); await site("s-in", "c-in", "IN"); await site("s-es", "c-gb", "ES");
  });
  after(async () => { await database?.end(); });

  describe("selection, per calendar year and per country", () => {
    it("May 2024 – Apr 2025, GB: DESNZ 2024 and 2025, NZI 2024 and 2025 — 2024's picked for its year, 2025 the reporting year's", async () => {
      const jobId = await job("c-gb", "2024-05-01", "2025-04-30");
      const picked = await selections(jobId);
      assert.deepEqual(picked.map((s) => s.dataset_id), ["ceda-es-2025", "ceda-gb-2025", "iea-es-2025", "nzi-gb-2024", "nzi-gb-2025", "uk-ghg-gb-2024", "uk-ghg-gb-2025"],
        "the client's included Spanish site brings its own country's series; GB is in scope");
      assert.equal(picked.find((s) => s.dataset_id === "uk-ghg-gb-2024")!.reason, yearReason(2024));
      assert.equal(picked.find((s) => s.dataset_id === "uk-ghg-gb-2025")!.reason, ON_DAY_REASON);
    });

    it("a calendar-2024 job: 2024 only, exactly as before", async () => {
      await q(`UPDATE nzi_console.client_sites SET country = NULL WHERE site_id = 's-es'`);
      const jobId = await job("c-gb", "2024-01-01", "2024-12-31");
      assert.deepEqual(await ids(jobId), ["nzi-gb-2024", "uk-ghg-gb-2024"]);
      assert.ok((await selections(jobId)).every((s) => s.reason === ON_DAY_REASON));
      await q(`UPDATE nzi_console.client_sites SET country = 'ES' WHERE site_id = 's-es'`);
    });

    it("an Indian client with a UK site: India's CEDA and IEA, and GB's series", async () => {
      const jobId = await job("c-in-uk", "2025-01-01", "2025-12-31");
      assert.deepEqual(await ids(jobId), ["ceda-gb-2025", "ceda-in-2025", "iea-in-2025", "nzi-gb-2025", "uk-ghg-gb-2025"]);
      assert.equal((await q(`SELECT country_code FROM nzi_console.job_emissions_config WHERE job_id = $1`, [jobId]))[0].country_code, "IN", "R4: the client's country, not a fixed GB");
    });

    it("an Indian client without one: India's own, plus DESNZ as the international default — no NZI, no CEDA GB (D-A)", async () => {
      const jobId = await job("c-in", "2025-01-01", "2025-12-31");
      const picked = await selections(jobId);
      assert.deepEqual(picked.map((s) => s.dataset_id), ["ceda-in-2025", "iea-in-2025", "uk-ghg-gb-2025"]);
      assert.ok(picked.find((s) => s.dataset_id === "uk-ghg-gb-2025")!.reason.startsWith(`${INTERNATIONAL_DEFAULT_LABEL}. `), "labelled in the job");
      const notes = await withTenantRead(database.pool, ORG, (db) => jobCountryNotes(db, ORG, jobId));
      assert.ok(notes.some((note) => note.startsWith(INTERNATIONAL_DEFAULT_LABEL)));
    });

    it("a site with no country counts as the job's, and the job says so (R3); a client with no country, or one that isn't a country, is GB, assumed and flagged (D-D)", async () => {
      const gb = await job("c-gb", "2025-01-01", "2025-12-31");
      const notes = await withTenantRead(database.pool, ORG, (db) => jobCountryNotes(db, ORG, gb));
      assert.ok(notes.includes("1 site has no country: counted as GB."), notes.join(" | "));
      for (const clientId of ["c-none", "c-shire"]) {
        const jobId = await job(clientId, "2025-01-01", "2025-12-31");
        assert.equal((await q(`SELECT country_code FROM nzi_console.job_emissions_config WHERE job_id = $1`, [jobId]))[0].country_code, "GB");
        const flagged = await withTenantRead(database.pool, ORG, (db) => jobCountryNotes(db, ORG, jobId));
        assert.ok(flagged.some((note) => note.startsWith("The client's country isn't recorded") && note.endsWith("GB assumed.")), flagged.join(" | "));
      }
      assert.deepEqual(["Scotland", "Wales", "United Kingdom", "USA", "Ireland", "Aberdeenshire", "", null].map(registeredCountryCode), ["GB", "GB", "GB", "US", "IE", null, null, null]);
    });

    it("an unpublished year: the latest published, with the fallback's reason", async () => {
      const jobId = await job("c-in", "2026-07-01", "2027-06-30");
      const picked = await selections(jobId);
      assert.deepEqual(picked.map((s) => s.dataset_id), ["ceda-in-2025", "iea-in-2025", "uk-ghg-gb-2026"], "2027 isn't published: 2026 serves both years, CEDA and IEA fall back to 2025");
      assert.match(picked.find((s) => s.dataset_id === "iea-in-2025")!.reason, /latest available \(2025\)/);
    });
  });

  describe("pricing by month", () => {
    let spanning = "";
    before(async () => {
      await q(`UPDATE nzi_console.client_sites SET country = NULL WHERE site_id = 's-es'`);
      spanning = await job("c-gb", "2025-04-01", "2026-03-31");
    });

    it("J000265 row 9278 = 15.3: Apr–Dec 2025 at 0.177, Jan–Mar 2026 at 0.13096, the lineage naming the yearly parts", async () => {
      // The previous system's spans and blended factor (0.15674) fix the row's months: 6,076 kWh a month in Apr–Dec,
      // 14,324 in Jan–Mar — 97,656 kWh, which at its own 0.177 alone is the 17.3 the old port showed.
      const elec = [...Array(9).fill(6076), ...Array(3).fill(14324)];
      await scopeRow(spanning, "r9278", { scope: "2", level_1: "Scope 2", dataset_id: "uk-ghg-gb-2025", factor_id: "uk-ghg-elec", quantity: 97656, unit: "kWh", monthly_activity_json: months("2025-04", elec) });
      const priced = await calc(spanning, "r9278");
      assert.equal(Number(priced.calc).toFixed(1), "15.3");
      assert.equal(Number(priced.calc), 15.30668112, "(54,684 × 0.177 + 42,972 × 0.13096) ÷ 1000, exactly");
      assert.equal(Math.round(Number(priced.calc) * 1000 / 97656 * 1e5) / 1e5, 0.15674, "the previous system's blended factor");
      assert.ok(lineageOf(priced).some((line) => line.title === "Priced by month" && line.detail === "9 months @ DESNZ GB 2025 (0.177) · 3 @ DESNZ GB 2026 (0.13096)"), JSON.stringify(lineageOf(priced)));
      assert.deepEqual((priced.provenance_json.spans as any[]).map((span) => [span.from, span.to, span.months, span.datasetId]),
        [["2025-04", "2025-12", 9, "uk-ghg-gb-2025"], ["2026-01", "2026-03", 3, "uk-ghg-gb-2026"]]);
      assert.equal(priced.provenance_json.pricingBasis, "monthly");
    });

    it("an annual quantity on a console row is split equally over the months (D-B): 9/12 at 2025, 3/12 at 2026", async () => {
      await scopeRow(spanning, "annual", { dataset_id: "uk-ghg-gb-2025", factor_id: "uk-ghg-gas", quantity: 1200, unit: "kWh", apply_pct: 50 });
      const priced = await calc(spanning, "annual");
      assert.equal(Number(priced.calc), 0.11085, "(900 × 0.183 + 300 × 0.19) ÷ 1000 × 50%");
      assert.ok(lineageOf(priced).some((line) => line.title === "Annual quantity split by month" && /12 months/.test(line.detail)));
      assert.equal(priced.provenance_json.pricingBasis, "annual-split");
    });

    it("an imported annual-only row keeps the previous system's one price, at its own edition (D-B), and says so", async () => {
      await scopeRow(spanning, "v7-row-1", { quantity: 1200, unit: "kWh", calculated_tco2e: 0.2196, enabled: false, origin: "migrated", source_system: "nzi-pro-v7", legacy_db_id: "1",
        migrated_record: { qty: 1200, uom: "kWh", factor: 0.183, ghg_unit: "kg", original_id: "g", reported_tco2e: 0.2196, data_source: "manual", enabled: true } });
      await scopeRow(spanning, "imported", { dataset_id: "uk-ghg-gb-2025", factor_id: "uk-ghg-gas", quantity: 1200, unit: "kWh", reingested_from_row_id: "v7-row-1" });
      const r = await row("imported");
      await withTenantWrite(database.pool, ORG, (db) => recalculateScopeRowInTransaction(db, { jobId: spanning, rowId: "imported", expectedVersion: r.version }, reingest()));
      const priced = await row("imported");
      assert.equal(Number(priced.calc), 1200 * 0.183 / 1000);
      assert.ok(lineageOf(priced).some((line) => line.title === "Priced as the previous system prices it"));
      assert.equal(priced.provenance_json.pricingBasis, "previous-system");
    });

    it("a month whose edition lacks the factor is priced at the nearest edition that has it, and flagged (D-C)", async () => {
      const jobId = await job("c-gb", "2024-07-01", "2025-06-30");
      await scopeRow(jobId, "coke", { dataset_id: "uk-ghg-gb-2024", factor_id: "uk-ghg-coke", quantity: 12, unit: "tonnes", monthly_activity_json: months("2024-07", Array(12).fill(1)) });
      const priced = await calc(jobId, "coke");
      assert.equal(Number(priced.calc), 12 * 3000 / 1000, "2025 has no coke: its months priced at 2024, the nearer of 2024 and 2026 (the row's own breaks the tie)");
      const flag = lineageOf(priced).find((line) => line.title === "Priced at the nearest edition");
      assert.equal(flag?.detail, "Jan 2025–Jun 2025 priced at DESNZ GB 2024: not in DESNZ GB 2025");
    });

    it("a row on a site in another country is priced from that country's factors: DESNZ for its activity, never UK electricity (§2, D-A)", async () => {
      await q(`UPDATE nzi_console.client_sites SET country = 'ES' WHERE site_id = 's-es'`);
      const jobId = await job("c-gb", "2025-01-01", "2025-12-31");
      await scopeRow(jobId, "es-gas", { dataset_id: "uk-ghg-gb-2025", factor_id: "uk-ghg-gas", quantity: 100, unit: "kWh", site_id: "s-es" });
      assert.equal(Number((await calc(jobId, "es-gas")).calc), 100 * 0.183 / 1000, "Spain has no activity series of its own: DESNZ is the default");
      await scopeRow(jobId, "es-elec", { scope: "2", level_1: "Scope 2", dataset_id: "uk-ghg-gb-2025", factor_id: "uk-ghg-elec", quantity: 100, unit: "kWh", site_id: "s-es" });
      await assert.rejects(() => calc(jobId, "es-elec"), refusedWith("FACTOR_COUNTRY_MISMATCH"));
      await scopeRow(jobId, "es-grid", { scope: "2", level_1: "Scope 2", dataset_id: "iea-es-2025", factor_id: "iea-es-elec", quantity: 100, unit: "kWh", site_id: "s-es" });
      assert.equal(Number((await calc(jobId, "es-grid")).calc), 100 * 0.12 / 1000);
      await scopeRow(jobId, "gb-grid", { scope: "2", level_1: "Scope 2", dataset_id: "iea-es-2025", factor_id: "iea-es-elec", quantity: 100, unit: "kWh", site_id: "s-gb-null" });
      await assert.rejects(() => calc(jobId, "gb-grid"), refusedWith("FACTOR_COUNTRY_MISMATCH"), "a UK site is never priced on Spain's grid");
    });
  });

  describe("a calendar-year job is priced exactly as before (§3)", () => {
    it("every row shape recalculates to exactly the single product it was priced at — numeric equality, per row and per scope", async () => {
      await q(`UPDATE nzi_console.client_sites SET country = NULL WHERE site_id = 's-es'`);
      const jobId = await job("c-gb", "2025-01-01", "2025-12-31");
      const shapes: Array<[string, Record<string, unknown>]> = [
        ["plain", { quantity: "1234.5678", unit: "kWh", factor_id: "uk-ghg-gas" }],
        ["monthly", { quantity: "120.3", unit: "kWh", factor_id: "uk-ghg-gas", monthly_activity_json: months("2025-01", [10.1, 10.1, 10.1, 10, 10, 10, 10, 10, 10, 10, 10, 10]) }],
        ["apportioned", { quantity: "999.99", unit: "kWh", factor_id: "uk-ghg-gas", apply_pct: "33.333" }],
        ["elec", { scope: "2", level_1: "Scope 2", quantity: "0.000123", unit: "kWh", factor_id: "uk-ghg-elec" }],
      ];
      for (const [id, cols] of shapes) {
        await scopeRow(jobId, `same-${id}`, { dataset_id: "uk-ghg-gb-2025", ...cols });
        await calc(jobId, `same-${id}`);
      }
      const check = await q(
        `SELECT r.scope_row_id, r.calculated_tco2e::text AS calc, (r.quantity * f.kgco2e_per_unit / 1000 * r.apply_pct / 100)::text AS before
           FROM nzi_console.job_scope_rows r JOIN nzi_console.emission_factors f ON (f.organisation_id, f.dataset_id, f.factor_id) = (r.organisation_id, r.dataset_id, r.factor_id)
          WHERE r.job_id = $1 ORDER BY r.scope_row_id`, [jobId]);
      assert.equal(check.length, shapes.length);
      for (const line of check) assert.equal(line.calc, line.before, `${line.scope_row_id}: the single product, digit for digit`);
      for (const id of ["same-plain", "same-monthly"]) assert.ok(!lineageOf(await row(id)).some((line) => /Priced by month|split/.test(line.title)), "nothing new in the lineage");
    });
  });

  describe("the update banner, per year", () => {
    it("a spanning job falling back for its later year is offered that year's edition, added beside the earlier year's — never swapped", async () => {
      // A 2026–27 job: 2027 isn't published, so 2026 serves both years. Then 2027 is published.
      const jobId = await job("c-in-uk", "2026-04-01", "2027-03-31");
      await scopeRow(jobId, "gas-2627", { dataset_id: "uk-ghg-gb-2026", factor_id: "uk-ghg-gas", quantity: 1200, unit: "kWh" });
      await calc(jobId, "gas-2627");
      assert.equal(Number((await row("gas-2627")).calc), 1200 * 0.19 / 1000, "one edition serves both years: one price");
      await dataset("uk-ghg-gb-2027", 2027, "GB", "DESNZ"); await factor("uk-ghg-gb-2027", "uk-ghg-gas", "Natural gas", "kWh", "0.2");
      const updates = await withTenantRead(database.pool, ORG, (db) => jobDatasetUpdates(db, ORG, jobId));
      const desnz = updates.find((u) => u.fromDatasetId === "uk-ghg-gb-2026")!;
      assert.deepEqual([desnz.toDatasetId, desnz.years, desnz.keepFrom], ["uk-ghg-gb-2027", [2027], true]);
      const preview = await previewJobDatasetUpdate(database.pool, { jobId, series: ["uk-ghg-gb-2026"], resolutions: [] }, ctx());
      const expected = preview.series.flatMap((s) => s.moved.map((m) => ({ rowId: m.rowId, version: s.versions[m.rowId]! })));
      await updateJobDatasets(database.pool, { jobId, series: ["uk-ghg-gb-2026"], expected, resolutions: [] }, ctx());
      assert.ok((await ids(jobId)).includes("uk-ghg-gb-2026") && (await ids(jobId)).includes("uk-ghg-gb-2027"), "added beside, never swapped");
      const priced = await row("gas-2627");
      assert.equal(priced.dataset_id, "uk-ghg-gb-2026", "the row keeps its own edition");
      assert.equal(Number(priced.calc), (900 * 0.19 + 300 * 0.2) / 1000, "Apr–Dec 2026 at 2026, Jan–Mar 2027 at 2027");
      assert.equal((await withTenantRead(database.pool, ORG, (db) => jobDatasetUpdates(db, ORG, jobId))).filter((u) => u.fromDatasetId === "uk-ghg-gb-2026").length, 0, "nothing left to offer");
    });
  });
});
