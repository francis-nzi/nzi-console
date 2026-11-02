import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { commandGrantForRole, parseSpendImportNote, spendImportNote, type CommandContext, type SpendImportRow } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import {
  AuthorizationError, CommandValidationError, importPortalScopeRows, issueSpendImportIdentity, previewPortalSpendImport, previewSpendImport, setClientCategoryVisibility, SPEND_IMPORT_TEMPLATE_VERSION,
  type PortalPrincipal,
} from "../src/index";

/**
 * The client portal's spend import, Phase A (RULING-portal-import-spend), against a real database: per-line pending scope rows filed where
 * the staff allocation map routes them (never the register), the client unable to choose or override the category, a hidden category held
 * without being named, duplicates read across the register AND the job's own spend rows, a carried-forward line never filled, and the
 * identity (period, template version, signature) verified in the transaction.
 */
const ORG = "demo-nzi-console";
const CLIENT = "client-sp", JOB = "job-sp", OTHER_JOB = "job-sp-other", OTHER_CLIENT = "client-sp-other";
const USER = "portal-sp", STAFF = "staff-sp";
const DS = "ds-sp";
const SECRET = "a-dedicated-session-secret-of-32-bytes-or-more";
const principal = { principal: "portal", organisationId: ORG, userId: USER, clientId: CLIENT, sessionId: "p", issuedAt: 1, expiresAt: 2, displayName: "P", email: "p@example.invalid" } as unknown as PortalPrincipal;

const line = (over: Partial<SpendImportRow> & { rowNumber: number }): SpendImportRow => ({
  description: "Rail tickets", netValue: 100, vatPercent: null, glCode: null, invoiceDate: "2026-03-14", purchasedGoodsCategoryId: null,
  factorSource: "dataset", factorId: null, datasetId: null, clientFactorId: null, monthly: [], ...over,
});

describe("portal spend import (Phase A)", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;
  let keys = 0;
  const portal = (): CommandContext => { keys += 1; return { organisationId: ORG, actorId: USER, principal: "portal", portal: { portalUserId: USER, clientId: CLIENT }, idempotencyKey: `sp-${keys}`, correlationId: `corr-sp-${keys}` }; };
  const staff = (): CommandContext => { keys += 1; return { organisationId: ORG, actorId: STAFF, principal: "staff", idempotencyKey: `st-${keys}`, correlationId: `corr-st-${keys}`, grant: commandGrantForRole("admin", ORG, STAFF) }; };
  const token = async (jobId = JOB) => (await issueSpendImportIdentity(database.pool, ORG, jobId, SECRET))!.token;
  const commit = async (lines: SpendImportRow[], over: { jobId?: string; token?: string; context?: CommandContext } = {}) =>
    importPortalScopeRows(database.pool, { jobId: over.jobId ?? JOB, template: "spend", rows: [], spend: { token: over.token ?? await token(over.jobId ?? JOB), lines } }, over.context ?? portal(), { spendSecret: SECRET });
  const preview = (lines: SpendImportRow[]) => previewPortalSpendImport(database.pool, principal, JOB, lines, SECRET);
  const q = async <T extends pg.QueryResultRow = Record<string, any>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
  const filed = () => q(`SELECT scope_row_id,source_label,scope,category_code,quantity::float8 AS quantity,unit,factor_id,dataset_id,notes,review_status,provenance_json,purchased_goods_category_id FROM nzi_console.job_scope_rows WHERE job_id=$1 ORDER BY source_label`, [JOB]);

  before(async () => {
    database = (await createDisposableDatabase("portalspend"))!;
    db = await database.admin();
    await q(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,$1)`, [ORG]);
    await q(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    await q(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
    await q(`INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,$2,'Co','active'),($1,$3,'Other','active')`, [ORG, CLIENT, OTHER_CLIENT]);
    await q(`INSERT INTO nzi_console.memberships (organisation_id,user_id,role_id,status,display_name) VALUES ($1,$2,'admin','active','Sam Staff')`, [ORG, STAFF]);
    await q(`INSERT INTO nzi_console.emission_factor_datasets (organisation_id,dataset_id,name,version,valid_from,valid_to,country_code,status,source_name,licence) VALUES ($1,$2,'SP test','sp1','2026-01-01','2026-12-31','GB','active','SP test','Test only')`, [ORG, DS]);
    await q(`INSERT INTO nzi_console.emission_factors (organisation_id,dataset_id,factor_id,label,activity_unit,kgco2e_per_unit,scopes) VALUES
      ($1,$2,'sp-paper','Paper — spend (test)','GBP',0.4,ARRAY['3']),($1,$2,'sp-travel','Travel — spend (test)','GBP',0.2,ARRAY['3']),($1,$2,'sp-rail-km','Rail — national (test)','km',0.035,ARRAY['3'])`, [ORG, DS]);
    await q(`INSERT INTO nzi_console.purchased_goods_categories (organisation_id,category_id,client_id,name,created_by) VALUES ($1,'pgs-general',$2,'General','test')`, [ORG, CLIENT]);
    for (const [job, client] of [[JOB, CLIENT], [OTHER_JOB, OTHER_CLIENT]] as const) {
      await q(`INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage,reporting_year,reporting_period_start,reporting_period_end)
        VALUES ($1,$2,$3,(SELECT coalesce(max(sequence),0)+1 FROM nzi_console.jobs),'crp','CRP','open','Data entry',2026,'2026-01-01','2026-12-31')`, [ORG, job, client]);
      await q(`INSERT INTO nzi_console.job_emissions_config (organisation_id,job_id,reporting_from,reporting_to,country_code) VALUES ($1,$2,'2026-01-01','2026-12-31','GB')`, [ORG, job]);
      await q(`INSERT INTO nzi_console.job_dataset_selections (organisation_id,job_id,dataset_id,selection_source,reason,selected_by) VALUES ($1,$2,$3,'manual','SP test','test')`, [ORG, job, DS]);
    }
    await q(`INSERT INTO nzi_console.portal_users (organisation_id,portal_user_id,client_id,status) VALUES ($1,$2,$3,'active')`, [ORG, USER, CLIENT]);
    await q(`INSERT INTO nzi_console.portal_access_grants (organisation_id,grant_id,client_id,portal_user_id,job_id,data_entry_starts_at,data_entry_expires_at,revoked_at)
      VALUES ($1,'g-sp',$2,$3,$4,now() - interval '1 day', now() + interval '30 days',NULL)`, [ORG, CLIENT, USER, JOB]);
    // The staff allocation map: GL 6100 → Business travel (default spend factor); GL 9999 → Employee commuting, which this client is not shown.
    await q(`INSERT INTO nzi_console.client_spend_allocations (organisation_id,allocation_id,client_id,key_kind,match_key,display_key,target_category_code,vat_applies,default_dataset_id,default_factor_id,source,created_by,updated_by)
      VALUES ($1,'al-1',$2,'gl','6100','6100','3.6',false,$3,'sp-travel','admin','test','test'),($1,'al-2',$2,'gl','9999','9999','3.7',false,NULL,NULL,'admin','test','test')`, [ORG, CLIENT, DS]);
    await setClientCategoryVisibility(database.pool, { clientId: CLIENT, categoryCode: "3.7", visible: false }, staff());
  });
  after(async () => { await db?.end(); await database?.end(); });

  const rail = line({ rowNumber: 1, description: "Rail tickets March", glCode: "6100", netValue: 250, vatPercent: 20 });
  const paper = line({ rowNumber: 2, description: "Office paper", glCode: "5100", netValue: 80, purchasedGoodsCategoryId: "pgs-general", factorId: "sp-paper", datasetId: DS });
  const unmapped = line({ rowNumber: 3, description: "Unmapped thing", glCode: "5200", netValue: 40 });
  const hidden = line({ rowNumber: 4, description: "Commuter allowance", glCode: "9999", netValue: 60 });
  const clientFactor = line({ rowNumber: 5, description: "Special", glCode: "5300", netValue: 10, purchasedGoodsCategoryId: "pgs-general", factorSource: "client", clientFactorId: "cf-x" });

  it("previews 'Filed under' from the staff map, read-only; unmapped lines fall to PG&S; an unmapped line with no category or factor is blocked", async () => {
    const result = await preview([rail, paper, unmapped]);
    assert.equal(result.kind, "preview");
    if (result.kind !== "preview") return;
    assert.deepEqual(result.reviews.map((review) => [review.rowNumber, review.filedUnder, review.status]), [[1, "Business Travel", "advisory"], [2, "Purchased Goods and Services", "accepted"], [3, "Purchased Goods and Services", "blocked"]]);
    assert.ok(result.reviews[0]!.issues.some((issue) => issue.code === "VAT_NOT_APPLICABLE"), "VAT on a category that takes none is said, not silently dropped");
    assert.ok(result.reviews[2]!.issues.some((issue) => issue.code === "CATEGORY_UNRESOLVED"));
    assert.deepEqual(result.summary, { total: 3, importable: 2, advisory: 1, blocked: 1, alreadyImported: 0, matchesCarried: 0 });
    assert.doesNotMatch(JSON.stringify(result), /allocationId|defaultFactorId|al-1/, "the map's internals are not sent to the client");
  });

  it("holds a line routed to a category the client is not shown, or priced by a client factor, without saying why", async () => {
    const result = await preview([hidden, clientFactor]);
    assert.equal(result.kind, "preview");
    if (result.kind !== "preview") return;
    for (const review of result.reviews) {
      assert.equal(review.status, "blocked");
      assert.ok(review.issues.some((issue) => issue.code === "NOT_IMPORTABLE_HERE" && issue.message === "This line can't be imported here. Ask your adviser."));
    }
    assert.doesNotMatch(JSON.stringify(result.reviews[0]), /commut/i, "the hidden category is never named");
  });

  it("files each accepted line as one pending client-provenanced scope row — spend basis, the factor's currency, GL and invoice date in the note — and nothing in the staff register", async () => {
    const registerBefore = Number((await q(`SELECT count(*) AS n FROM nzi_console.job_emission_sources WHERE job_id=$1`, [JOB]))[0]!.n);
    const outcome = await commit([rail, paper, unmapped, hidden, clientFactor]);
    assert.deepEqual([outcome.data.count, outcome.data.blocked, outcome.data.alreadyImported, outcome.data.matchesCarried], [2, 3, 0, 0]);
    const rows = await filed();
    assert.deepEqual(rows.map((row) => [row.source_label, row.scope, row.category_code, row.quantity, row.unit, row.factor_id, row.review_status]),
      [["Office paper", "3.1", "3.1", 80, "GBP", "sp-paper", "pending"], ["Rail tickets March", "3.6", "3.6", 250, "GBP", "sp-travel", "pending"]]);
    assert.equal(rows[0]!.purchased_goods_category_id, "pgs-general");
    assert.equal(rows[1]!.purchased_goods_category_id, null, "a PG&S sub-category travels only with a line filed in PG&S");
    assert.equal(rows[1]!.notes, "Spend import · GL 6100 · Invoice 2026-03-14", "VAT is not recorded where the category takes none");
    assert.equal(rows[0]!.notes, "Spend import · GL 5100 · Invoice 2026-03-14");
    assert.ok(rows.every((row) => row.provenance_json.capturedAs === "client-portal" && row.provenance_json.capturedBy === undefined));
    assert.equal(Number((await q(`SELECT count(*) AS n FROM nzi_console.job_emission_sources WHERE job_id=$1`, [JOB]))[0]!.n), registerBefore, "the portal never writes the staff register");
    assert.equal(Number((await q(`SELECT count(*) AS n FROM nzi_console.job_scope_rows WHERE job_id=$1 AND source_label IN ('Commuter allowance','Special','Unmapped thing')`, [JOB]))[0]!.n), 0, "held lines are filed nowhere");
  });

  it("does not file a line twice: re-importing the file adds nothing, and the staff preview now sees the client's lines too", async () => {
    const again = await commit([rail, paper]);
    assert.deepEqual([again.data.count, again.data.alreadyImported], [0, 2]);
    assert.equal(Number((await q(`SELECT count(*) AS n FROM nzi_console.job_scope_rows WHERE job_id=$1 AND source_label IN ('Rail tickets March','Office paper')`, [JOB]))[0]!.n), 2);
    const result = await preview([rail]);
    assert.ok(result.kind === "preview" && result.reviews[0]!.alreadyImported && result.summary.importable === 0);
    const staffView = await previewSpendImport(database.pool, ORG, (await issueSpendImportIdentity(database.pool, ORG, JOB, SECRET))!.identity, [rail], SPEND_IMPORT_TEMPLATE_VERSION);
    assert.ok(staffView.kind === "preview" && staffView.reviews[0]!.issues.some((issue) => issue.code === "ALREADY_IMPORTED"), "a line the client filed is a line the job holds: staff do not file it over them");
  });

  it("reads the staff register too: a line staff already imported is not filed again by the client", async () => {
    await q(`INSERT INTO nzi_console.job_emission_sources (organisation_id,source_id,job_id,scope,source_type,source_name,quantity,unit,source_subtype,asset_identifier,import_batch_id,factor_source,dataset_id,factor_id)
      VALUES ($1,'src-staff',$2,'3.1','spend','Staff keyed lunch',33,'GBP','6200','2026-04-01',gen_random_uuid(),'dataset',$3,'sp-paper')`, [ORG, JOB, DS]).catch(async () => {
      // the register's columns vary by migration; fall back to the minimal shape the context reads
      await q(`INSERT INTO nzi_console.job_emission_sources (organisation_id,source_id,job_id,scope,source_type,source_name,quantity,source_subtype,asset_identifier,import_batch_id) VALUES ($1,'src-staff',$2,'3.1','spend','Staff keyed lunch',33,'6200','2026-04-01','11111111-1111-4111-8111-111111111111')`, [ORG, JOB]);
    });
    const result = await preview([line({ rowNumber: 1, description: "Staff keyed lunch", netValue: 33, glCode: "6200", invoiceDate: "2026-04-01", purchasedGoodsCategoryId: "pgs-general", factorId: "sp-paper", datasetId: DS })]);
    assert.ok(result.kind === "preview" && result.reviews[0]!.alreadyImported);
  });

  it("never fills a carried-forward line: a matching line is left for the adviser, and the carried line is untouched", async () => {
    await q(`INSERT INTO nzi_console.job_emission_sources (organisation_id,source_id,job_id,scope,source_type,source_name,quantity,source_subtype,carry_key) VALUES ($1,'src-carried',$2,'3.1','spend','Carried subscription',NULL,'7777','gl:7777')`, [ORG, JOB]);
    const carried = line({ rowNumber: 1, description: "Subscription", netValue: 90, glCode: "7777", purchasedGoodsCategoryId: "pgs-general", factorId: "sp-paper", datasetId: DS });
    const result = await preview([carried]);
    assert.ok(result.kind === "preview" && result.reviews[0]!.matchesCarried && result.summary.matchesCarried === 1 && result.summary.importable === 0);
    const outcome = await commit([carried]);
    assert.deepEqual([outcome.data.count, outcome.data.matchesCarried], [0, 1]);
    assert.equal((await q(`SELECT quantity FROM nzi_console.job_emission_sources WHERE source_id='src-carried'`))[0]!.quantity, null);
    assert.equal(Number((await q(`SELECT count(*) AS n FROM nzi_console.job_scope_rows WHERE job_id=$1 AND source_label='Subscription'`, [JOB]))[0]!.n), 0);
  });

  it("is pinned by the signed identity: a forged, other-job or stale token, or a missing one, is refused and files nothing", async () => {
    const before = (await filed()).length;
    await assert.rejects(commit([line({ rowNumber: 1, description: "Fresh a", glCode: "6100", netValue: 5 })], { token: "forged.token" }), (error) => error instanceof CommandValidationError);
    await assert.rejects(commit([line({ rowNumber: 1, description: "Fresh b", glCode: "6100", netValue: 5 })], { token: await token(OTHER_JOB) }), (error) => error instanceof CommandValidationError && error.issues.some((issue) => issue.code === "WRONG_JOB"));
    await assert.rejects(importPortalScopeRows(database.pool, { jobId: JOB, template: "spend", rows: [] }, portal(), { spendSecret: SECRET }), CommandValidationError);
    await assert.rejects(importPortalScopeRows(database.pool, { jobId: JOB, template: "spend", rows: [], spend: { token: await token(), lines: [rail] } }, portal(), { spendSecret: "another-secret-of-more-than-32-bytes-long" }), CommandValidationError);
    await q(`UPDATE nzi_console.job_emissions_config SET reporting_to='2026-11-30' WHERE job_id=$1`, [JOB]);
    const stale = await token().catch(() => null);
    await q(`UPDATE nzi_console.job_emissions_config SET reporting_to='2026-12-31' WHERE job_id=$1`, [JOB]);
    if (stale) await assert.rejects(commit([line({ rowNumber: 1, description: "Fresh c", glCode: "6100", netValue: 5 })], { token: stale }), (error) => error instanceof CommandValidationError && error.issues.some((issue) => issue.code === "WRONG_PERIOD"), "a token for another period");
    assert.equal((await filed()).length, before);
  });

  it("holds the create's gates: the entry window, the grant, the job's client, a staff principal, and rows sent alongside", async () => {
    await assert.rejects(commit([rail], { jobId: OTHER_JOB }), AuthorizationError);
    await assert.rejects(commit([rail], { context: staff() }), AuthorizationError);
    await assert.rejects(importPortalScopeRows(database.pool, { jobId: JOB, template: "spend", rows: [{ scope: "3.6" } as never], spend: { token: await token(), lines: [rail] } }, portal(), { spendSecret: SECRET }),
      (error) => error instanceof CommandValidationError && error.issues.some((issue) => issue.code === "NOT_ALLOWED"), "a client cannot hand the server rows to file");
    await q(`UPDATE nzi_console.portal_access_grants SET data_entry_expires_at = now() - interval '1 minute', data_entry_starts_at = now() - interval '2 days' WHERE grant_id='g-sp'`);
    await assert.rejects(commit([line({ rowNumber: 1, description: "Late", glCode: "6100", netValue: 5 })]), /not open just now/);
    await q(`UPDATE nzi_console.portal_access_grants SET data_entry_expires_at = now() + interval '30 days' WHERE grant_id='g-sp'`);
  });

  it("writes the GL and invoice date into the note in a shape that reads back", () => {
    assert.equal(spendImportNote({ glCode: " 6100 ", invoiceDate: "2026-03-14", vatPercent: 20 }), "Spend import · GL 6100 · Invoice 2026-03-14 · VAT 20%");
    assert.deepEqual(parseSpendImportNote("Spend import · GL 6100 · Invoice 2026-03-14 · VAT 20%"), { glCode: "6100", invoiceDate: "2026-03-14" });
    assert.deepEqual(parseSpendImportNote("Spend import"), { glCode: null, invoiceDate: null });
    assert.equal(parseSpendImportNote("Rail to Leeds"), null);
    assert.equal(parseSpendImportNote(null), null);
  });
});
