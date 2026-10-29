import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { commandGrantForRole, type CommandContext, type MasterTemplateRowInput, type StaffRole } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import {
  archiveMasterTemplate, createMasterTemplate, getMasterTemplatesScreen, readMasterTemplateRows, reinstateMasterTemplate, renameMasterTemplate,
  setMasterTemplateRows,
} from "../src/masterTemplates";
import { withTenantRead } from "../src/postgres";

/**
 * Data-entry R1 (0197, ruled 29 Oct 2026) against a real database: the organisation's master templates. Three seeded on
 * every organisation (and on a new one); lines set whole as the next version, the one before still readable; a category
 * required, the activity a factor identity that serves it, offered from the newest edition; renamed, archived with a
 * reason and reinstated — never deleted, read-only while archived; names unique across archived ones; admin.lookups
 * only; audited in counts, never a line's label; the table's own shape (no quantity, site or dataset; append-only lines;
 * no DELETE; tenant-confined).
 */
const ORG = "masters-org";
const OTHER = "masters-other";

describe("master templates (0197), against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let keys = 0;
  const context = (actor: string, role: StaffRole, reason?: string, org = ORG): CommandContext => {
    keys += 1;
    return { organisationId: org, actorId: actor, principal: "staff", idempotencyKey: `mt-${keys}`, correlationId: `corr-mt-${keys}`,
      grant: commandGrantForRole(role, org, actor), ...(reason ? { reason } : {}) };
  };
  const admin = (reason?: string) => context("ada", "admin", reason);
  const q = async (sql: string, params: unknown[] = []) => { const db = await database.admin(); try { return (await db.query(sql, params)).rows; } finally { await db.end(); } };
  const asApp = async (org: string, sql: string, params: unknown[] = []) => {
    const client = await database.pool.connect();
    try {
      await client.query("BEGIN"); await client.query("SET LOCAL ROLE nzi_console_app");
      await client.query(`SELECT set_config('app.organisation_id', $1, true)`, [org]);
      const rows = (await client.query(sql, params)).rows; await client.query("COMMIT"); return rows;
    } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
  };
  const refused = (code: string) => (error: any) => error.issues?.some((issue: any) => issue.code === code);
  const screen = (org = ORG) => withTenantRead(database.pool, org, (db) => getMasterTemplatesScreen(db));
  const master = async (name: string) => (await screen()).masters.find((m) => m.name === name)!;
  const line = (over: Partial<MasterTemplateRowInput> = {}): MasterTemplateRowInput =>
    ({ scope: "2", categoryCode: "2.purchased-electricity", sourceLabel: "Grid electricity", reportLabel: null, factorId: "electricity-uk", unit: "kWh", ...over });

  before(async () => {
    database = (await createDisposableDatabase("mastertemplates"))!;
    for (const org of [ORG, OTHER]) {
      // The trigger seeds the three masters as each organisation is inserted.
      await q(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $1)`, [org]);
      await q(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name) VALUES ($1, 'ada', 'admin', 'active', 'Ada Admin'), ($1, 'cal', 'consultant', 'active', 'Cal')`, [org]);
    }
    // Two editions; the newest decides an identity's scopes and unit. A factor's identity is made by 0125's trigger.
    for (const [dataset, from, to] of [["desnz-2025", "2025-01-01", "2025-12-31"], ["desnz-2026", "2026-01-01", "2026-12-31"]] as const) {
      await q(`INSERT INTO nzi_console.emission_factor_datasets (organisation_id,dataset_id,name,version,valid_from,valid_to,country_code,status,source_name,licence)
               VALUES ($1,$2,$2,'1',$3,$4,'GB','active','DESNZ','Source: test.')`, [ORG, dataset, from, to]);
    }
    const factor = (dataset: string, id: string, label: string, unit: string, scopes: string[]) => q(
      `INSERT INTO nzi_console.emission_factors (organisation_id,dataset_id,factor_id,label,activity_unit,kgco2e_per_unit,scopes) VALUES ($1,$2,$3,$4,$5,0.2,$6)`,
      [ORG, dataset, id, label, unit, scopes]);
    await factor("desnz-2025", "electricity-uk", "Electricity: UK", "kWh", ["2"]);
    await factor("desnz-2026", "electricity-uk", "Electricity: UK", "kWh", ["2"]);
    await factor("desnz-2026", "natural-gas", "Natural gas", "kWh", ["1"]);
    await factor("desnz-2026", "rail-national", "National rail", "passenger.km", ["3.6"]);
    // Scope 3.1 in 2025, moved to 3.4 in 2026: the newest edition is the one a master offers.
    await factor("desnz-2025", "freight-van", "Van freight", "tonne.km", ["3.1"]);
    await factor("desnz-2026", "freight-van", "Van freight", "tonne.km", ["3.4"]);
  });
  after(async () => { await database?.end(); });

  it("seeds Default, Construction and Office on every organisation, empty — and on a new one", async () => {
    for (const org of [ORG, OTHER]) {
      const { masters } = await screen(org);
      assert.deepEqual(masters.map((m) => [m.masterId, m.name, m.active, m.rowsVersion, m.rows.length]),
        [["master:construction", "Construction", true, 0, 0], ["master:default", "Default", true, 0, 0], ["master:office", "Office", true, 0, 0]], org);
    }
    // The provisioning is idempotent by name: re-running it on an organisation adds nothing.
    assert.equal((await q(`SELECT nzi_console.provision_organisation_master_templates($1, 'test') AS n`, [ORG]))[0]!.n, 0);
  });

  it("offers each identity once, from its newest edition, with that edition's scopes and unit", async () => {
    const { factors } = await screen();
    assert.deepEqual(factors.map((f) => [f.factorId, f.unit, f.scopes]), [
      ["electricity-uk", "kWh", ["2"]], ["rail-national", "passenger.km", ["3.6"]], ["natural-gas", "kWh", ["1"]], ["freight-van", "tonne.km", ["3.4"]]]);
  });

  it("sets the lines whole as the next version; the version before stays readable; the audit is counts, never a label", async () => {
    const before = await master("Default");
    const first = await setMasterTemplateRows(database.pool, { masterId: before.masterId, expectedVersion: before.version, rows: [
      line(), line({ scope: "1", categoryCode: "1.natural-gas", sourceLabel: "Boiler gas", factorId: "natural-gas" }),
      line({ scope: "3", categoryCode: "3.1", sourceLabel: "Purchased goods (spend)", factorId: null, unit: null }),
    ] }, admin());
    assert.deepEqual([first.data.rowsVersion, first.data.lineCount, first.data.byScope, first.data.withFactor], [1, 3, { "1": 1, "2": 1, "3": 1 }, 2]);
    const v1 = await master("Default");
    assert.deepEqual(v1.rows.map((r) => [r.scope, r.categoryCode, r.sourceLabel, r.factorId, r.factorLabel]), [
      ["2", "2.purchased-electricity", "Grid electricity", "electricity-uk", "Electricity: UK"],
      ["1", "1.natural-gas", "Boiler gas", "natural-gas", "Natural gas"],
      ["3", "3.1", "Purchased goods (spend)", null, null]]);

    const second = await setMasterTemplateRows(database.pool, { masterId: v1.masterId, expectedVersion: v1.version, rows: [line({ scope: "3", categoryCode: "3.6", sourceLabel: "Rail", factorId: "rail-national", unit: "passenger.km" })] }, admin());
    assert.equal(second.data.rowsVersion, 2);
    assert.deepEqual((await master("Default")).rows.map((r) => r.sourceLabel), ["Rail"]);
    // v1 is still in the record, whole.
    assert.equal((await withTenantRead(database.pool, ORG, (db) => readMasterTemplateRows(db, v1.masterId, 1))).length, 3);

    const [audit] = await q(`SELECT before_json, after_json FROM nzi_console.audit_events WHERE action = 'master_template.rows_set' AND entity_id = $1 ORDER BY occurred_at DESC LIMIT 1`, [v1.masterId]);
    assert.equal(audit!.before_json.lineCount, 3);
    assert.equal(audit!.after_json.lineCount, 1);
    for (const label of ["Grid electricity", "Boiler gas", "Rail", "Purchased goods"]) assert.ok(!JSON.stringify(audit).includes(label), `${label} is not in the audit`);
  });

  it("refuses a line whose category is missing, retired-and-new, or whose activity is not the category's — and a stale version", async () => {
    const current = await master("Office");
    const set = (rows: MasterTemplateRowInput[], expectedVersion = current.version) => setMasterTemplateRows(database.pool, { masterId: current.masterId, expectedVersion, rows }, admin());
    await assert.rejects(set([line({ categoryCode: "2.nope" })]), refused("CATEGORY_NOT_FOUND"));
    await assert.rejects(set([line({ factorId: "natural-gas" })]), refused("FACTOR_CATEGORY"), "gas is not electricity");
    await assert.rejects(set([line({ factorId: "no-such-factor" })]), refused("FACTOR_NOT_FOUND"));
    // Filed by the newest edition: van freight is 3.4 now, not 3.1.
    await assert.rejects(set([line({ scope: "3", categoryCode: "3.1", factorId: "freight-van" })]), refused("FACTOR_CATEGORY"));
    await set([line({ scope: "3", categoryCode: "3.4", sourceLabel: "Deliveries", factorId: "freight-van", unit: "tonne.km" })]);
    await assert.rejects(set([line()]), /version/i, "the header moved on");
    // A retired category still resolves for the lines that already file under it, and is never newly chosen.
    await q(`UPDATE nzi_console.input_spec_categories SET active = false WHERE category_code = '3.4'`);
    try {
      const now = await master("Office");
      await setMasterTemplateRows(database.pool, { masterId: now.masterId, expectedVersion: now.version, rows: [line({ scope: "3", categoryCode: "3.4", sourceLabel: "Deliveries (kept)", factorId: "freight-van" })] }, admin());
      const construction = await master("Construction");
      await assert.rejects(setMasterTemplateRows(database.pool, { masterId: construction.masterId, expectedVersion: construction.version, rows: [line({ scope: "3", categoryCode: "3.4", factorId: "freight-van" })] }, admin()), refused("CATEGORY_RETIRED"));
    } finally { await q(`UPDATE nzi_console.input_spec_categories SET active = true WHERE category_code = '3.4'`); }
  });

  it("refuses a quantity, a site or a dataset at the contract — no template holds a figure", async () => {
    const current = await master("Construction");
    await assert.rejects(setMasterTemplateRows(database.pool, { masterId: current.masterId, expectedVersion: current.version, rows: [{ ...line(), quantity: 1200 } as never] }, admin()), refused("QUANTITY_NOT_HELD"));
    await assert.rejects(setMasterTemplateRows(database.pool, { masterId: current.masterId, expectedVersion: current.version, rows: [{ ...line(), siteId: "site-hq" } as never] }, admin()), refused("NOT_HELD"));
    assert.deepEqual((await q(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'nzi_console' AND table_name = 'master_template_rows'
      AND (column_name LIKE '%quantity%' OR column_name LIKE 'site%' OR column_name LIKE 'dataset%' OR column_name LIKE '%tco2e%' OR column_name LIKE 'monthly%')`)), [], "the table has nowhere to put one");
  });

  it("creates, renames, archives with a reason and reinstates — names unique across archived ones; read-only while archived", async () => {
    const created = await createMasterTemplate(database.pool, { name: "  Retail   store " }, admin());
    assert.deepEqual([created.data.name, created.data.version, created.data.rowsVersion], ["Retail store", 1, 0]);
    await assert.rejects(createMasterTemplate(database.pool, { name: "OFFICE" }, admin()), refused("DUPLICATE"), "case-insensitive");
    const renamed = await renameMasterTemplate(database.pool, { masterId: created.data.masterId, expectedVersion: 1, name: "Retail" }, admin());
    await assert.rejects(renameMasterTemplate(database.pool, { masterId: created.data.masterId, expectedVersion: renamed.data.version, name: "Retail" }, admin()), refused("UNCHANGED"));
    await assert.rejects(archiveMasterTemplate(database.pool, { masterId: created.data.masterId, expectedVersion: renamed.data.version }, admin()), (error: any) => error.issues?.some((issue: any) => issue.field === "reason"));
    const archived = await archiveMasterTemplate(database.pool, { masterId: created.data.masterId, expectedVersion: renamed.data.version }, admin("Folded into Office"));
    assert.equal(archived.data.active, false);
    const held = (await screen()).masters.find((m) => m.masterId === created.data.masterId)!;
    assert.deepEqual([held.active, held.archivedReason], [false, "Folded into Office"]);
    assert.equal((await screen()).masters.at(-1)!.masterId, created.data.masterId, "archived masters list after the active ones");
    // An archived name is still taken, and an archived master takes no change until it is reinstated.
    await assert.rejects(createMasterTemplate(database.pool, { name: "retail" }, admin()), refused("DUPLICATE"));
    await assert.rejects(setMasterTemplateRows(database.pool, { masterId: created.data.masterId, expectedVersion: archived.data.version, rows: [line()] }, admin()), refused("ARCHIVED"));
    await assert.rejects(renameMasterTemplate(database.pool, { masterId: created.data.masterId, expectedVersion: archived.data.version, name: "Shop" }, admin()), refused("ARCHIVED"));
    await assert.rejects(archiveMasterTemplate(database.pool, { masterId: created.data.masterId, expectedVersion: archived.data.version }, admin("again")), refused("ALREADY_ARCHIVED"));
    const back = await reinstateMasterTemplate(database.pool, { masterId: created.data.masterId, expectedVersion: archived.data.version }, admin());
    assert.equal(back.data.active, true);
    assert.equal((await q(`SELECT archived_reason FROM nzi_console.master_templates WHERE master_id = $1`, [created.data.masterId]))[0]!.archived_reason, null);
    const actions = (await q(`SELECT action FROM nzi_console.audit_events WHERE entity_id = $1 ORDER BY occurred_at`, [created.data.masterId])).map((row) => row.action);
    assert.deepEqual(actions, ["master_template.created", "master_template.renamed", "master_template.archived", "master_template.reinstated"]);
  });

  it("is admin.lookups only: a consultant cannot create, rename, archive or set lines", async () => {
    const office = await master("Office");
    const cal = () => context("cal", "consultant", "because");
    await assert.rejects(createMasterTemplate(database.pool, { name: "Mine" }, cal()), /admin\.lookups|permission/i);
    await assert.rejects(renameMasterTemplate(database.pool, { masterId: office.masterId, expectedVersion: office.version, name: "Mine" }, cal()), /admin\.lookups|permission/i);
    await assert.rejects(archiveMasterTemplate(database.pool, { masterId: office.masterId, expectedVersion: office.version }, cal()), /admin\.lookups|permission/i);
    await assert.rejects(setMasterTemplateRows(database.pool, { masterId: office.masterId, expectedVersion: office.version, rows: [] }, cal()), /admin\.lookups|permission/i);
  });

  it("holds its own shape: lines append-only, nothing deleted, a line's category and scope agree, confined to its organisation", async () => {
    const office = await master("Office");
    await assert.rejects(asApp(ORG, `UPDATE nzi_console.master_template_rows SET source_label = 'x'`), /permission denied/);
    await assert.rejects(asApp(ORG, `DELETE FROM nzi_console.master_template_rows`), /permission denied/);
    await assert.rejects(asApp(ORG, `DELETE FROM nzi_console.master_templates`), /permission denied/);
    await assert.rejects(asApp(ORG, `UPDATE nzi_console.master_templates SET master_id = 'moved'`), /permission denied/);
    await assert.rejects(asApp(ORG, `UPDATE nzi_console.master_templates SET active = false WHERE master_id = 'master:office'`), /master_templates_archive_reason/, "an archive says why");
    await assert.rejects(asApp(ORG, `INSERT INTO nzi_console.master_template_rows (organisation_id, master_id, rows_version, row_id, scope, category_code, source_label, ordering)
      VALUES ($1, $2, 99, 'r', '1', '2.purchased-electricity', 'x', 0)`, [ORG, office.masterId]), /master_template_rows_category_scope/);
    // The other organisation sees only its own three, and cannot write into this one's.
    assert.deepEqual((await screen(OTHER)).masters.map((m) => m.rowsVersion), [0, 0, 0]);
    assert.equal((await asApp(OTHER, `SELECT count(*)::int AS n FROM nzi_console.master_template_rows`))[0]!.n, 0);
    await assert.rejects(asApp(OTHER, `INSERT INTO nzi_console.master_templates (organisation_id, master_id, name, created_by, updated_by) VALUES ($1, 'x', 'Smuggled', 't', 't')`, [ORG]), /row-level security/);
  });
});
