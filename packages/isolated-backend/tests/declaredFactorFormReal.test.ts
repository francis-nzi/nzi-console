import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { commandGrantForRole } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { calculateScopeRow, createScopeRow, previewDeclaredFactor, withTenantRead } from "../src/index";
import { listJobFactorOptions } from "../src/readModels";
// NZC-162: the inputs are built by the console's own code — the option builder, the preview mapping, the seed, the
// divergence check and the draft mapping — and driven to a calculated number. Imported across the package seam as
// a namespace, as the quick-add suite does.
import * as model from "../../../apps/console/app/jobs/emissionEntryModel";

const form = ((model as any).emissionEntryDraftToScopeRow ? model : (model as any).default) as typeof import("../../../apps/console/app/jobs/emissionEntryModel");

/**
 * The capture form's declared-factor preview and override reason, end to end (Stop 2b, form).
 *
 * What the form shows must be what the write commits, and the D2/H3 boundary must hold: the unit comes from the
 * declared factor and is shown before a quantity, and nothing rewrites a unit or factor a person chose. So each
 * case starts where the workspace starts — the job's real factor options from `listJobFactorOptions` — and runs
 * the form's own functions into `createScopeRow` and `calculateScopeRow`.
 */

const DATABASE_URL = TEST_DATABASE_URL;
const ORG = "demo-nzi-console";
const JOB = "job-2bform";
const ACTOR = "admin-2bform";
const here = dirname(fileURLToPath(import.meta.url));
const ELECTRICITY = { code: "2.purchased-electricity", name: "Purchased electricity", scope: "2", kind: "manual" } as never;
const GAS = { code: "1.natural-gas", name: "Natural gas", scope: "1", kind: "manual" } as never;

describe("the capture form shows the declared factor, and commits exactly what it shows (Stop 2b, form)", { skip: DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;
  let keys = 0;
  const context = () => {
    keys += 1;
    return { organisationId: ORG, actorId: ACTOR, principal: "staff" as const, idempotencyKey: `2bf-${keys}`,
      correlationId: `corr-2bf-${keys}`, grant: commandGrantForRole("admin", ORG, ACTOR) };
  };

  /** The workspace's options for a scope, built exactly as the workspace builds them. */
  const optionsFor = async (scope: "1" | "2" | "3") => {
    const sources = await withTenantRead(database.pool, ORG, (read) => listJobFactorOptions(read, JOB));
    return form.entryFactorRefsFor(sources as never).filter((option) => option.scope === scope);
  };
  /** The preview the workspace fetches, mapped as the workspace maps it. */
  const declaredFor = async (category: { code: string; scope: string }, options: Awaited<ReturnType<typeof optionsFor>>) => {
    const preview = await withTenantRead(database.pool, ORG, (read) => previewDeclaredFactor(read, ORG, JOB,
      { scope: form.categoryRowScope(category as never), unit: null, supplySource: null }, category.code));
    return form.declaredOptionFor(preview, options);
  };
  const blank = (over: Partial<import("../../../apps/console/app/jobs/emissionEntryModel").EmissionEntryDraft> = {}) => ({
    activity: "Meter", quantity: "", unit: "", vatPercent: "", glCode: "", spendCategoryId: "", registration: "",
    manualMode: false, manualDetail: "", factorId: "", qualityTier: "Measured", dataConfidence: "M — Medium",
    supplySource: "grid", factorOverrideReason: "", note: "", monthlyOpen: false, monthly: {}, ...over,
  });
  const save = async (draft: ReturnType<typeof blank>, category: never, options: Awaited<ReturnType<typeof optionsFor>>) => {
    const created = await createScopeRow(database.pool, { ...form.emissionEntryDraftToScopeRow(draft, category, { id: null, label: null }, options, []), jobId: JOB }, context());
    return (await db.query<{ scope_row_id: string; factor_id: string; unit: string; version: number; provenance_json: Record<string, any> }>(
      `SELECT scope_row_id, factor_id, unit, version, provenance_json FROM nzi_console.job_scope_rows WHERE scope_row_id=$1`, [created.data.rowId])).rows[0]!;
  };
  const calculated = async (row: { scope_row_id: string; version: number }) => {
    await calculateScopeRow(database.pool, { jobId: JOB, rowId: row.scope_row_id, expectedVersion: row.version }, context());
    return Number((await db.query<{ t: string }>(`SELECT calculated_tco2e::text AS t FROM nzi_console.job_scope_rows WHERE scope_row_id=$1`, [row.scope_row_id])).rows[0]!.t);
  };

  before(async () => {
    database = (await createDisposableDatabase("form2b"))!;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,$1)`, [ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
    await db.query(`INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,'client-2bf','Co','active')`, [ORG]);
    await db.query(
      `INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage,reporting_year,reporting_period_start,reporting_period_end)
       VALUES ($1,$2,'client-2bf',1,'crp','CRP','open','Data entry',2026,'2026-01-01','2026-12-31')`, [ORG, JOB]);
    await db.query(
      `INSERT INTO nzi_console.job_emissions_config (organisation_id,job_id,reporting_from,reporting_to,country_code)
       VALUES ($1,$2,'2026-01-01','2026-12-31','GB')`, [ORG, JOB]);
    await db.query(readFileSync(resolve(here, "../seeds/0003_synthetic_factors.sql"), "utf8"));
    await db.query(
      `INSERT INTO nzi_console.emission_factors (organisation_id,dataset_id,factor_id,label,activity_unit,kgco2e_per_unit,scopes)
       VALUES ($1,'synthetic-gb-2026','electricity-green-demo','Green supply — test factor','kWh',0.05,ARRAY['2'])`, [ORG]);
  });

  after(async () => { await db?.end(); await database?.end(); });

  it("opens an electricity entry on the declared factor, with its unit shown before any quantity", async () => {
    const options = await optionsFor("2");
    const declared = await declaredFor({ code: "2.purchased-electricity", scope: "2" }, options);
    assert.ok(declared, "the declared factor is not among the options the form offers");
    const seeded = form.seedWithDeclared(blank(), declared);
    assert.equal(seeded.factorId, declared.optionId);
    assert.equal(seeded.unit, "kWh", "the unit was not derived from the declared factor");
    assert.equal(seeded.quantity, "", "the preview is shown before a quantity, so none is needed to see it");
    assert.equal(form.needsOverrideReason(seeded, declared), false, "the declared factor asked for a reason");
  });

  it("commits exactly what it showed: the declared factor, matched, calculated to 0.3 t", async () => {
    const options = await optionsFor("2");
    const declared = await declaredFor({ code: "2.purchased-electricity", scope: "2" }, options);
    const row = await save({ ...form.seedWithDeclared(blank(), declared), quantity: "1000" }, ELECTRICITY, options);
    assert.equal(row.factor_id, declared!.factorId, "the write committed a different factor from the one shown");
    assert.equal(row.unit, "kWh");
    assert.equal(row.provenance_json.declarativeResolution.decision, "matched");
    assert.equal(await calculated(row), 0.3);
  });

  it("never rewrites a factor or a unit a person already chose", async () => {
    const options = await optionsFor("2");
    const declared = await declaredFor({ code: "2.purchased-electricity", scope: "2" }, options);
    const green = options.find((option) => option.factorId === "electricity-green-demo")!;
    const chosen = blank({ factorId: green.id, unit: "MWh" });
    assert.deepEqual(form.seedWithDeclared(chosen, declared), chosen, "the preview overwrote a choice somebody made");
  });

  it("asks why when the pick diverges, and the server refuses it without a reason", async () => {
    const options = await optionsFor("2");
    const declared = await declaredFor({ code: "2.purchased-electricity", scope: "2" }, options);
    const green = options.find((option) => option.factorId === "electricity-green-demo")!;
    const diverged = blank({ factorId: green.id, unit: "kWh", quantity: "1000" });
    assert.equal(form.needsOverrideReason(diverged, declared), true);
    await assert.rejects(() => save(diverged, ELECTRICITY, options),
      (error: any) => error.issues?.[0]?.code === "FACTOR_NOT_DECLARED");
  });

  it("records a deliberate choice with its reason and actor, and calculates it at its own factor", async () => {
    const options = await optionsFor("2");
    const green = options.find((option) => option.factorId === "electricity-green-demo")!;
    const row = await save(blank({ factorId: green.id, unit: "kWh", quantity: "1000",
      factorOverrideReason: "Supplier-specific factor from the client's contract" }), ELECTRICITY, options);
    const trail = row.provenance_json.declarativeResolution;
    assert.equal(trail.decision, "override");
    assert.equal(trail.overrideKind, "factor-choice");
    assert.equal(trail.overrideReason, "Supplier-specific factor from the client's contract");
    assert.equal(trail.deviatedBy, ACTOR);
    assert.equal(await calculated(row), 0.05);
  });

  it("shows nothing declared for a category that is off, and the form is exactly as it was", async () => {
    const options = await optionsFor("1");
    const declared = await declaredFor({ code: "1.natural-gas", scope: "1" }, options);
    assert.equal(declared, null);
    const gas = options.find((option) => option.factorId === "gas-demo")!;
    const draft = blank({ factorId: gas.id, unit: "kWh", quantity: "1000", supplySource: "" });
    assert.deepEqual(form.seedWithDeclared(draft, declared), draft);
    assert.equal(form.needsOverrideReason(draft, declared), false);
    const row = await save(draft, GAS, options);
    assert.equal("declarativeResolution" in row.provenance_json, false);
    assert.equal(await calculated(row), 0.18);
  });
});
