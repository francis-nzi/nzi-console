import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { commandGrantForRole, type CommandContext, type MasterTemplateRowInput } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { archiveMasterTemplate, createMasterTemplate, setMasterTemplateRows } from "../src/masterTemplates";
import { initialiseClientReportingTemplateFromMaster, setClientReportingTemplate } from "../src/clientReportingTemplates";
import { createJob } from "../src/postgresCommands";
import { getClientReportingTemplate } from "../src/clientReportingTemplateRecords";
import { withTenantRead } from "../src/postgres";

/**
 * A client's data entry template, started from a master template, against a real database: each master line becomes a
 * template line (scope, category, labels, unit copied; no site); its factor identity resolves to the newest *active*
 * edition in an *active* dataset — never a stale one, never a draft's; an identity no active edition carries is kept
 * with no factor and counted, not dropped; the next version is written with the master origin and the old one stays;
 * and a new CRP job seeds from the imported version.
 */
const ORG = "demo-nzi-console";
const ACTOR = "ada-master";
const CLIENT = "client-from-master";

describe("a client's data entry template from a master template, against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;
  let keys = 0;
  let master = { masterId: "", rowsVersion: 0 };
  const context = (reason?: string): CommandContext => {
    keys += 1;
    return { organisationId: ORG, actorId: ACTOR, principal: "staff", idempotencyKey: `fm-${keys}`, correlationId: `corr-fm-${keys}`,
      grant: commandGrantForRole("admin", ORG, ACTOR), ...(reason ? { reason } : {}) };
  };
  const issue = (code: string) => (error: any) => error?.issues?.some((i: any) => i.code === code);
  const read = () => withTenantRead(database.pool, ORG, (tenant) => getClientReportingTemplate(tenant, CLIENT));
  const fromMaster = (masterId: string, expectedVersion: number) =>
    initialiseClientReportingTemplateFromMaster(database.pool, { clientId: CLIENT, expectedVersion, masterId }, context());
  const byLabel = async () => new Map((await read()).current!.lines.map((l) => [l.sourceLabel, l]));
  const factors = (dataset: string, status: string, rows: Array<[string, string, string[], boolean?]>) => (async () => {
    await db.query(`INSERT INTO nzi_console.emission_factor_datasets (organisation_id,dataset_id,name,version,valid_from,valid_to,country_code,status,source_name,licence)
                    VALUES ($1,$2,$2,'1',$3,$4,'GB',$5,'Test','Source: test.')`, [ORG, dataset, `${dataset.slice(-4)}-01-01`, `${dataset.slice(-4)}-12-31`, status]);
    for (const [id, unit, scopes, active] of rows) {
      await db.query(`INSERT INTO nzi_console.emission_factors (organisation_id,dataset_id,factor_id,label,activity_unit,kgco2e_per_unit,scopes,active) VALUES ($1,$2,$3,$3,$4,0.2,$5,$6)`,
        [ORG, dataset, id, unit, scopes, active ?? true]);
    }
  })();
  const mrow = (over: Partial<MasterTemplateRowInput>): MasterTemplateRowInput =>
    ({ scope: "2", categoryCode: "2.purchased-electricity", sourceLabel: "Grid electricity", reportLabel: null, factorId: "electricity-uk", unit: "kWh", ...over });

  before(async () => {
    database = (await createDisposableDatabase("clientfrommaster"))!;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,$1)`, [ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    await db.query(`INSERT INTO nzi_console.memberships (organisation_id,user_id,role_id,status,display_name) VALUES ($1,$2,'admin','active','Ada')`, [ORG, ACTOR]);
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
    await db.query(`INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,$2,$2,'active')`, [ORG, CLIENT]);
    // 2025 and 2026 are active editions; 2027 is a draft, newer than both and so the trap for "newest" without "active".
    // `diesel` is retired in 2026, so the newest *active* edition of it is 2025's. `rail-national` lives only in the draft.
    await factors("ft-2025", "active", [["electricity-uk", "kWh", ["2"]], ["natural-gas", "kWh", ["1"]], ["diesel", "litre", ["1"]]]);
    await factors("ft-2026", "active", [["electricity-uk", "kWh", ["2"]], ["natural-gas", "kWh", ["1"]], ["diesel", "litre", ["1"], false]]);
    await factors("ft-2027", "draft", [["electricity-uk", "kWh", ["2"]], ["natural-gas", "kWh", ["1"]], ["rail-national", "passenger.km", ["3.6"]]]);

    const created = await createMasterTemplate(database.pool, { name: "Test master" }, context());
    const rows: MasterTemplateRowInput[] = [
      mrow({}),
      mrow({ scope: "1", categoryCode: "1.natural-gas", sourceLabel: "Boiler gas", reportLabel: "Natural gas", factorId: "natural-gas" }),
      mrow({ scope: "1", categoryCode: "1.natural-gas", sourceLabel: "Backup generator", factorId: "diesel", unit: "litre" }),
      mrow({ scope: "3", categoryCode: "3.6", sourceLabel: "Rail travel", factorId: "rail-national", unit: "passenger.km" }),
      mrow({ scope: "3", categoryCode: "3.1", sourceLabel: "Paper", factorId: null, unit: "GBP" }),
    ];
    const set = await setMasterTemplateRows(database.pool, { masterId: created.data.masterId, expectedVersion: created.data.version, rows }, context());
    master = { masterId: created.data.masterId, rowsVersion: set.data.rowsVersion };
  });
  after(async () => { await db?.end(); await database?.end(); });

  it("seeds the template from the master: its lines, no site, factors resolved to the newest active edition; the rest kept and flagged", async () => {
    const result = await fromMaster(master.masterId, 0);
    assert.deepEqual([result.data.version, result.data.origin, result.data.lineCount, result.data.needsFactor], [1, "master", 5, 2]);
    assert.deepEqual(result.data.byScope, { "1": 2, "2": 1, "3": 2 });
    const { current } = await read();
    assert.equal(current!.origin, "master");
    assert.equal(current!.originMasterName, "Test master");
    assert.deepEqual(current!.lines.map((l) => l.sourceLabel), ["Grid electricity", "Boiler gas", "Backup generator", "Rail travel", "Paper"], "the master's order");
    const lines = await byLabel();
    assert.ok([...lines.values()].every((l) => l.siteId === null), "a master holds no site: Unallocated");
    const grid = lines.get("Grid electricity")!;
    assert.deepEqual([grid.scope, grid.categoryCode, grid.unit, grid.datasetId, grid.factorId], ["2", "2.purchased-electricity", "kWh", "ft-2026", "electricity-uk"],
      "the 2026 edition — not 2025's (stale), not the 2027 draft's (inactive)");
    const gas = lines.get("Boiler gas")!;
    assert.deepEqual([gas.reportLabel, gas.datasetId, gas.factorId], ["Natural gas", "ft-2026", "natural-gas"]);
    assert.equal(lines.get("Backup generator")!.datasetId, "ft-2025", "a factor retired in the newer edition resolves to the newest edition where it is still active");
    // Unresolvable identity: the line stays, with no factor — and so does a master line that names none.
    const rail = lines.get("Rail travel")!;
    assert.deepEqual([rail.categoryCode, rail.unit, rail.datasetId, rail.factorId], ["3.6", "passenger.km", null, null], "kept and flagged, never dropped");
    assert.deepEqual([lines.get("Paper")!.datasetId, lines.get("Paper")!.factorId], [null, null]);
  });

  it("records the master origin and audits counts only, never a label", async () => {
    const header = (await db.query(`SELECT origin, origin_ref FROM nzi_console.client_reporting_templates WHERE client_id = $1 AND version = 1`, [CLIENT])).rows[0];
    assert.deepEqual([header.origin, header.origin_ref], ["master", `${master.masterId}@${master.rowsVersion}`]);
    const audit = (await db.query(`SELECT action, after_json FROM nzi_console.audit_events WHERE entity_id = $1 AND action = 'client_reporting_template_initialised_from_master'`, [CLIENT])).rows;
    assert.equal(audit.length, 1);
    assert.equal(audit[0].after_json.needsFactor, 2);
    assert.ok(!JSON.stringify(audit[0].after_json).includes("Grid electricity"), "no label in the audit");
  });

  it("over an existing template it writes the next version and keeps the one before", async () => {
    await setClientReportingTemplate(database.pool, { clientId: CLIENT, expectedVersion: 1, lines: [
      { scope: "2", categoryCode: "2.purchased-electricity", sourceLabel: "Hand-made line", reportLabel: null, siteId: null, datasetId: null, factorId: null, unit: "kWh" }] }, context());
    assert.deepEqual((await byLabel()).size, 1);
    const result = await fromMaster(master.masterId, 2);
    assert.deepEqual([result.data.version, result.data.lineCount], [3, 5]);
    assert.equal((await byLabel()).has("Hand-made line"), false, "the master's lines replace the current ones");
    const history = (await db.query(`SELECT version, origin, (SELECT count(*) FROM nzi_console.client_reporting_template_lines l WHERE (l.organisation_id,l.client_id,l.version)=(t.organisation_id,t.client_id,t.version)) AS lines
                                      FROM nzi_console.client_reporting_templates t WHERE client_id = $1 ORDER BY version`, [CLIENT])).rows;
    assert.deepEqual(history.map((h) => [h.version, h.origin, Number(h.lines)]), [[1, "master", 5], [2, "manual", 1], [3, "master", 5]]);
  });

  it("a new CRP job seeds from the imported version", async () => {
    const created = await createJob(database.pool, { clientId: CLIENT, family: "crp", title: "CRP 2026", workflowStage: "Setup", owner: "Ada",
      startDate: "2026-01-01", dueDate: "2027-06-30", reportingPeriodStart: "2026-01-01", reportingPeriodEnd: "2026-12-31" } as never, context());
    const rows = (await db.query<{ source_label: string; quantity: string | null; dataset_id: string | null }>(`SELECT source_label, quantity, dataset_id FROM nzi_console.job_scope_rows WHERE job_id = $1 ORDER BY source_label`, [created.data.jobId])).rows;
    // The seed's own rule (ruled #8/#9): a line with no factor in the job's editions is refused by the row create and counted as
    // skipped — so the flagged lines wait in the template for a factor, and the job gets the lines that resolve (priced at 2026).
    assert.deepEqual(rows.map((r) => [r.source_label, r.dataset_id]), [["Boiler gas", "ft-2026"], ["Grid electricity", "ft-2026"]]);
    assert.ok(rows.every((r) => r.quantity === null));
    const { rows: [config] } = await db.query(`SELECT seeded_template_version FROM nzi_console.job_emissions_config WHERE job_id = $1`, [created.data.jobId]);
    assert.equal(config.seeded_template_version, 3);
  });

  it("refuses what it cannot build from: a stale version, an unknown or archived master, an empty one, another client", async () => {
    await assert.rejects(() => fromMaster(master.masterId, 1), /version conflict/i);
    await assert.rejects(() => fromMaster("master:nope", 3), issue("NOT_FOUND"));
    const empty = await createMasterTemplate(database.pool, { name: "Empty master" }, context());
    await assert.rejects(() => fromMaster(empty.data.masterId, 3), issue("NOTHING_TO_COPY"));
    await archiveMasterTemplate(database.pool, { masterId: master.masterId, expectedVersion: 2 }, context("retired"));
    await assert.rejects(() => fromMaster(master.masterId, 3), issue("ARCHIVED"));
    await assert.rejects(() => initialiseClientReportingTemplateFromMaster(database.pool, { clientId: "no-such-client", expectedVersion: 0, masterId: empty.data.masterId }, context()), /not in your organisation/i);
    assert.equal((await read()).latestVersion, 3, "nothing was written by a refusal");
  });
});
