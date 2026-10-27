import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { commandGrantForRole, encodeImportIdentity, type CommandContext, type PortalCommandContext, type SpendImportRow } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import {
  buildSpendImportIdentity, commitSpendImport, createPortalScopeRow, createScopeRow, getPortalDataView, listOpenReopenRequests, listScopeRowRollforwardPreview,
  listSpendRollforwardPreview, previewSpendImport, readCategoryLineYears, rejectScopeRow, requestScopeRowReopen, rollforwardScopeRows, rollforwardSpendSources,
  signSpendImportIdentity, updatePortalScopeRow, updateScopeRow, voidSpendImportBatch, withTenantRead, type PortalPrincipal,
} from "../src/index";
import { VersionConflictError } from "../src/errors";

/**
 * Data entry D3 (R2–R6) against Postgres, on a client with a **30 September year-end**:
 *
 *  - R2: the import window is the job's own financial year — never 1 Jan–31 Dec — and the import reconciles by reading first, so
 *    the same ledger imported into two years, or into one year twice, counts each line once.
 *  - R3: the prior job a job carries forward from is stored when first chosen, and read, never recomputed.
 *  - R4: carry-forward by GL code (description where there is none): structure carried, values zeroed; a re-import fills the
 *    carried line for its GL code rather than adding a second.
 *  - R5: a category's lines across baseline + current + prior years, matched by GL code.
 *  - R6: reopen after review is a request to the CRM, sent as a message; the CRM reopens by editing. No self-recall.
 *
 * Factors are invented, named as such.
 */
const ORG = "demo-nzi-console";
const CLIENT = "client-d3b";
const FY24 = "job-d3b-fy24", FY25 = "job-d3b-fy25", FY26 = "job-d3b-fy26", LATE = "job-d3b-fy25-late";
const STAFF = "staff-d3b", USER = "portal-d3b";
const DS = "d3b-dataset", SYNTHETIC = "synthetic-gb-2026";
const SECRET = "d3b-import-secret-at-least-thirty-two-bytes-long";
const ORIGIN = "https://console.example.test";
const here = dirname(fileURLToPath(import.meta.url));

describe("Data entry D3 (B): financial-year imports, the stored basis, carry-forward by GL code, five years, reopen", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;
  let keys = 0;
  const staff = (): CommandContext => {
    keys += 1;
    return { organisationId: ORG, actorId: STAFF, principal: "staff", idempotencyKey: `d3b-${keys}`, correlationId: `corr-d3b-${keys}`, grant: commandGrantForRole("admin", ORG, STAFF) };
  };
  const portal = (): PortalCommandContext => {
    keys += 1;
    return { organisationId: ORG, actorId: USER, principal: "portal", portal: { portalUserId: USER, clientId: CLIENT }, idempotencyKey: `d3b-p-${keys}`, correlationId: `corr-d3b-p-${keys}` };
  };
  const issues = async (promise: Promise<unknown>) => {
    try { await promise; return []; } catch (error: any) { return (error.issues ?? [{ code: error.name }]).map((issue: any) => issue.code); }
  };
  const token = async (jobId: string) => {
    const identity = (await withTenantRead(database.pool, ORG, (tx) => buildSpendImportIdentity(tx, ORG, jobId)))!;
    return encodeImportIdentity(identity, signSpendImportIdentity(identity, SECRET));
  };
  const line = (over: Partial<SpendImportRow>): SpendImportRow => ({
    rowNumber: 1, description: "Line", netValue: 100, vatPercent: null, glCode: null, invoiceDate: null, purchasedGoodsCategoryId: "pgs-general",
    factorSource: "dataset", factorId: "d3b-spend", datasetId: DS, clientFactorId: null, monthly: [], ...over,
  });
  const commit = async (jobId: string, rows: SpendImportRow[]) => (await commitSpendImport(database.pool, { jobId, token: await token(jobId), rows }, staff(), SECRET)).data;
  const spend = async (jobId: string) => (await db.query<{ source_id: string; source_name: string; source_subtype: string | null; quantity: string | null; carry_key: string | null; site_id: string | null; category_code: string | null; rolled_forward_from_source_id: string | null; voided_at: Date | null; detail_json: any }>(
    `SELECT source_id,source_name,source_subtype,quantity,carry_key,site_id,category_code,rolled_forward_from_source_id,voided_at,detail_json FROM nzi_console.job_emission_sources WHERE job_id=$1 AND source_type='spend' ORDER BY source_name`, [jobId])).rows;
  let site = "";

  before(async () => {
    database = (await createDisposableDatabase("dataentryd3b"))!;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $1)`, [ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
    await db.query(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name, email) VALUES ($1, $2, 'admin', 'active', 'Sam Adviser', 'sam@netzero.international')`, [ORG, STAFF]);
    await db.query(`INSERT INTO nzi_console.clients (organisation_id, client_id, name, status, owner_user_id) VALUES ($1, $2, 'Harbour Co', 'active', $3)`, [ORG, CLIENT, STAFF]);
    await db.query(
      `INSERT INTO nzi_console.emission_factor_datasets (organisation_id, dataset_id, name, version, valid_from, valid_to, country_code, status, source_name, licence)
       VALUES ($1, $2, 'D3B test factors', 'd3b', '2023-10-01', '2026-09-30', 'GB', 'active', 'Test', 'Test only')`, [ORG, DS]);
    await db.query(`INSERT INTO nzi_console.emission_factors (organisation_id, dataset_id, factor_id, label, activity_unit, kgco2e_per_unit, scopes) VALUES ($1, $2, 'd3b-spend', 'Services — spend (test)', 'GBP', 0.2, ARRAY['3'])`, [ORG, DS]);
    await db.query(readFileSync(resolve(here, "../seeds/0003_synthetic_factors.sql"), "utf8"));
    await db.query(`INSERT INTO nzi_console.purchased_goods_categories (organisation_id, category_id, client_id, name, created_by) VALUES ($1, 'pgs-general', $2, 'General', 'test')`, [ORG, CLIENT]);
    site = (await db.query<{ site_id: string }>(`INSERT INTO nzi_console.client_sites (organisation_id, site_id, client_id, name, created_by) VALUES ($1, 'site-d3b', $2, 'Harbour depot', 'test') RETURNING site_id`, [ORG, CLIENT])).rows[0]!.site_id;
    // Three September year-ends. FY2025 has a reporting period and no emissions window (an older job): the window must still be its
    // own financial year.
    for (const [job, sequence, year, from, to, config] of [[FY24, 1, 2024, "2023-10-01", "2024-09-30", true], [FY25, 2, 2025, "2024-10-01", "2025-09-30", false], [FY26, 3, 2026, "2025-10-01", "2026-09-30", true]] as const) {
      await db.query(
        `INSERT INTO nzi_console.jobs (organisation_id, job_id, client_id, sequence, job_family, title, status, workflow_stage, reporting_year, start_date, reporting_period_start, reporting_period_end)
         VALUES ($1, $2, $3, $4, 'crp', 'CRP', 'open', 'Data entry', $5, $6::date, $6::date, $7::date)`, [ORG, job, CLIENT, sequence, year, from, to]);
      if (config) await db.query(`INSERT INTO nzi_console.job_emissions_config (organisation_id, job_id, reporting_from, reporting_to, country_code) VALUES ($1, $2, $3, $4, 'GB')`, [ORG, job, from, to]);
      for (const dataset of [DS, SYNTHETIC]) await db.query(`INSERT INTO nzi_console.job_dataset_selections (organisation_id, job_id, dataset_id, selection_source, reason, selected_by) VALUES ($1, $2, $3, 'manual', 'D3B test', 'test')`, [ORG, job, dataset]);
    }
    await db.query(`INSERT INTO nzi_console.portal_users (organisation_id, portal_user_id, client_id, status, display_name) VALUES ($1, $2, $3, 'active', 'Grace Client')`, [ORG, USER, CLIENT]);
    await db.query(
      `INSERT INTO nzi_console.portal_access_grants (organisation_id, grant_id, client_id, portal_user_id, job_id, data_entry_starts_at, data_entry_expires_at)
       VALUES ($1, 'grant-d3b', $2, $3, $4, now() - interval '1 day', now() + interval '30 days')`, [ORG, CLIENT, USER, FY26]);
  });
  after(async () => { await db?.end(); await database?.end(); });

  describe("R2 — the import window is the job's financial year, and an import reconciles by reading first", () => {
    const ledger = [
      line({ rowNumber: 1, description: "Audit fee", glCode: "8800", netValue: 4000, invoiceDate: "2025-03-10" }),
      line({ rowNumber: 2, description: "Legal advice", glCode: "8800", netValue: 2500, invoiceDate: "2025-11-05" }),
      line({ rowNumber: 3, description: "Payroll bureau", glCode: "8810", netValue: 900, invoiceDate: "2026-02-14" }),
    ];

    it("a job with no emissions window takes its own September year-end — never 1 Jan–31 Dec; a job with no period has no template", async () => {
      const identity = await withTenantRead(database.pool, ORG, (tx) => buildSpendImportIdentity(tx, ORG, FY25));
      assert.deepEqual([identity!.reportingFrom, identity!.reportingTo], ["2024-10-01", "2025-09-30"]);
      await db.query(`INSERT INTO nzi_console.jobs (organisation_id, job_id, client_id, sequence, job_family, title, status, workflow_stage, reporting_year, start_date) VALUES ($1, 'job-d3b-bare', $2, 90, 'crp', 'CRP', 'open', 'Data entry', NULL, '2026-01-01')`, [ORG, CLIENT]);
      assert.equal(await withTenantRead(database.pool, ORG, (tx) => buildSpendImportIdentity(tx, ORG, "job-d3b-bare")), null, "no calendar-year fallback");
    });

    it("the same ledger imported into FY2025 and FY2026 lands each invoice in its own year once; a re-import adds nothing", async () => {
      const fy25 = await commit(FY25, ledger);
      assert.deepEqual([fy25.created, fy25.blocked], [1, 2], "only March 2025 is FY2025's; November and February belong to FY2026");
      const fy26 = await commit(FY26, ledger);
      assert.deepEqual([fy26.created, fy26.blocked], [2, 1]);
      const again = await commit(FY26, ledger);
      assert.deepEqual([again.created, again.filled, again.alreadyImported, again.blocked], [0, 0, 2, 1], "read first: both lines are already here");
      const counts = (await db.query<{ source_name: string; n: string }>(
        `SELECT s.source_name, count(*)::text AS n FROM nzi_console.job_emission_sources s JOIN nzi_console.jobs j ON j.job_id=s.job_id
          WHERE j.client_id=$1 AND s.import_batch_id IS NOT NULL AND s.voided_at IS NULL GROUP BY s.source_name ORDER BY s.source_name`, [CLIENT])).rows;
      assert.deepEqual(counts.map((row) => [row.source_name, row.n]), [["Audit fee", "1"], ["Legal advice", "1"], ["Payroll bureau", "1"]], "each ledger line counted once across the years");
    });

    it("the preview says so line by line", async () => {
      const identity = (await withTenantRead(database.pool, ORG, (tx) => buildSpendImportIdentity(tx, ORG, FY26)))!;
      const preview = await previewSpendImport(database.pool, ORG, identity, ledger, 1);
      assert.equal(preview.kind, "preview");
      if (preview.kind !== "preview") return;
      assert.deepEqual(preview.reviews.map((review) => [review.status, review.reconciliation?.kind ?? null]), [["blocked", null], ["advisory", "already-imported"], ["advisory", "already-imported"]]);
      assert.equal(preview.summary.alreadyImported, 2);
    });
  });

  describe("R3 + R4 — carry forward from a stored prior job, by GL code", () => {
    before(async () => {
      // FY2025's ledger, entered: two lines under GL 6100 at one site, one under 7420, one with no GL code.
      const add = (name: string, gl: string | null, quantity: number, siteId: string | null) => db.query(
        `INSERT INTO nzi_console.job_emission_sources (organisation_id, source_id, job_id, scope, source_type, source_subtype, site_id, source_name, dataset_id, factor_id, quantity, unit, category_code, detail_json)
         VALUES ($1, gen_random_uuid()::text, $2, '3.1', 'spend', $3, $4, $5, $6, 'd3b-spend', $7, 'GBP', '3.1', $8::jsonb)`,
        [ORG, FY25, gl, siteId, name, DS, quantity, JSON.stringify({ kind: "spend", netValue: quantity })]);
      await add("Stationery", "6100", 500, site);
      await add("Printer paper", "6100", 900, site);
      await add("Pensions admin", "7420", 2000, null);
      await add("Window cleaning", null, 300, null);
    });

    it("R3: until anything is carried, the preview's prior job is proposed; the first carry-forward stores it", async () => {
      const before = await withTenantRead(database.pool, ORG, (tx) => listSpendRollforwardPreview(tx, FY26));
      assert.deepEqual([before.priorJob?.id, before.priorJob?.fixed], [FY25, false]);
      assert.deepEqual(before.lines.map((entry) => [entry.carryKey, entry.priorLineCount, entry.alreadyRolledForward]).sort(),
        [["description:window cleaning", 1, false], ["gl:6100", 2, false], ["gl:7420", 1, false], ["gl:8800", 1, true]].sort(), "one line per key; 8800 is already here (imported)");
      const result = await rollforwardSpendSources(database.pool, { jobId: FY26, fromJobId: null }, staff());
      assert.deepEqual([result.data.priorJobId, result.data.rolledForward, result.data.skipped], [FY25, 3, 1]);
      const basis = (await db.query(`SELECT prior_job_id, prior_period_from::text, prior_period_to::text, chosen_by FROM nzi_console.job_carry_forward_basis WHERE job_id=$1`, [FY26])).rows[0];
      assert.deepEqual(basis, { prior_job_id: FY25, prior_period_from: "2024-10-01", prior_period_to: "2025-09-30", chosen_by: STAFF });
    });

    it("R4: one line per GL code (else description) — the largest names it, its site travels, the values are zeroed", async () => {
      const carried = (await spend(FY26)).filter((source) => source.carry_key !== null);
      assert.deepEqual(carried.map((source) => [source.carry_key, source.source_name, source.quantity, source.site_id, source.category_code, source.detail_json.netValue]).sort(), [
        ["description:window cleaning", "Window cleaning", null, null, "3.1", 0],
        ["gl:6100", "Printer paper", null, site, "3.1", 0],
        ["gl:7420", "Pensions admin", null, null, "3.1", 0],
      ].sort());
      const again = await rollforwardSpendSources(database.pool, { jobId: FY26, fromJobId: null }, staff());
      assert.deepEqual([again.data.rolledForward, again.data.skipped], [0, 4], "carrying forward again carries nothing twice");
    });

    it("R3: a newer candidate does not move the basis — the preview reads the stored one, and another prior job is refused", async () => {
      // A later FY2025 job with spend: the recomputed "latest earlier job with spend" would now be this one.
      await db.query(`INSERT INTO nzi_console.jobs (organisation_id, job_id, client_id, sequence, job_family, title, status, workflow_stage, reporting_year, start_date, reporting_period_start, reporting_period_end)
        VALUES ($1, $2, $3, 9, 'crp', 'CRP (restated)', 'open', 'Data entry', 2025, '2024-10-01', '2024-10-01', '2025-09-30')`, [ORG, LATE, CLIENT]);
      await db.query(`INSERT INTO nzi_console.job_emission_sources (organisation_id, source_id, job_id, scope, source_type, source_name, quantity, unit) VALUES ($1, 'late-src', $2, '3.1', 'spend', 'Late line', 1, 'GBP')`, [ORG, LATE]);
      const spendPreview = await withTenantRead(database.pool, ORG, (tx) => listSpendRollforwardPreview(tx, FY26));
      assert.deepEqual([spendPreview.priorJob?.id, spendPreview.priorJob?.fixed], [FY25, true]);
      const rowPreview = await withTenantRead(database.pool, ORG, (tx) => listScopeRowRollforwardPreview(tx, FY26));
      assert.equal(rowPreview.priorJob?.id, FY25, "rows read the same basis");
      assert.deepEqual(await issues(rollforwardSpendSources(database.pool, { jobId: FY26, fromJobId: LATE }, staff())), ["CARRY_FORWARD_BASIS_FIXED"]);
      assert.deepEqual(await issues(rollforwardScopeRows(database.pool, { jobId: FY26, priorJobId: LATE, rowIds: ["any-row"] }, staff())), ["CARRY_FORWARD_BASIS_FIXED"]);
    });

    it("R4: this year's ledger line for GL 6100 fills the carried line — not a second beside it — and a re-import adds nothing", async () => {
      const lines = await spend(FY26);
      const stationery = [line({ rowNumber: 1, description: "Stationery Q1", glCode: "61 00", netValue: 750, invoiceDate: "2026-01-20" })];
      const first = await commit(FY26, stationery);
      assert.deepEqual([first.created, first.filled], [0, 1]);
      const after = await spend(FY26);
      assert.equal(after.length, lines.length, "no line added");
      const filled = after.find((source) => source.carry_key === "gl:6100")!;
      assert.deepEqual([filled.source_name, Number(filled.quantity), filled.detail_json.carriedForward], ["Stationery Q1", 750, true]);
      const again = await commit(FY26, stationery);
      assert.deepEqual([again.created, again.filled, again.alreadyImported], [0, 0, 1]);
      // Voiding that import empties the carried line again — the GL code's line stays for the next import.
      const batch = (await db.query<{ import_batch_id: string }>(`SELECT import_batch_id FROM nzi_console.job_emission_sources WHERE source_id=$1`, [filled.source_id])).rows[0]!.import_batch_id;
      await voidSpendImportBatch(database.pool, { jobId: FY26, batchId: batch }, staff());
      const emptied = (await spend(FY26)).find((source) => source.source_id === filled.source_id)!;
      assert.deepEqual([emptied.quantity, emptied.voided_at, emptied.carry_key], [null, null, "gl:6100"]);
    });
  });

  describe("R5 — a category's lines across baseline + current + prior years, matched by GL code", () => {
    it("reads each year's job, by GL code; a baseline year with nothing behind it is null, never zero", async () => {
      const row = (jobId: string, label: string, gl: string | null, quantity: number) => createScopeRow(database.pool, {
        jobId, scope: "3.1", categoryCode: "3.1", sourceLabel: label, siteId: null, quantity, unit: "GBP", datasetId: DS, factorId: "d3b-spend",
        factorVersion: "d3b", factorLabel: "Services — spend (test)", qualityTier: "spend-based", columnText: gl,
      } as never, staff());
      await row(FY24, "Stationery 2024", "6100", 500);
      await row(FY25, "Stationery & paper", "6100", 650);
      await row(FY26, "Stationery", "6100", 800);
      await row(FY26, "Consulting", null, 1200);
      for (const [snapshot, job, year] of [["snap-d3b-24", FY24, 2024], ["snap-d3b-25", FY25, 2025]] as const) {
        await db.query(`INSERT INTO nzi_console.reviewed_crp_snapshots (organisation_id, snapshot_id, job_id, snapshot_version, job_version, data_hash, payload_json, created_by)
          VALUES ($1, $2, $3, 1, 1, $4, $5::jsonb, 'test')`, [ORG, snapshot, job, `sha256:${"d".repeat(64)}`, JSON.stringify({ jobNumber: job, client: "Harbour Co", reportingYear: year, measurements: [] })]);
      }
      await db.query(`INSERT INTO nzi_console.job_emissions_targets (organisation_id, job_id, baseline_year, baseline_tco2e, interim_year, interim_reduction_percent, net_zero_year, updated_by)
        VALUES ($1, $2, 2023, 100, 2030, 50, 2050, 'test')`, [ORG, FY26]);
      const read = (await withTenantRead(database.pool, ORG, (tx) => readCategoryLineYears(tx, FY26, "3.1")))!;
      assert.deepEqual(read.years.map((year) => [year.year, year.kind, year.jobId]), [[2023, "baseline", null], [2024, "prior", FY24], [2025, "prior", FY25], [2026, "current", FY26]]);
      const stationery = read.lines.find((entry) => entry.key === "gl:6100")!;
      assert.equal(stationery.label, "Stationery", "named as the current year names it");
      assert.deepEqual(stationery.values.map((value) => value?.quantity ?? null), [null, 500, 650, 800]);
      const consulting = read.lines.find((entry) => entry.key === "description:consulting")!;
      assert.deepEqual(consulting.values.map((value) => value?.quantity ?? null), [null, null, null, 1200]);
    });
  });

  describe("R6 — reopen after review is a request to the CRM; the CRM reopens by editing", () => {
    let rowId = "";
    const gas = { jobId: FY26, scope: "1", categoryCode: "1.natural-gas", sourceLabel: "Boiler gas", siteId: null, quantity: 1000, unit: "kWh",
      datasetId: SYNTHETIC, factorId: "gas-demo", factorVersion: null, factorLabel: "Natural gas", notes: null, monthlyActivity: [] };
    const ask = (reason = "The meter reading was wrong — it should be 1,200 kWh.", version?: number) =>
      requestScopeRowReopen(database.pool, { jobId: FY26, rowId, expectedVersion: version ?? 0, reason }, portal(), ORIGIN);
    const version = async () => (await db.query<{ version: number }>(`SELECT version FROM nzi_console.job_scope_rows WHERE scope_row_id=$1`, [rowId])).rows[0]!.version;

    it("a pending entry is the client's to change — nothing to ask", async () => {
      rowId = (await createPortalScopeRow(database.pool, gas as never, portal())).data.rowId;
      assert.deepEqual(await issues(ask(undefined, await version())), ["ENTRY_STILL_EDITABLE"]);
    });

    it("once reviewed the client cannot change it (no self-recall) — they ask; the request goes to the CRM as a message, audited", async () => {
      await rejectScopeRow(database.pool, { jobId: FY26, rowIds: [rowId], expectedReviewVersion: await version(), reviewerNote: "Check the reading" }, staff());
      assert.deepEqual(await issues(updatePortalScopeRow(database.pool, { ...gas, rowId, expectedVersion: await version(), quantity: 1200 } as never, portal())), ["CLIENT_ROW_NOT_EDITABLE"]);
      await assert.rejects(ask(undefined, (await version()) - 1), VersionConflictError);
      const asked = await ask(undefined, await version());
      assert.equal(asked.data.notified, true);
      const request = (await db.query(`SELECT status, reason, portal_user_id, email_message_id FROM nzi_console.scope_row_reopen_requests WHERE request_id=$1`, [asked.data.requestId])).rows[0];
      assert.deepEqual([request.status, request.reason, request.portal_user_id], ["open", "The meter reading was wrong — it should be 1,200 kWh.", USER]);
      const email = (await db.query(`SELECT to_email, template_code, subject, text_body FROM nzi_console.email_messages WHERE email_message_id=$1`, [request.email_message_id])).rows[0];
      assert.deepEqual([email.to_email, email.template_code, email.subject], ["sam@netzero.international", "portal.data.reopen-request", "Harbour Co asks to reopen an entry on " + (await db.query(`SELECT job_number FROM nzi_console.jobs WHERE job_id=$1`, [FY26])).rows[0].job_number]);
      assert.match(email.text_body, /Grace Client at Harbour Co has asked to reopen an entry/);
      assert.match(email.text_body, /https:\/\/console\.example\.test\/jobs\/job-d3b-fy26/);
      assert.doesNotMatch(email.text_body, /meter reading/, "the client's reason stays on the job, not in the email");
      const audit = (await db.query(`SELECT principal_type, actor_id, action FROM nzi_console.audit_events WHERE audit_event_id=$1`, [asked.auditEventId])).rows[0];
      assert.deepEqual(audit, { principal_type: "portal", actor_id: USER, action: "portal_scope_row_reopen_requested" });
      assert.deepEqual(await issues(ask(undefined, await version())), ["REOPEN_ALREADY_REQUESTED"]);
    });

    it("the client sees it asked; the CRM sees the request, why and who", async () => {
      const principal = { principal: "portal", organisationId: ORG, userId: USER, clientId: CLIENT, sessionId: "p", issuedAt: 1, expiresAt: 2, displayName: "Grace", email: "g@example.invalid" } as unknown as PortalPrincipal;
      const view = await getPortalDataView(database.pool, principal, FY26);
      assert.ok(view.rows.find((entry) => entry.id === rowId)?.reopenRequestedAt);
      const open = await withTenantRead(database.pool, ORG, (tx) => listOpenReopenRequests(tx, FY26));
      assert.deepEqual(open.map((entry) => [entry.rowId, entry.rowLabel, entry.requestedBy, entry.notified]), [[rowId, "Boiler gas", "Grace Client", true]]);
    });

    it("the CRM's edit reopens it — back to pending — and answers the request, named in the edit's result", async () => {
      const stored = (await db.query(`SELECT * FROM nzi_console.job_scope_rows WHERE scope_row_id=$1`, [rowId])).rows[0];
      const edited = await updateScopeRow(database.pool, { ...gas, rowId, expectedVersion: stored.version, enabled: true, qualityTier: null, quantity: 1200 } as never, staff());
      const request = (await db.query(`SELECT request_id, status, resolved_by FROM nzi_console.scope_row_reopen_requests WHERE scope_row_id=$1`, [rowId])).rows[0];
      assert.deepEqual([request.status, request.resolved_by], ["reopened", STAFF]);
      assert.equal(edited.data.reopenedRequestId, request.request_id);
      assert.equal((await db.query(`SELECT review_status FROM nzi_console.job_scope_rows WHERE scope_row_id=$1`, [rowId])).rows[0].review_status, "pending");
      assert.deepEqual(await withTenantRead(database.pool, ORG, (tx) => listOpenReopenRequests(tx, FY26)), []);
    });
  });
});
