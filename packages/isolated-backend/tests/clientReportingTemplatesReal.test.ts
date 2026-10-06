import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { commandGrantForRole, groupReportingTemplateLines, type CommandContext, type ReportingTemplateLineInput } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import {
  deactivateClientReportingTemplate, getClientReportingTemplate, getClientWorkspace, initialiseClientReportingTemplateFromJob,
  setClientReportingTemplate, withTenantRead,
} from "../src/index";

/**
 * Redesign Phase 1c (0159) against a real database: the client's reporting template — whole versions, header and lines;
 * initialised from a job's enabled rows (one line per distinct activity; v7 history "to file", never guessed; a client
 * factor and an archived site left off); set by hand, with every reference the client's own and an archived site cited
 * only if the template already did; withdrawn with a reason and set again; the shape held by the table on its own.
 */
describe("client reporting templates (0159), against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  const ORG = "demo-nzi-console";
  const CLIENT = "client-rt";
  let database: DisposableDatabase;
  let db: pg.Client;
  let keys = 0;
  let factor = { datasetId: "", factorId: "" };
  const context = (reason?: string): CommandContext => {
    keys += 1;
    return { organisationId: ORG, actorId: "admin-rt", principal: "staff", idempotencyKey: `rt-${keys}`, correlationId: `corr-rt-${keys}`,
      grant: commandGrantForRole("admin", ORG, "admin-rt"), ...(reason ? { reason } : {}) };
  };
  const refusedWith = (code: string) => (error: any) => error.issues?.some((issue: any) => issue.code === code);
  const read = () => withTenantRead(database.pool, ORG, (tenant) => getClientReportingTemplate(tenant, CLIENT));
  const shape = async () => (await read()).current?.lines.map((l) => [l.scope, l.categoryCode, l.sourceLabel, l.siteId, l.datasetId === null && l.factorId === null ? null : `${l.datasetId === null ? "-" : "dataset"}/${l.factorId === null ? "-" : "factor"}`]) ?? null;
  const job = async (jobId: string, clientId: string, sequence: number) => db.query(
    `INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage,reporting_year,source_system,legacy_db_id)
     VALUES ($1,$2,$3,$4,'crp','CRP','open','Data entry',2026,'nzi-pro-v7',$2)`, [ORG, jobId, clientId, sequence]);
  const row = async (jobId: string, id: string, columns: Record<string, unknown> = {}) => {
    const sourceLabel = (columns.source_label as string | undefined) ?? id;
    const fields = { organisation_id: ORG, scope_row_id: id, job_id: jobId, scope: "2", source_label: sourceLabel, report_label: sourceLabel, level_1: "Scope 2", level_2: "x", ...columns };
    const names = Object.keys(fields);
    await db.query(`INSERT INTO nzi_console.job_scope_rows (${names.join(",")}) VALUES (${names.map((_, i) => `$${i + 1}`).join(",")})`, Object.values(fields));
  };
  const line = (over: Partial<ReportingTemplateLineInput> = {}): ReportingTemplateLineInput =>
    ({ scope: "2", categoryCode: "2.purchased-electricity", sourceLabel: "Grid electricity", reportLabel: null, siteId: null, datasetId: null, factorId: null, unit: "kWh", ...over });

  before(async () => {
    database = (await createDisposableDatabase("reportingtemplates"))!;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,$1)`, [ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    for (const id of [CLIENT, "client-other"]) await db.query(`INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,$2,$2,'active')`, [ORG, id]);
    for (const [site, client, archived] of [["site-hq", CLIENT, false], ["site-old", CLIENT, true], ["site-depot", CLIENT, false], ["site-elsewhere", "client-other", false]] as const) {
      await db.query(`INSERT INTO nzi_console.client_sites (organisation_id,client_id,site_id,name,created_by,archived) VALUES ($1,$2,$3,$3,'seed',$4)`, [ORG, client, site, archived]);
    }
    await db.query(`INSERT INTO nzi_console.emission_factor_datasets (organisation_id,dataset_id,name,version,valid_from,valid_to,country_code,status,source_name,licence)
                    VALUES ($1,'template-test','Template test','1','2026-01-01','2026-12-31','GB','active','Test','Source: test.')`, [ORG]);
    await db.query(`INSERT INTO nzi_console.emission_factors (organisation_id,dataset_id,factor_id,label,activity_unit,kgco2e_per_unit,scopes)
                    VALUES ($1,'template-test','grid-electricity','Grid electricity — test factor','kWh',0.2,ARRAY['2'])`, [ORG]);
    factor = { datasetId: "template-test", factorId: "grid-electricity" };
    await db.query(`INSERT INTO nzi_console.client_factors (organisation_id,client_factor_id,client_id,scope,report_label,unit,kgco2e_per_unit,vintage_year,created_by)
                    VALUES ($1,'cf-1',$2,'2','Solar PPA','kWh',0.01,2025,'test')`, [ORG, CLIENT]);
    const dataset = { factor_source: "dataset", dataset_id: factor.datasetId, factor_id: factor.factorId };

    await job("job-rt", CLIENT, 1);
    // The same activity twice (January's and February's invoice) is one line.
    await row("job-rt", "elec-jan", { category_code: "2.purchased-electricity", source_label: "Grid electricity", site_id: "site-hq", unit: "kWh", ...dataset });
    await row("job-rt", "elec-feb", { category_code: "2.purchased-electricity", source_label: "Grid electricity", site_id: "site-hq", unit: "kWh", ...dataset });
    await row("job-rt", "gas", { scope: "1", level_1: "Scope 1", category_code: "1.natural-gas", source_label: "Boiler gas", report_label: "Natural gas", site_id: "site-old", unit: "kWh" });
    await row("job-rt", "paper", { scope: "3.1", level_1: "Scope 3", source_label: "Paper", unit: "GBP" });        // no category: its scope names it
    await row("job-rt", "ppa", { category_code: "2.purchased-electricity", source_label: "Solar PPA", factor_source: "client", client_factor_id: "cf-1", is_custom_entry: true, dataset_id: factor.datasetId, factor_id: factor.factorId });
    await row("job-rt", "switched-off", { category_code: "2.purchased-electricity", source_label: "Old meter", enabled: false });
    await row("job-rt", "v7-history", { scope: "3.5", level_1: "Scope 3", source_label: "Waste (v7)", origin: "migrated", source_system: "nzi-pro-v7", legacy_db_id: "77", migrated_record: { qty: 1, uom: "kWh", factor: 1, ghg_unit: "kg", original_id: "f", reported_tco2e: 1, data_source: "manual", enabled: true }, calculated_tco2e: 1 });
    await job("job-v7-only", CLIENT, 2);
    await row("job-v7-only", "v7-a", { scope: "1", level_1: "Scope 1", source_label: "Diesel (v7)", origin: "migrated", source_system: "nzi-pro-v7", legacy_db_id: "1", migrated_record: { qty: 1, uom: "kWh", factor: 1, ghg_unit: "kg", original_id: "f", reported_tco2e: 1, data_source: "manual", enabled: true }, calculated_tco2e: 1 });
    await job("job-empty", CLIENT, 3);
    await job("job-theirs", "client-other", 4);
    await row("job-theirs", "theirs", { category_code: "2.purchased-electricity" });
  });
  after(async () => { await db?.end(); await database?.end(); });

  it("initialises from a job: one line per activity; v7 history to file; a client factor and an archived site left off", async () => {
    const result = await initialiseClientReportingTemplateFromJob(database.pool, { clientId: CLIENT, expectedVersion: 0, jobId: "job-rt" }, context());
    assert.deepEqual([result.data.version, result.data.origin, result.data.lineCount, result.data.archivedSitesDropped], [1, "job", 5, 1]);
    assert.deepEqual(await shape(), [
      ["1", "1.natural-gas", "Boiler gas", null, null],                       // its site is archived, so it is left off
      ["2", "2.purchased-electricity", "Grid electricity", "site-hq", "dataset/factor"],
      ["2", "2.purchased-electricity", "Solar PPA", null, null],               // a client factor is not a template's factor
      ["3", "3.1", "Paper", null, null],
      ["3", null, "Waste (v7)", null, null],                                   // v7 history: to file — its 3.5 scope is not a category guess
    ]);
    const { current, latestVersion } = await read();
    assert.equal(latestVersion, 1);
    assert.equal(current!.origin, "job");
    assert.equal(current!.originJobNumber, (await db.query(`SELECT job_number FROM nzi_console.jobs WHERE job_id = 'job-rt'`)).rows[0].job_number);
    assert.equal(current!.lines.find((l) => l.sourceLabel === "Boiler gas")!.reportLabel, "Natural gas");
    assert.deepEqual(groupReportingTemplateLines(current!.lines).map((g) => [g.scope, g.categories.map((c) => c.categoryCode)]),
      [["1", ["1.natural-gas"]], ["2", ["2.purchased-electricity"]], ["3", ["3.1", null]]]);
    const audit = (await db.query(`SELECT action, after_json FROM nzi_console.audit_events WHERE entity_type = 'client_reporting_template'`)).rows;
    assert.deepEqual(audit.map((a) => a.action), ["client_reporting_template_initialised"]);
    assert.deepEqual(audit[0].after_json.byScope, { "1": 1, "2": 2, "3": 2 });
    assert.ok(!JSON.stringify(audit[0].after_json).includes("Boiler gas"), "the audit carries counts, never a line's label");
    const workspace = await withTenantRead(database.pool, ORG, (tenant) => getClientWorkspace(tenant, CLIENT));
    assert.equal(workspace!.reportingTemplate.current!.lines.length, 5, "on the client workspace");
    assert.ok(workspace!.reportingTemplate.categories.some((c) => c.code === "1.natural-gas"), "with the categories a line may be filed under");
  });

  it("a job of only v7 history initialises a template all to file; an empty job, or another client's, is refused", async () => {
    await assert.rejects(() => initialiseClientReportingTemplateFromJob(database.pool, { clientId: CLIENT, expectedVersion: 1, jobId: "job-empty" }, context()), refusedWith("NOTHING_TO_COPY"));
    await assert.rejects(() => initialiseClientReportingTemplateFromJob(database.pool, { clientId: CLIENT, expectedVersion: 1, jobId: "job-theirs" }, context()), refusedWith("JOB_NOT_FOUND"));
    await assert.rejects(() => initialiseClientReportingTemplateFromJob(database.pool, { clientId: CLIENT, expectedVersion: 0, jobId: "job-v7-only" }, context()), /version|conflict/i);
    const v7 = await initialiseClientReportingTemplateFromJob(database.pool, { clientId: CLIENT, expectedVersion: 1, jobId: "job-v7-only" }, context());
    assert.deepEqual([v7.data.version, v7.data.origin], [2, "v7-import"]);
    assert.deepEqual(await shape(), [["1", null, "Diesel (v7)", null, null]]);
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM nzi_console.client_reporting_template_lines WHERE client_id = $1 AND version = 1`, [CLIENT])).rows[0].n, 5, "version 1 is kept, lines and all");
  });

  it("set by hand: the whole template as the next version; the line filed, a site and a factor of the client's own", async () => {
    const set = await setClientReportingTemplate(database.pool, { clientId: CLIENT, expectedVersion: 2, lines: [
      line({ siteId: "site-hq", datasetId: factor.datasetId, factorId: factor.factorId }),
      line({ scope: "1", categoryCode: "1.natural-gas", sourceLabel: "Diesel", reportLabel: "Fleet diesel", unit: "litres" }),
    ] }, context());
    assert.equal(set.data.version, 3);
    assert.deepEqual(await shape(), [["2", "2.purchased-electricity", "Grid electricity", "site-hq", "dataset/factor"], ["1", "1.natural-gas", "Diesel", null, null]]);
    assert.equal((await read()).current!.origin, "manual");
    const refuse = (lines: ReportingTemplateLineInput[], code: string, expectedVersion = 3) =>
      assert.rejects(() => setClientReportingTemplate(database.pool, { clientId: CLIENT, expectedVersion, lines }, context()), refusedWith(code));
    await refuse([line({ siteId: "site-elsewhere" })], "SITE_NOT_FOUND");
    await refuse([line({ datasetId: factor.datasetId, factorId: "no-such-factor" })], "FACTOR_NOT_FOUND");
    await refuse([line({ categoryCode: "1.natural-gas" })], "CATEGORY_SCOPE");
    await refuse([line({ factorId: factor.factorId })], "FACTOR_DATASET");
    await refuse([], "REQUIRED");
    await assert.rejects(() => setClientReportingTemplate(database.pool, { clientId: CLIENT, expectedVersion: 2, lines: [line()] }, context()), /version|conflict/i);
    await assert.rejects(() => setClientReportingTemplate(database.pool, { clientId: CLIENT, expectedVersion: 7, lines: [line()] }, context()), /version|conflict/i, "a version ahead of the record is refused too — no gap in the versions");
  });

  it("a line may keep an archived site the template already cited, never be pointed at one", async () => {
    await db.query(`UPDATE nzi_console.client_sites SET archived = true WHERE site_id = 'site-hq'`);   // archived after the template cited it
    const kept = await setClientReportingTemplate(database.pool, { clientId: CLIENT, expectedVersion: 3, lines: [line({ siteId: "site-hq", reportLabel: "Electricity" })] }, context());
    assert.equal(kept.data.version, 4, "an edit that keeps the archived site it already had is allowed");
    await assert.rejects(() => setClientReportingTemplate(database.pool, { clientId: CLIENT, expectedVersion: 4, lines: [line({ siteId: "site-hq" }), line({ siteId: "site-old", sourceLabel: "Gas" })] }, context()),
      refusedWith("SITE_ARCHIVED"), "pointing a line at an archived site the template never cited is refused");
    await db.query(`UPDATE nzi_console.client_sites SET archived = false WHERE site_id = 'site-hq'`);
  });

  it("withdraws only with a reason — kept, no longer in force — and can be set again", async () => {
    await assert.rejects(() => deactivateClientReportingTemplate(database.pool, { clientId: CLIENT, expectedVersion: 4 }, context()), refusedWith("REQUIRED"));
    const off = await deactivateClientReportingTemplate(database.pool, { clientId: CLIENT, expectedVersion: 4 }, context("client stopped reporting"));
    assert.deepEqual([off.data.version, off.data.active], [5, false]);
    assert.deepEqual(await read(), { current: null, latestVersion: 5 });
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM nzi_console.client_reporting_template_lines WHERE client_id = $1 AND version = 5`, [CLIENT])).rows[0].n, 0, "a withdrawal holds no lines");
    assert.equal((await db.query(`SELECT reason FROM nzi_console.client_reporting_templates WHERE client_id = $1 AND version = 5`, [CLIENT])).rows[0].reason, "client stopped reporting");
    await assert.rejects(() => deactivateClientReportingTemplate(database.pool, { clientId: CLIENT, expectedVersion: 5 }, context("again")), refusedWith("ALREADY_INACTIVE"));
    const again = await setClientReportingTemplate(database.pool, { clientId: CLIENT, expectedVersion: 5, lines: [line()] }, context());
    assert.equal(again.data.version, 6);
    assert.equal((await read()).current!.lines.length, 1);
  });

  it("two writers of the same next version: one wins, the other is told the record moved — never a raw error", async () => {
    // The loser read the latest version before the winner committed. Reproduce that read deterministically: a pool whose
    // read of the latest header still sees version 6, so its insert meets the winner's version 7 at the primary key.
    await setClientReportingTemplate(database.pool, { clientId: CLIENT, expectedVersion: 6, lines: [line()] }, context());
    const stale = { connect: async () => {
      const client = await database.pool.connect();
      const query = client.query.bind(client);
      (client as any).query = (sql: unknown, values?: unknown) => typeof sql === "string" && sql.startsWith("SELECT version, active, origin, origin_ref")
        ? Promise.resolve({ rows: [{ version: 6, active: true, origin: "manual", origin_ref: null, set_by: "x", set_at: new Date() }] })
        : query(sql as never, values as never);
      return client;
    } } as never;
    await assert.rejects(() => setClientReportingTemplate(stale, { clientId: CLIENT, expectedVersion: 6, lines: [line()] }, context()),
      (error: any) => /version conflict/i.test(error.message) && error.code !== "23505");
  });

  it("the tables hold the line on their own: a category of another scope, a factor without its dataset, append-only", async () => {
    const header = (version: number) => db.query(`INSERT INTO nzi_console.client_reporting_templates (organisation_id, client_id, version, origin, set_by, correlation_id) VALUES ($1, $2, $3, 'manual', 'x', 'x')`, [ORG, CLIENT, version]);
    const insertLine = (over: string) => db.query(`INSERT INTO nzi_console.client_reporting_template_lines (organisation_id, client_id, version, line_id, scope, category_code, source_label, dataset_id, factor_id, ordering)
      VALUES ($1, $2, 90, 'l', ${over}, 0)`, [ORG, CLIENT]);
    await header(90);
    await assert.rejects(() => insertLine(`'2', '1.natural-gas', 'x', NULL, NULL`), /client_reporting_template_lines_category_scope/);
    await assert.rejects(() => insertLine(`'2', NULL, 'x', NULL, 'f'`), /client_reporting_template_lines_factor_dataset/);
    await assert.rejects(() => db.query(`INSERT INTO nzi_console.client_reporting_templates (organisation_id, client_id, version, origin, set_by, correlation_id) VALUES ($1, $2, 91, 'job', 'x', 'x')`, [ORG, CLIENT]),
      /client_reporting_templates_origin_ref/);
    await assert.rejects(() => db.query(`INSERT INTO nzi_console.client_reporting_templates (organisation_id, client_id, version, active, origin, set_by, correlation_id) VALUES ($1, $2, 92, false, 'manual', 'x', 'x')`, [ORG, CLIENT]),
      /client_reporting_templates_deactivation_reason/);
    for (const table of ["client_reporting_templates", "client_reporting_template_lines"]) {
      const grants = (await db.query(`SELECT privilege_type FROM information_schema.role_table_grants WHERE table_schema = 'nzi_console' AND table_name = $1 AND grantee = 'nzi_console_app' ORDER BY 1`, [table])).rows;
      assert.deepEqual(grants.map((g) => g.privilege_type), ["INSERT", "SELECT"], `${table} is append-only for the application`);
    }
  });
});
