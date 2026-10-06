import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { commandGrantForRole, type CommandContext } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { jobDatasetUpdates } from "../src/datasetSelection";
import { previewJobDatasetUpdate, updateJobDatasets } from "../src/jobDatasetUpdate";
import { calculateScopeRow, createJob } from "../src/postgresCommands";
import { listJobEmissionSourceRegister } from "../src/readModels";
import { withTenantRead } from "../src/postgres";

/**
 * DATASET-CURRENCY §3 (ruled 6 Oct) against a real database: the banner's read (a fallback edition whose series' own year is
 * now published); the preview — the write's own code, rolled back — with moved, blocked and untouched rows; a series that
 * moves whole, only once each blocked row is resolved; the swap, never an add; rows recalculated by the one calculation,
 * review back to pending, overrides kept; one audit event; preview == write; a reason when figures were issued; and
 * FACTOR_VERSION_MOVED pairing editions by series, not by their imported name.
 */
describe("job.datasets.update: move to the reporting year's edition, previewed then confirmed", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  const ORG = "currency-org";
  let database: DisposableDatabase;
  let keys = 0;
  let jobId = "";
  const ctx = (reason?: string, key?: string): CommandContext => {
    keys += 1;
    return { organisationId: ORG, actorId: "admin-cu", principal: "staff", idempotencyKey: key ?? `cu-${keys}`, correlationId: `corr-cu-${keys}`, grant: commandGrantForRole("admin", ORG, "admin-cu"), ...(reason ? { reason } : {}) };
  };
  const q = async (sql: string, params: unknown[] = []) => { const db = await database.admin(); try { return (await db.query(sql, params)).rows; } finally { await db.end(); } };
  const refusedWith = (code: string) => (error: any) => error.issues?.some((issue: any) => issue.code === code);
  const row = (id: string) => q(`SELECT dataset_id, factor_id, factor_version, calculated_tco2e::float8 AS calc, override_tco2e::float8 AS override, review_status, enabled, version, lineage_json FROM nzi_console.job_scope_rows WHERE scope_row_id = $1`, [id]).then((r) => r[0]);
  const selections = () => q(`SELECT dataset_id, selection_source FROM nzi_console.job_dataset_selections WHERE job_id = $1 ORDER BY dataset_id`, [jobId]).then((r) => r.map((s) => `${s.dataset_id}:${s.selection_source}`));
  const dataset = (id: string, year: number, name: string, source: string) => q(
    `INSERT INTO nzi_console.emission_factor_datasets (organisation_id, dataset_id, name, version, valid_from, valid_to, country_code, status, source_name, licence)
     VALUES ($1, $2, $3, $4, $5, $6, 'GB', 'active', $7, 'test')`, [ORG, id, name, `${name}#${year}`, `${year}-01-01`, `${year}-12-31`, source]);
  const factor = (datasetId: string, factorId: string, label: string, unit: string, kg: number, scope = "1") => q(
    `INSERT INTO nzi_console.emission_factors (organisation_id, dataset_id, factor_id, label, activity_unit, kgco2e_per_unit, scopes) VALUES ($1, $2, $3, $4, $5, $6, ARRAY[$7])`, [ORG, datasetId, factorId, label, unit, kg, scope]);
  const scopeRow = (id: string, cols: Record<string, unknown>) => {
    const fields = { organisation_id: ORG, scope_row_id: id, job_id: jobId, scope: "1", source_label: id, report_label: id, level_1: "Scope 1", level_2: "x", factor_source: "dataset", ...cols };
    const names = Object.keys(fields);
    return q(`INSERT INTO nzi_console.job_scope_rows (${names.join(",")}) VALUES (${names.map((_, i) => `$${i + 1}`).join(",")})`, Object.values(fields));
  };
  const calc = async (id: string) => { const r = await row(id); await calculateScopeRow(database.pool, { jobId, rowId: id, expectedVersion: r.version }, ctx()); };
  const preview = (series: string[], resolutions: any[] = []) => previewJobDatasetUpdate(database.pool, { jobId, series, resolutions }, ctx());

  before(async () => {
    database = (await createDisposableDatabase("datasetupdate"))!;
    await q(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $1)`, [ORG]);
    await q(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    await q(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name) VALUES ($1, 'admin-cu', 'admin', 'active', 'Ada')`, [ORG]);
    await q(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status) VALUES ($1, 'c1', 'Alpha', 'active')`, [ORG]);
    await q(`UPDATE nzi_console.emission_factor_datasets SET status = 'superseded' WHERE organisation_id = $1`, [ORG]);
    // 2026 editions only: a 2026–27 job falls back to them.
    await dataset("uk-ghg-gb-2026", 2026, "upload-a.csv", "DESNZ"); await dataset("nzi-gb-2026", 2026, "upload-b.csv", "NZI");
    await factor("uk-ghg-gb-2026", "uk-ghg-gas", "Natural gas", "kWh", 0.2); await factor("uk-ghg-gb-2026", "uk-ghg-elec", "Grid electricity", "kWh", 0.3, "2");
    await factor("uk-ghg-gb-2026", "uk-ghg-gone", "Retired fuel", "kWh", 0.5); await factor("uk-ghg-gb-2026", "uk-ghg-oil", "Fuel oil", "litres", 2.5);
    await factor("nzi-gb-2026", "nzi-x", "NZI gas", "kWh", 0.21);
    jobId = (await createJob(database.pool, { clientId: "c1", family: "crp", title: "CRP", workflowStage: "Setup", owner: "Ada", startDate: "2026-04-01", dueDate: "2027-09-30",
      reportingPeriodStart: "2026-04-01", reportingPeriodEnd: "2027-03-31" }, ctx())).data.jobId;
    const ds = (id: string) => ({ dataset_id: "uk-ghg-gb-2026", factor_id: id });
    await scopeRow("gas", { ...ds("uk-ghg-gas"), quantity: 1000, unit: "kWh" }); await calc("gas");
    await q(`UPDATE nzi_console.job_scope_rows SET review_status = 'approved', reviewed_by = 'rev', reviewed_at = now(), reviewed_row_version = version WHERE scope_row_id = 'gas'`);
    await scopeRow("elec", { ...ds("uk-ghg-elec"), scope: "2", level_1: "Scope 2", quantity: 500, unit: "kWh" }); await calc("elec");
    await q(`UPDATE nzi_console.job_scope_rows SET override_tco2e = 9, override_reason = 'supplier statement' WHERE scope_row_id = 'elec'`);
    await scopeRow("gone", { ...ds("uk-ghg-gone"), quantity: 10, unit: "kWh" }); await calc("gone");
    await scopeRow("oil", { ...ds("uk-ghg-oil"), quantity: 5, unit: "litres" }); await calc("oil");
    await scopeRow("draft", { ...ds("uk-ghg-gas") });
    // v7 history on the replaced edition: immutable, never moved.
    await scopeRow("v7-hist", { ...ds("uk-ghg-gas"), quantity: 7, unit: "kWh", calculated_tco2e: 1, origin: "migrated", source_system: "nzi-pro-v7", legacy_db_id: "h1",
      migrated_record: { qty: 7, uom: "kWh", factor: 1, ghg_unit: "kg", original_id: "f", reported_tco2e: 1, data_source: "manual", enabled: true } });
    await q(`INSERT INTO nzi_console.client_factors (organisation_id, client_factor_id, client_id, scope, report_label, unit, kgco2e_per_unit, vintage_year, created_by) VALUES ($1, 'cf', 'c1', '1', 'EPD', 'kWh', 0.1, 2025, 't')`, [ORG]);
    await scopeRow("client", { factor_source: "client", client_factor_id: "cf", is_custom_entry: true, factor_id: "cf", quantity: 3, unit: "kWh" });
    await q(`INSERT INTO nzi_console.job_emission_sources (organisation_id, source_id, job_id, scope, source_name, dataset_id, factor_id, factor_source) VALUES ($1, 'src-1', $2, '1', 'Boiler', 'nzi-gb-2026', 'nzi-x', 'dataset')`, [ORG, jobId]);
    await scopeRow("sourced", { dataset_id: "nzi-gb-2026", factor_id: "nzi-x", source_id: "src-1", quantity: 100, unit: "kWh" });
    // Then 2027 is published: gas and electricity re-priced; "gone" dropped; oil now in kWh, with a litres fuel beside it.
    await dataset("uk-ghg-gb-2027", 2027, "upload-c.csv", "DESNZ"); await dataset("nzi-gb-2027", 2027, "upload-d.csv", "NZI");
    await factor("uk-ghg-gb-2027", "uk-ghg-gas", "Natural gas", "kWh", 0.18); await factor("uk-ghg-gb-2027", "uk-ghg-elec", "Grid electricity", "kWh", 0.25, "2");
    await factor("uk-ghg-gb-2027", "uk-ghg-oil", "Fuel oil", "kWh", 0.25); await factor("uk-ghg-gb-2027", "uk-ghg-oil-l", "Fuel oil (litres)", "litres", 2.4);
    await factor("nzi-gb-2027", "nzi-x", "NZI gas", "kWh", 0.19);
  });
  after(async () => { await database?.end(); });

  it("the banner's read: each fallback edition whose series' own year is now published — DESNZ first, labelled", async () => {
    assert.deepEqual(await selections(), ["nzi-gb-2026:automatic", "uk-ghg-gb-2026:automatic"], "the job fell back to 2026 at create");
    const updates = await withTenantRead(database.pool, ORG, (db) => jobDatasetUpdates(db, ORG, jobId));
    assert.deepEqual(updates.map((u) => [u.fromDatasetId, u.toDatasetId, u.fromLabel, u.toLabel]), [
      ["uk-ghg-gb-2026", "uk-ghg-gb-2027", "DESNZ GB 2026", "DESNZ GB 2027"], ["nzi-gb-2026", "nzi-gb-2027", "NZI GB 2026", "NZI GB 2027"]]);
  });

  it("an automatic selection that is already its reporting year's edition is never offered an update, even beside another upload of that year", async () => {
    await dataset("uk-ghg-gb-2027-original", 2027, "upload-e.csv", "DESNZ");
    const onDayJob = (await createJob(database.pool, { clientId: "c1", family: "crp", title: "CRP 2027", workflowStage: "Setup", owner: "Ada", startDate: "2027-01-01", dueDate: "2027-12-31",
      reportingPeriodStart: "2027-01-01", reportingPeriodEnd: "2027-12-31" }, ctx())).data.jobId;
    // The job holds the year's other upload, automatically — on the day, not a fallback.
    await q(`UPDATE nzi_console.job_dataset_selections SET dataset_id = 'uk-ghg-gb-2027-original' WHERE job_id = $1 AND dataset_id = 'uk-ghg-gb-2027'`, [onDayJob]);
    const updates = await withTenantRead(database.pool, ORG, (db) => jobDatasetUpdates(db, ORG, onDayJob));
    assert.deepEqual(updates, [], "an on-day edition is the reporting year's own — there is nothing newer to move to");
    await q(`UPDATE nzi_console.emission_factor_datasets SET status = 'superseded' WHERE dataset_id = 'uk-ghg-gb-2027-original'`);
  });

  it("FACTOR_VERSION_MOVED pairs editions by series, not by their imported name", async () => {
    await q(`INSERT INTO nzi_console.job_dataset_selections (organisation_id, job_id, dataset_id, selection_source, reason, selected_by) VALUES ($1, $2, 'nzi-gb-2027', 'manual', 't', 't')`, [ORG, jobId]);
    const register = await withTenantRead(database.pool, ORG, (db) => listJobEmissionSourceRegister(db, jobId));
    assert.equal(register.sources.find((s) => s.id === "src-1")!.factorVersionMoved, true, "nzi-gb-2026 → nzi-gb-2027, though named upload-b.csv and upload-d.csv");
    await q(`DELETE FROM nzi_console.job_dataset_selections WHERE job_id = $1 AND dataset_id = 'nzi-gb-2027'`, [jobId]);
  });

  it("the preview lists what moves, what is blocked and why, and what is left — and writes nothing", async () => {
    const before = await row("gas");
    const p = await preview(["uk-ghg-gb-2026", "nzi-gb-2026"]);
    const desnz = p.series.find((s) => s.fromDatasetId === "uk-ghg-gb-2026")!, nzi = p.series.find((s) => s.fromDatasetId === "nzi-gb-2026")!;
    assert.deepEqual(desnz.moved.map((r) => [r.rowId, r.recalculated]).sort(), [["draft", false], ["elec", true], ["gas", true]]);
    assert.deepEqual(desnz.blocked.map((r) => [r.rowId, r.reason]).sort(), [["gone", "FACTOR_MISSING"], ["oil", "UNIT_CHANGED"]]);
    assert.deepEqual(desnz.blocked.find((r) => r.rowId === "oil")!.candidates.map((c) => c.factorId), ["uk-ghg-oil-l"], "a factor of the row's own unit and scope in the new edition");
    assert.deepEqual(nzi.blocked.map((r) => [r.rowId, r.reason]), [["sourced", "SOURCE_MANAGED"]], "a register-managed row blocks its series (ruling 7)");
    assert.deepEqual(p.untouched, { migrated: 1, clientFactor: 1 });
    assert.equal(p.totals.afterTco2e, p.totals.beforeTco2e, "a blocked series is not applied, so nothing moves the total");
    assert.deepEqual(await row("gas"), before, "the preview wrote nothing");
    assert.deepEqual(await selections(), ["nzi-gb-2026:automatic", "uk-ghg-gb-2026:automatic"]);
  });

  it("a write is refused while a requested series is blocked", async () => {
    await assert.rejects(() => updateJobDatasets(database.pool, { jobId, series: ["uk-ghg-gb-2026"], expected: [], resolutions: [] }, ctx()), refusedWith("SERIES_BLOCKED"));
  });

  it("resolved, the series moves whole: swapped, rows re-pointed and recalculated, review reset, the override kept — preview == write, one audit event", async () => {
    const resolutions = [{ rowId: "gone", action: "deactivate" as const }, { rowId: "oil", action: "factor" as const, factorId: "uk-ghg-oil-l" }];
    const p = await preview(["uk-ghg-gb-2026"], resolutions);
    const plan = p.series[0]!;
    assert.deepEqual(plan.blocked, []);
    assert.deepEqual(plan.deactivated, ["gone"]);
    const expected = [...plan.moved.map((r) => r.rowId), ...plan.deactivated].map((rowId) => ({ rowId, version: plan.versions[rowId]! }));
    const stale = expected.map((e) => e.rowId === "gas" ? { ...e, version: e.version + 1 } : e);
    await assert.rejects(() => updateJobDatasets(database.pool, { jobId, series: ["uk-ghg-gb-2026"], expected: stale, resolutions }, ctx()), refusedWith("CHANGED_SINCE_PREVIEW"));
    const done = await updateJobDatasets(database.pool, { jobId, series: ["uk-ghg-gb-2026"], expected, resolutions }, ctx(undefined, "cu-move"));
    assert.deepEqual(done.data.totals, p.totals, "the write's totals are the preview's");
    assert.deepEqual([done.data.moved, done.data.recalculated, done.data.approvedReset, done.data.overridesKept, done.data.deactivated], [4, 3, 1, 1, 1]);
    assert.deepEqual(await selections(), ["nzi-gb-2026:automatic", "uk-ghg-gb-2027:automatic"], "swapped, never added beside; NZI not requested, not moved");
    const gas = await row("gas");
    assert.deepEqual([gas.dataset_id, gas.calc, gas.review_status], ["uk-ghg-gb-2027", 0.18, "pending"], "1000 kWh × 0.18 ÷ 1000; approved → pending");
    assert.ok(JSON.stringify(gas.lineage_json).includes("Moved to a newer edition"), "the lineage names the move");
    const elec = await row("elec");
    assert.deepEqual([elec.calc, elec.override], [0.125, 9], "the calculated figure refreshed, the override kept");
    assert.deepEqual([(await row("oil")).factor_id, (await row("oil")).calc], ["uk-ghg-oil-l", 0.012], "resolved to the litres fuel in 2027");
    assert.equal((await row("gone")).enabled, false, "deactivated, never left on a de-selected edition");
    const draft = await row("draft");
    assert.deepEqual([draft.dataset_id, draft.calc], ["uk-ghg-gb-2027", null], "a draft is re-pointed, with no figure to compute");
    assert.equal((await row("client")).dataset_id, null, "a client-factor row is left alone");
    assert.equal((await row("v7-hist")).dataset_id, "uk-ghg-gb-2026", "v7 history stays on the edition it was imported with");
    const audit = await q(`SELECT action, after_json FROM nzi_console.audit_events WHERE correlation_id = $1`, [done.correlationId]);
    assert.deepEqual(audit.map((a) => a.action), ["job_datasets_updated"], "one audit event for the run — no per-row events");
    assert.ok(!JSON.stringify(audit[0].after_json).includes("supplier statement"), "no row text in the payload");
    const replay = await updateJobDatasets(database.pool, { jobId, series: ["uk-ghg-gb-2026"], expected, resolutions }, ctx(undefined, "cu-move"));
    assert.equal(replay.replayed, true, "idempotent on its key");
    await assert.rejects(() => updateJobDatasets(database.pool, { jobId, series: ["uk-ghg-gb-2026"], expected, resolutions }, ctx()), refusedWith("NOTHING_TO_UPDATE"));
    assert.deepEqual((await withTenantRead(database.pool, ORG, (db) => jobDatasetUpdates(db, ORG, jobId))).map((u) => u.fromDatasetId), ["nzi-gb-2026"], "the banner now offers NZI only");
  });

  it("a job with issued figures moves only with a reason, and the issued snapshot is left as it was", async () => {
    await q(`UPDATE nzi_console.job_scope_rows SET source_id = NULL WHERE scope_row_id = 'sourced'`);   // unblock NZI for this test
    await q(`INSERT INTO nzi_console.reviewed_crp_snapshots (organisation_id, snapshot_id, job_id, snapshot_version, job_version, data_hash, payload_json, created_by)
             VALUES ($1, 'snap-1', $2, 1, 1, $3, '{"rows":[]}'::jsonb, 'ada')`, [ORG, jobId, `sha256:${"a".repeat(64)}`]);
    const p = await preview(["nzi-gb-2026"]);
    assert.equal(p.issued, true);
    const expected = p.series[0]!.moved.map((r) => ({ rowId: r.rowId, version: r.version }));
    await assert.rejects(() => updateJobDatasets(database.pool, { jobId, series: ["nzi-gb-2026"], expected, resolutions: [] }, ctx()), refusedWith("REASON_REQUIRED"));
    const done = await updateJobDatasets(database.pool, { jobId, series: ["nzi-gb-2026"], expected, resolutions: [] }, ctx("2027 factors published; re-issue to follow"));
    assert.equal(done.data.issued, true);
    assert.equal((await q(`SELECT reason FROM nzi_console.audit_events WHERE correlation_id = $1`, [done.correlationId]))[0].reason, "2027 factors published; re-issue to follow");
    assert.deepEqual((await q(`SELECT payload_json FROM nzi_console.reviewed_crp_snapshots WHERE snapshot_id = 'snap-1'`))[0].payload_json, { rows: [] }, "the issued snapshot is untouched");
  });
});
