import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { commandGrantForRole, type StaffRole } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import {
  confirmSpendAllocationSuggestion, createScopeRow, createSpendAllocation, dismissSpendAllocationSuggestion, generateSpendSuggestion, listClientSpendAllocations,
  reallocateScopeRow, recordSpendAllocationSuggestion, spendSuggestionRequest, withTenantRead, type SpendSuggestionModel,
} from "../src/index";

/**
 * Data entry D2 (R5) against Postgres: an AI suggestion for a spend line the client's map does not know is asked with the line's
 * GL code and normalised description only, grounded, stored labelled and pending, and audited by reference; it never writes the
 * map — a person's confirmation (or a move at review that uses it) does, as `suggestion-confirmed`. The model is a fake here:
 * the adapter is tested on its own, and no key is needed.
 */
const ORG = "demo-nzi-console";
const CLIENT = "client-d2ai";
const CLIENT_NAME = "Brindlewood Pottery Ltd";
const JOB = "job-d2ai";
const STAFF = "staff-d2ai";
const DS = "d2ai-dataset";

describe("Data entry D2 (R5): AI suggestions for the unmapped — labelled, never applied, confirmed by a person", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;
  let keys = 0;
  const prompts: Array<{ system: string; user: string }> = [];
  const fake = (body: unknown): SpendSuggestionModel => ({ id: "claude-sonnet-5", async suggest(prompt) { prompts.push(prompt); return { kind: "reply", body }; } });
  const context = (role: StaffRole = "admin") => {
    keys += 1;
    return { organisationId: ORG, actorId: STAFF, principal: "staff" as const, idempotencyKey: `d2ai-${keys}`, correlationId: `corr-d2ai-${keys}`, grant: commandGrantForRole(role, ORG, STAFF) };
  };
  const mapEntries = () => withTenantRead(database.pool, ORG, (tx) => listClientSpendAllocations(tx, ORG, CLIENT));
  const ask = async (line: { glCode?: string | null; description?: string | null }, body: unknown) => {
    const request = await withTenantRead(database.pool, ORG, (tx) => spendSuggestionRequest(tx, ORG, JOB, line));
    const run = await generateSpendSuggestion(fake(body), request.input);
    if (!run.suggestion) return { request, run, recorded: null };
    const recorded = await recordSpendAllocationSuggestion(database.pool, { jobId: JOB, keyKind: request.key.kind, key: request.key.display,
      categoryCode: run.suggestion.categoryCode, reason: run.suggestion.reason, model: run.model, promptSha256: run.promptSha256 }, context());
    return { request, run, recorded };
  };

  before(async () => {
    database = (await createDisposableDatabase("dataentryd2ai"))!;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $1)`, [ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
    await db.query(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status) VALUES ($1, $2, $3, 'active')`, [ORG, CLIENT, CLIENT_NAME]);
    await db.query(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status) VALUES ($1, $2, 'admin', 'active')`, [ORG, STAFF]);
    await db.query(
      `INSERT INTO nzi_console.jobs (organisation_id, job_id, client_id, sequence, job_family, title, status, workflow_stage, reporting_year, reporting_period_start, reporting_period_end)
       VALUES ($1, $2, $3, 1, 'crp', 'CRP', 'open', 'Data entry', 2026, '2026-01-01', '2026-12-31')`, [ORG, JOB, CLIENT]);
    await db.query(`INSERT INTO nzi_console.job_emissions_config (organisation_id, job_id, reporting_from, reporting_to, country_code) VALUES ($1, $2, '2026-01-01', '2026-12-31', 'GB')`, [ORG, JOB]);
    await db.query(
      `INSERT INTO nzi_console.emission_factor_datasets (organisation_id, dataset_id, name, version, valid_from, valid_to, country_code, status, source_name, licence)
       VALUES ($1, $2, 'D2 AI test factors', 'd2ai', '2026-01-01', '2026-12-31', 'GB', 'active', 'Test', 'Test only')`, [ORG, DS]);
    await db.query(`INSERT INTO nzi_console.emission_factors (organisation_id, dataset_id, factor_id, label, activity_unit, kgco2e_per_unit, scopes) VALUES ($1, $2, 'd2ai-spend', 'Services — spend (test)', 'GBP', 0.3, ARRAY['3'])`, [ORG, DS]);
    await db.query(`INSERT INTO nzi_console.job_dataset_selections (organisation_id, job_id, dataset_id, selection_source, reason, selected_by) VALUES ($1, $2, $3, 'manual', 'Test', 'test')`, [ORG, JOB, DS]);
  });
  after(async () => { await db?.end(); await database?.end(); });

  it("the boundary: the model is told the GL code, the normalised description and the taxonomy — never the client, a figure or the amount", async () => {
    const { run } = await ask({ glCode: "6100", description: `${CLIENT_NAME} travel agency invoice #4471 £1,250.00` }, { categoryCode: "3.6", reason: "Travel agency spend is business travel." });
    const sent = prompts.at(-1)!;
    assert.ok(!/brindlewood|pottery/i.test(sent.user + sent.system), "the client's own name is taken out of the description before it is sent");
    assert.equal(JSON.parse(sent.user).description, "travel agency invoice");
    assert.ok(!/\d{3,}|£/.test(JSON.parse(sent.user).description), "no amount or invoice number");
    assert.equal(run.suggestion?.categoryCode, "3.6");
  });

  it("R5: a suggestion is stored labelled and pending, audited by reference — and the map is untouched", async () => {
    const { recorded, run } = await ask({ glCode: "7300", description: "Courier charges" }, { categoryCode: "3.4", reason: "Couriers move goods upstream." });
    assert.ok(recorded);
    const stored = (await db.query<{ status: string; suggested_category_code: string; reason: string; model: string; prompt_sha256: string }>(
      `SELECT status, suggested_category_code, reason, model, prompt_sha256 FROM nzi_console.spend_allocation_suggestions WHERE suggestion_id = $1`, [recorded!.data.suggestionId])).rows[0]!;
    assert.deepEqual([stored.status, stored.suggested_category_code, stored.model, stored.prompt_sha256], ["suggested", "3.4", "claude-sonnet-5", run.promptSha256]);
    assert.deepEqual(await mapEntries(), [], "the AI never writes the map");
    const audit = (await db.query<{ action: string; after_json: Record<string, unknown> }>(`SELECT action, after_json FROM nzi_console.audit_events WHERE audit_event_id = $1`, [recorded!.auditEventId])).rows[0]!;
    assert.equal(audit.action, "spend_allocation.suggestion_recorded");
    assert.deepEqual(Object.keys(audit.after_json).sort(), ["categoryCode", "keyKind", "model", "promptSha256", "suggestionId", "version"]);
    assert.ok(!JSON.stringify(audit.after_json).includes("Courier"), "by reference: never the description or the reason");
  });

  it("R5: a person's confirmation is what writes the map — as a confirmed suggestion — and the same line then routes by it", async () => {
    const { recorded } = await ask({ glCode: "7400", description: "Hotel stays" }, { categoryCode: "3.6", reason: "Hotels are business travel." });
    const confirmed = await confirmSpendAllocationSuggestion(database.pool, { jobId: JOB, suggestionId: recorded!.data.suggestionId, expectedVersion: 1, categoryCode: "3.6" }, context());
    assert.equal(confirmed.data.allocation.created, true);
    const entry = (await mapEntries()).find((row) => row.matchKey === "7400")!;
    assert.deepEqual([entry.targetCategoryCode, entry.source, entry.vatApplies], ["3.6", "suggestion-confirmed", true]);
    const again = await withTenantRead(database.pool, ORG, (tx) => spendSuggestionRequest(tx, ORG, JOB, { glCode: "7400" })).then(() => "asked", (error) => error.issues?.[0]?.code);
    assert.equal(again, "ALREADY_MAPPED", "the AI is for the unmapped only");
    await assert.rejects(confirmSpendAllocationSuggestion(database.pool, { jobId: JOB, suggestionId: recorded!.data.suggestionId, expectedVersion: 2, categoryCode: "3.6" }, context()),
      (error: any) => error.issues?.[0]?.code === "DECIDED");
  });

  it("a person may confirm a different category than suggested; a dismissal writes nothing", async () => {
    const { recorded } = await ask({ glCode: "7500", description: "Office plants" }, { categoryCode: "3.2", reason: "Plants are capital items." });
    await confirmSpendAllocationSuggestion(database.pool, { jobId: JOB, suggestionId: recorded!.data.suggestionId, expectedVersion: 1, categoryCode: "3.1" }, context());
    assert.equal((await mapEntries()).find((row) => row.matchKey === "7500")!.targetCategoryCode, "3.1");
    const other = await ask({ glCode: "7600", description: "Sundries" }, { categoryCode: "3.1", reason: "Bought-in goods." });
    await dismissSpendAllocationSuggestion(database.pool, { jobId: JOB, suggestionId: other.recorded!.data.suggestionId, expectedVersion: 1 }, context());
    assert.equal((await mapEntries()).some((row) => row.matchKey === "7600"), false);
  });

  it("a figure in the reason, an unknown category, or 'none' is not stored — nothing is suggested", async () => {
    for (const body of [{ categoryCode: "3.6", reason: "About 40 flights." }, { categoryCode: "9.9", reason: "x" }, { categoryCode: "none", reason: "" }]) {
      const { recorded, run } = await ask({ glCode: "8100", description: "Misc" }, body);
      assert.equal(recorded, null);
      assert.equal(run.suggestion, null);
    }
  });

  it("R4+R5: a move at review that uses the suggestion confirms it, and the map entry is the confirmed suggestion's", async () => {
    const row = await createScopeRow(database.pool, { jobId: JOB, scope: "3.1", categoryCode: "3.1", sourceLabel: "Taxi account", columnText: "8200", quantity: 300, unit: "GBP",
      datasetId: DS, factorId: "d2ai-spend", factorVersion: "d2ai", factorLabel: "Services", qualityTier: "spend-based" }, context());
    const { recorded } = await ask({ glCode: "8200", description: "Taxi account" }, { categoryCode: "3.6", reason: "Taxis are business travel." });
    const moved = await reallocateScopeRow(database.pool, { jobId: JOB, rowId: row.data.rowId, expectedVersion: 1, categoryCode: "3.6", suggestionId: recorded!.data.suggestionId }, context());
    assert.equal(moved.data.suggestionConfirmed, recorded!.data.suggestionId);
    assert.equal((await mapEntries()).find((entry) => entry.matchKey === "8200")!.source, "suggestion-confirmed");
    const status = (await db.query<{ status: string }>(`SELECT status FROM nzi_console.spend_allocation_suggestions WHERE suggestion_id = $1`, [recorded!.data.suggestionId])).rows[0]!.status;
    assert.equal(status, "confirmed");
  });

  it("the store's own guards: a reason with a figure, or a prompt not named by a hash, never lands", async () => {
    await assert.rejects(db.query(`INSERT INTO nzi_console.spend_allocation_suggestions (organisation_id, suggestion_id, client_id, job_id, key_kind, match_key, display_key, suggested_category_code, reason, model, prompt_sha256, created_by)
      VALUES ($1, 'x', $2, $3, 'gl', '1', '1', '3.1', 'about 12', 'm', $4, 't')`, [ORG, CLIENT, JOB, "a".repeat(64)]));
  });
});
