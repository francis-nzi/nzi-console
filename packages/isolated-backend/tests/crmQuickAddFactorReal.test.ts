import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { commandGrantForRole } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { calculateScopeRow, createScopeRow } from "../src/index";
// The seam this defect lived in is between the console's form and this package's command, so the test crosses
// it: the console's own option builder and mapping, into the real command. Imported as a namespace because the
// console module is loaded across a package boundary.
import * as model from "../../../apps/console/app/jobs/emissionEntryModel";

const { emissionEntryDraftToScopeRow, entryFactorRefsFor } = ((model as any).emissionEntryDraftToScopeRow ? model : (model as any).default) as typeof import("../../../apps/console/app/jobs/emissionEntryModel");

/**
 * A CRM quick-add entry with a picked factor can be calculated (found in Stop 2b).
 *
 * The form sent its option key — `dataset:<id>|<factor>` — as the factor id. The row was stored, the unit check
 * found no such factor and stood aside, and calculation refused it: NOT_SELECTED. Every quick-add with a picked
 * factor was an entry that could never be counted. Proved here as it happens — the console's own options and
 * mapping, the real command, a real calculation — with the old key kept as the case that must still be refused,
 * so the test can tell the two apart.
 */

const DATABASE_URL = TEST_DATABASE_URL;
const ORG = "demo-nzi-console";
const JOB = "job-quickadd";
const here = dirname(fileURLToPath(import.meta.url));

describe("a CRM quick-add entry stores the factor's own id, and calculates", { skip: DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;
  let keys = 0;
  const context = () => {
    keys += 1;
    return { organisationId: ORG, actorId: "admin-qa", principal: "staff" as const, idempotencyKey: `qa-${keys}`,
      correlationId: `corr-qa-${keys}`, grant: commandGrantForRole("admin", ORG, "admin-qa") };
  };
  const options = () => entryFactorRefsFor([{ factorSource: "dataset", datasetId: "synthetic-gb-2026", clientFactorId: null,
    factorId: "gas-demo", label: "Natural gas — demonstration factor", activityUnit: "kWh", synthetic: true, scopes: ["1"], datasetVersion: "2026 demo v1" }]);
  const quickAdd = (factorKey: string) => emissionEntryDraftToScopeRow({
    activity: "Boiler", quantity: "1000", unit: "kWh", vatPercent: "", glCode: "", spendCategoryId: "", registration: "",
    manualMode: false, manualDetail: "", factorId: factorKey, qualityTier: "Measured", dataConfidence: "M — Medium",
    supplySource: "", factorOverrideReason: "", note: "", monthlyOpen: false, monthly: {},
  }, { code: "1.natural-gas", name: "Natural gas", scope: "1", kind: "manual" } as never, { id: null, label: null }, options(), []);

  before(async () => {
    database = (await createDisposableDatabase("quickadd"))!;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,$1)`, [ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
    await db.query(`INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,'client-qa','Co','active')`, [ORG]);
    await db.query(
      `INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage,reporting_year,reporting_period_start,reporting_period_end)
       VALUES ($1,$2,'client-qa',1,'crp','CRP','open','Data entry',2026,'2026-01-01','2026-12-31')`, [ORG, JOB]);
    await db.query(
      `INSERT INTO nzi_console.job_emissions_config (organisation_id,job_id,reporting_from,reporting_to,country_code)
       VALUES ($1,$2,'2026-01-01','2026-12-31','GB')`, [ORG, JOB]);
    await db.query(readFileSync(resolve(here, "../seeds/0003_synthetic_factors.sql"), "utf8"));
  });

  after(async () => { await db?.end(); await database?.end(); });

  it("stores the factor's own id and calculates the entry", async () => {
    const input = quickAdd(options()[0]!.id);
    assert.equal(input.factorId, "gas-demo", "the form sent its option key as the factor");
    const created = await createScopeRow(database.pool, { ...input, jobId: JOB }, context());
    const row = (await db.query<{ factor_id: string; version: number }>(
      `SELECT factor_id, version FROM nzi_console.job_scope_rows WHERE scope_row_id=$1`, [created.data.rowId])).rows[0]!;
    assert.equal(row.factor_id, "gas-demo");
    await calculateScopeRow(database.pool, { jobId: JOB, rowId: created.data.rowId, expectedVersion: row.version }, context());
    const calculated = (await db.query<{ calculated_tco2e: string }>(
      `SELECT calculated_tco2e::text FROM nzi_console.job_scope_rows WHERE scope_row_id=$1`, [created.data.rowId])).rows[0]!;
    // 1000 kWh at 0.18 kg/kWh.
    assert.equal(Number(calculated.calculated_tco2e), 0.18);
  });

  it("saves and calculates an electricity quick-add with electricity switched on (0121), where the key was refused", async () => {
    // #290 enabled electricity ahead of this fix, and with the form sending its option key every electricity
    // quick-add with a picked factor was refused at save. Both halves, against the migrations as shipped.
    const refs = entryFactorRefsFor([{ factorSource: "dataset", datasetId: "synthetic-gb-2026", clientFactorId: null,
      factorId: "uk-ghg-7_400_4000_5_1", label: "UK electricity — demonstration factor", activityUnit: "kWh", synthetic: true, scopes: ["2"], datasetVersion: "2026 demo v1" }]);
    const input = emissionEntryDraftToScopeRow({
      activity: "Meter", quantity: "1000", unit: "kWh", vatPercent: "", glCode: "", spendCategoryId: "", registration: "",
      manualMode: false, manualDetail: "", factorId: refs[0]!.id, qualityTier: "Measured", dataConfidence: "M — Medium",
      supplySource: "grid", factorOverrideReason: "", note: "", monthlyOpen: false, monthly: {},
    }, { code: "2.purchased-electricity", name: "Purchased electricity", scope: "2", kind: "manual" } as never, { id: null, label: null }, refs, []);

    const created = await createScopeRow(database.pool, { ...input, jobId: JOB }, context());
    const row = (await db.query<{ factor_id: string; version: number; provenance_json: Record<string, any> }>(
      `SELECT factor_id, version, provenance_json FROM nzi_console.job_scope_rows WHERE scope_row_id=$1`, [created.data.rowId])).rows[0]!;
    assert.equal(row.factor_id, "uk-ghg-7_400_4000_5_1");
    assert.equal(row.provenance_json.declarativeResolution.decision, "matched", "the person's pick did not match the declared factor");
    await calculateScopeRow(database.pool, { jobId: JOB, rowId: created.data.rowId, expectedVersion: row.version }, context());
    const calculated = (await db.query<{ calculated_tco2e: string }>(
      `SELECT calculated_tco2e::text FROM nzi_console.job_scope_rows WHERE scope_row_id=$1`, [created.data.rowId])).rows[0]!;
    assert.equal(Number(calculated.calculated_tco2e), 0.3);

    await assert.rejects(() => createScopeRow(database.pool, { ...input, factorId: refs[0]!.id, jobId: JOB }, context()),
      (error: any) => error.issues?.[0]?.code === "FACTOR_NOT_VALID_FOR_ROW", "the option key was not refused with electricity on");
  });

  // JW-9 — the write's own line, whatever the form did: an entry needs a real factor of its own scope; a blank
  // quantity is a genuine draft and is kept.
  const entry = (over: Record<string, unknown>) => ({ ...quickAdd(options()[0]!.id), jobId: JOB, ...over });
  const rowsNow = async () => (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM nzi_console.job_scope_rows WHERE job_id=$1`, [JOB])).rows[0]!.n;

  it("refuses an entry with no factor — typed text that matched nothing — and stores nothing (JW-9)", async () => {
    const before = await rowsNow();
    await assert.rejects(() => createScopeRow(database.pool, entry({ sourceLabel: "gas", reportLabel: "gas", datasetId: null, factorId: null, factorVersion: null, factorLabel: null }) as never, context()),
      (error: any) => error.issues?.some((issue: any) => issue.code === "FACTOR_REQUIRED"));
    assert.equal(await rowsNow(), before);
  });

  it("refuses a factor from another scope on the entry (JW-9)", async () => {
    await assert.rejects(() => createScopeRow(database.pool, entry({ datasetId: "synthetic-gb-2026", factorId: "uk-ghg-13_402_4000_5_1", factorLabel: "T&D" }) as never, context()),
      (error: any) => error.issues?.some((issue: any) => issue.code === "FACTOR_NOT_IN_CATEGORY"));
  });

  it("keeps a draft: a real factor with the quantity left blank is stored (JW-9, as ruled)", async () => {
    const created = await createScopeRow(database.pool, entry({ quantity: null }) as never, context());
    const row = (await db.query<{ factor_id: string; quantity: string | null }>(`SELECT factor_id, quantity FROM nzi_console.job_scope_rows WHERE scope_row_id=$1`, [created.data.rowId])).rows[0]!;
    assert.deepEqual([row.factor_id, row.quantity], ["gas-demo", null]);
  });

  it("refuses the option key as a factor at the write — which is what every quick-add used to be (now refused before it is stored, JW-9)", async () => {
    // Before JW-9 the key was stored and only calculation refused it (NOT_SELECTED). An entry's factor is now checked
    // at create, so the key never reaches the table.
    const before = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM nzi_console.job_scope_rows WHERE job_id=$1`, [JOB])).rows[0]!.n;
    await assert.rejects(() => createScopeRow(database.pool, { ...quickAdd(options()[0]!.id), factorId: options()[0]!.id, jobId: JOB }, context()),
      (error: any) => error.issues?.some((issue: any) => issue.code === "FACTOR_NOT_SELECTED"));
    assert.equal((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM nzi_console.job_scope_rows WHERE job_id=$1`, [JOB])).rows[0]!.n, before, "nothing stored");
  });
});
