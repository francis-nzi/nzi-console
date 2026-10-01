import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { commandGrantForRole, type CommandContext, type StaffRole } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { syntheticExtract, syntheticRows } from "./support/v7SyntheticExtract";
import {
  createJobItem, deactivateJobItem, listJobItemPickers, listJobItemsPage, reinstateJobItem, setJobItemPrice, updateJobItem,
} from "../src/serviceCatalogue";
import { withTenantRead } from "../src/postgres";
import type { V7Row, V7Table } from "../src/v7ClientExtract";
import { JOB_ITEMS_RUN_PREFIX, loadV7JobItems, planV7JobItems } from "../src/v7JobItemsLoad";

/**
 * The service catalogue (admin Phase E2; ruled `phaseE-commercial-catalogue-plan.md`, E-Q4/E-Q5/E-Q8/E-Q9) against a real
 * database: 0146's guarantees (a code set once, nothing deleted, tenant-confined), the definition commands
 * (admin.lookups; references checked, a held one standing), the amounts (finance.manage only, and never in the audit),
 * and load:v7-job-items (references resolved against the organisation, one currency, R4, amounts never reported).
 */
const ORG = "catalogue-org";
const OTHER = "catalogue-other";
const LOAD = "catalogue-load";
type Rows = ReturnType<typeof syntheticRows>;
const extract = (mutate?: (rows: Rows) => void): Partial<Record<V7Table, V7Row[]>> => { const rows = syntheticRows(); mutate?.(rows); return syntheticExtract(rows); };
const page = { search: "", filters: {}, sort: { key: "sortOrder" as const, dir: "asc" as const }, page: 1, pageSize: 50 };

describe("planning the catalogue import (no database)", () => {
  const plan = planV7JobItems(extract());

  it("parses each item, upper-casing its code, and leaves out one whose cost and sell currencies differ (E-Q9)", () => {
    assert.deepEqual(plan.values.map((value) => [value.code, value.categoryText, value.unitText, value.defaultHours, value.vatLegacyId, value.vatPct, value.active]), [
      ["ASSESS", "Assessment", "day", 7.5, "1", 20, true],
      ["REPORT", "Reporting", "days", 0, null, 5, true],
      ["WIDGET", "Gadgets", "fortnight", null, null, null, true],
      ["MONTHLY", "Ongoing", "month", 4, "1", 20, false],
    ]);
    assert.deepEqual(plan.skipped, [{ legacyDbId: "4", reason: "cost in USD but sell in GBP: the catalogue holds one currency (E-Q9)" }]);
    assert.deepEqual(plan.values.find((value) => value.code === "WIDGET")!.sellAmount, null, "unpriced stays unpriced");
  });

  it("leaves out a code that cannot be a console code, and a second item with the same code", () => {
    const odd = planV7JobItems(extract((rows) => {
      rows.job_items.push({ item_id: "6", item_code: "has space", item_name: "Spaced", is_active: "t" });
      rows.job_items.push({ item_id: "7", item_code: "assess", item_name: "Again", is_active: "t" });
    }));
    assert.deepEqual(odd.skipped.map((skip) => [skip.legacyDbId, skip.reason]).slice(1), [
      ["6", "code \"has space\" is not a console code (upper-case letters, digits, - and _, up to 30)"], ["7", "the same code as v7 item 1"]]);
  });
});

describe("the service catalogue, against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let keys = 0;
  const context = (actor: string, role: StaffRole, org = ORG, reason?: string): CommandContext => {
    keys += 1;
    return { organisationId: org, actorId: actor, principal: "staff", idempotencyKey: `cat-${keys}`, correlationId: `corr-cat-${keys}`, ...(reason ? { reason } : {}), grant: commandGrantForRole(role, org, actor) };
  };
  const q = async (sql: string, params: unknown[] = []) => { const db = await database.admin(); try { return (await db.query(sql, params)).rows; } finally { await db.end(); } };
  const asApp = async (org: string, sql: string, params: unknown[] = []) => {
    const client = await database.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE nzi_console_app");
      await client.query(`SELECT set_config('app.organisation_id', $1, true)`, [org]);
      const rows = (await client.query(sql, params)).rows;
      await client.query("COMMIT");
      return rows;
    } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
  };
  /** The lookups and VAT rates an organisation holds before the catalogue (A3 and C4 imported them). */
  const seedLookups = async (org: string) => {
    const values: Array<[string, string, string]> = [
      ["job_item_categories", "cat-assess", "Assessment"], ["job_item_categories", "cat-report", "Reporting"], ["job_item_categories", "cat-advisory", "Advisory"],
      ["job_item_categories", "cat-ongoing", "Ongoing"], ["job_item_categories", "cat-retired", "Retired category"],
      ["units_of_measure", "uom-days", "days"], ["units_of_measure", "uom-months", "months"], ["industries", "ind-x", "Not a category"],
    ];
    for (const [key, id, label] of values) {
      await q(`INSERT INTO nzi_console.reference_values (organisation_id, category_key, value_id, label, created_by, updated_by) VALUES ($1, $2, $3, $4, 'seed', 'seed')`, [org, key, `${org}:${id}`, label]);
    }
    await q(`UPDATE nzi_console.reference_values SET active = false WHERE value_id = $1`, [`${org}:cat-retired`]);
    await q(`INSERT INTO nzi_console.vat_rates (organisation_id, vat_rate_id, name, rate_pct, is_default, source_system, legacy_db_id, legacy_values, created_by, updated_by) VALUES
      ($1, 'vat:v7-1', 'Standard', 20, true, 'nzi-pro-v7', '1', '{}'::jsonb, 'seed', 'seed'), ($1, 'vat:reduced', 'Reduced', 5, false, NULL, NULL, NULL, 'seed', 'seed')`, [org]);
  };

  before(async () => {
    database = (await createDisposableDatabase("servicecatalogue"))!;
    for (const org of [ORG, OTHER, LOAD]) {
      await q(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $1)`, [org]); // 0145 provisions GBP, the default
      await q(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name) VALUES
        ($1, 'ada', 'admin', 'active', 'Ada Admin'), ($1, 'cal', 'consultant', 'active', 'Cal Consultant'), ($1, 'fin', 'finance', 'active', 'Fin Finance')`, [org]);
      await seedLookups(org);
    }
  });
  after(async () => { await database?.end(); });

  describe("the definition (admin.lookups)", () => {
    it("adds an item with a code set once, in the organisation's currency, unpriced", async () => {
      const made = await createJobItem(database.pool, { itemCode: "ASSESS", name: "Carbon assessment", categoryValueId: `${ORG}:cat-assess`, unitValueId: `${ORG}:uom-days`,
        defaultHours: 7.5, vatRateId: "vat:v7-1" }, context("ada", "admin"));
      assert.deepEqual([made.data.code, made.data.currency, made.data.defaultHours, made.data.sortOrder], ["ASSESS", "GBP", 7.5, 10]);
      const [row] = await q(`SELECT default_cost_amount, default_sell_amount FROM nzi_console.job_items WHERE item_id = $1`, [made.data.itemId]);
      assert.deepEqual([row.default_cost_amount, row.default_sell_amount], [null, null]);
      await assert.rejects(createJobItem(database.pool, { itemCode: "assess", name: "Lower", }, context("ada", "admin")), /Command validation failed/, "the pattern is upper-case");
      await assert.rejects(createJobItem(database.pool, { itemCode: "ASSESS", name: "Again" }, context("ada", "admin")), /Command validation failed/, "a code is one item's");
    });

    it("checks each reference's kind and state — and lets a held one stand once deactivated", async () => {
      const refused = (field: string, code: string) => (error: Error & { issues?: Array<{ field: string; code: string }> }) => error.issues?.some((issue) => issue.field === field && issue.code === code) === true;
      await assert.rejects(createJobItem(database.pool, { itemCode: "X1", name: "Wrong kind", categoryValueId: `${ORG}:uom-days` }, context("ada", "admin")), refused("categoryValueId", "NOT_FOUND"));
      await assert.rejects(createJobItem(database.pool, { itemCode: "X2", name: "Not a category", categoryValueId: `${ORG}:ind-x` }, context("ada", "admin")), refused("categoryValueId", "NOT_FOUND"));
      await assert.rejects(createJobItem(database.pool, { itemCode: "X3", name: "Retired", categoryValueId: `${ORG}:cat-retired` }, context("ada", "admin")), refused("categoryValueId", "INACTIVE"));
      await assert.rejects(createJobItem(database.pool, { itemCode: "X4", name: "Other org's", unitValueId: `${OTHER}:uom-days` }, context("ada", "admin")), refused("unitValueId", "NOT_FOUND"));
      const made = await createJobItem(database.pool, { itemCode: "REPORT", name: "Report", categoryValueId: `${ORG}:cat-report`, vatRateId: "vat:reduced" }, context("ada", "admin"));
      await q(`UPDATE nzi_console.reference_values SET active = false WHERE value_id = $1`, [`${ORG}:cat-report`]);
      await q(`UPDATE nzi_console.vat_rates SET active = false WHERE vat_rate_id = 'vat:reduced' AND organisation_id = $1`, [ORG]);
      const edited = await updateJobItem(database.pool, { itemId: made.data.itemId, expectedVersion: 1, name: "Carbon report", categoryValueId: `${ORG}:cat-report`, vatRateId: "vat:reduced" }, context("ada", "admin"));
      assert.equal(edited.data.name, "Carbon report", "held references stand (R3)");
      await q(`UPDATE nzi_console.reference_values SET active = true WHERE value_id = $1`, [`${ORG}:cat-report`]);
      await q(`UPDATE nzi_console.vat_rates SET active = true WHERE vat_rate_id = 'vat:reduced' AND organisation_id = $1`, [ORG]);
    });

    it("deactivates and reinstates, with a reason; a consultant may not add an item", async () => {
      const [row] = await q(`SELECT item_id, version FROM nzi_console.job_items WHERE organisation_id = $1 AND item_code = 'REPORT'`, [ORG]);
      const off = await deactivateJobItem(database.pool, { itemId: row.item_id, expectedVersion: row.version }, context("ada", "admin", ORG, "Folded into ASSESS"));
      await reinstateJobItem(database.pool, { itemId: row.item_id, expectedVersion: off.data.version }, context("ada", "admin"));
      await assert.rejects(createJobItem(database.pool, { itemCode: "CAL", name: "Consultant's" }, context("cal", "consultant")), /admin\.lookups|permission/i);
    });

    it("sets a code once and deletes nothing: the app role cannot change a code or delete an item; tenant-confined", async () => {
      await assert.rejects(asApp(ORG, `UPDATE nzi_console.job_items SET item_code = 'NEW' WHERE item_code = 'ASSESS'`), /permission denied/);
      await assert.rejects(asApp(ORG, `DELETE FROM nzi_console.job_items WHERE item_code = 'ASSESS'`), /permission denied/);
      assert.equal((await asApp(OTHER, `SELECT count(*)::int AS n FROM nzi_console.job_items`))[0].n, 0);
    });
  });

  describe("the amounts (finance.manage, never in the audit)", () => {
    it("lets Admin and Finance price an item; a Consultant may not; the audit says which amounts, never the figures", async () => {
      const [row] = await q(`SELECT item_id, version FROM nzi_console.job_items WHERE organisation_id = $1 AND item_code = 'ASSESS'`, [ORG]);
      await assert.rejects(setJobItemPrice(database.pool, { itemId: row.item_id, expectedVersion: row.version, defaultCostAmount: 350, defaultSellAmount: 750.25 }, context("cal", "consultant")), /finance\.manage|permission/i);
      const priced = await setJobItemPrice(database.pool, { itemId: row.item_id, expectedVersion: row.version, defaultCostAmount: 350, defaultSellAmount: 750.25 }, context("fin", "finance"));
      assert.deepEqual([priced.data.changed, priced.data.currency], [["defaultCostAmount", "defaultSellAmount"], "GBP"]);
      const again = await setJobItemPrice(database.pool, { itemId: row.item_id, expectedVersion: priced.data.version, defaultCostAmount: 350, defaultSellAmount: 799 }, context("ada", "admin"));
      assert.deepEqual(again.data.changed, ["defaultSellAmount"]);
      await assert.rejects(setJobItemPrice(database.pool, { itemId: row.item_id, expectedVersion: again.data.version, defaultCostAmount: 350, defaultSellAmount: 799 }, context("ada", "admin")), /Command validation failed/, "unchanged is refused");
      const trail = JSON.stringify(await q(`SELECT after_json, before_json FROM nzi_console.audit_events WHERE organisation_id = $1 AND entity_id = $2`, [ORG, row.item_id]));
      for (const figure of ["350", "750", "799"]) assert.ok(!trail.includes(figure), `the audit never carries ${figure}`);
      const records = await q(`SELECT outcome_json FROM nzi_console.command_idempotency WHERE organisation_id = $1 AND command_key = 'job_item.price.set'`, [ORG]);
      assert.equal(records.length, 2, "both price commands are recorded");
      for (const figure of ["750", "799"]) assert.ok(!JSON.stringify(records).includes(figure), `the idempotency record never carries ${figure}`);
      const outbox = await q(`SELECT * FROM nzi_console.transactional_outbox WHERE organisation_id = $1`, [ORG]);
      assert.ok(outbox.length > 0);
      for (const figure of ["750", "799"]) assert.ok(!JSON.stringify(outbox).includes(figure), `the outbox never carries ${figure}`);
    });

    it("shows the amounts only to a reader holding finance.manage — never 0 for hidden", async () => {
      const shown = await withTenantRead(database.pool, ORG, (db) => listJobItemsPage(db, page, { showAmounts: true }));
      const hidden = await withTenantRead(database.pool, ORG, (db) => listJobItemsPage(db, page, { showAmounts: false }));
      assert.deepEqual(shown.rows.find((row) => row.code === "ASSESS")!.amounts, { cost: 350, sell: 799 });
      assert.deepEqual(shown.rows.find((row) => row.code === "REPORT")!.amounts, { cost: null, sell: null }, "unpriced");
      assert.ok(hidden.rows.every((row) => row.amounts === null));
      const assess = shown.rows.find((row) => row.code === "ASSESS")!;
      assert.deepEqual([assess.category, assess.unit, assess.vatRate, assess.currency, assess.provenance], ["Assessment", "days", "Standard · 20%", "GBP", "added"]);
      const pickers = await withTenantRead(database.pool, ORG, (db) => listJobItemPickers(db, ORG));
      assert.deepEqual([pickers.categories.length, pickers.units.length, pickers.vatRates.length, pickers.currency], [5, 2, 2, "GBP"]);
    });
  });

  describe("load:v7-job-items", () => {
    it("resolves references against the organisation, inserts, notes what does not resolve, and refuses nothing it can load", async () => {
      // A person's item already holding v7's code MONTHLY: it is stamped, and its own definition stands.
      await createJobItem(database.pool, { itemCode: "MONTHLY", name: "Our monthly service" }, context("ada", "admin", LOAD));
      const dry = await loadV7JobItems(database.pool, LOAD, planV7JobItems(extract()), { commit: false });
      assert.deepEqual([dry.inserted, dry.stamped], [3, 1]);
      assert.equal((await q(`SELECT count(*)::int AS n FROM nzi_console.job_items WHERE organisation_id = $1`, [LOAD]))[0].n, 1, "a dry run writes nothing");

      const outcome = await loadV7JobItems(database.pool, LOAD, planV7JobItems(extract()), { commit: true, runId: `${JOB_ITEMS_RUN_PREFIX}first` });
      assert.deepEqual([outcome.inserted, outcome.stamped, outcome.updated, outcome.unchanged, outcome.refused], [3, 1, 0, 0, []]);
      assert.deepEqual(outcome.notes.sort(), [
        "MONTHLY: already held here — stamped with v7's identity; its own definition and amounts stand",
        "WIDGET: v7's category \"Gadgets\" is not a job item category here — left blank",
        "WIDGET: v7's unit \"fortnight\" is not a unit of measure here — left blank",
      ]);
      const rows = await q(`SELECT item_code, name, category_value_id, unit_value_id, vat_rate_id, active, default_sell_amount IS NOT NULL AS priced
                              FROM nzi_console.job_items WHERE organisation_id = $1 ORDER BY item_code`, [LOAD]);
      assert.deepEqual(rows.map((row) => [row.item_code, row.category_value_id, row.unit_value_id, row.vat_rate_id, row.active, row.priced]), [
        ["ASSESS", `${LOAD}:cat-assess`, `${LOAD}:uom-days`, "vat:v7-1", true, true],
        ["MONTHLY", null, null, null, true, false],
        ["REPORT", `${LOAD}:cat-report`, `${LOAD}:uom-days`, "vat:reduced", true, true],
        ["WIDGET", null, null, null, true, false],
      ]);
      assert.equal(rows.find((row) => row.item_code === "MONTHLY")!.name, "Our monthly service", "a person's item keeps its own definition");
      assert.equal(outcome.priced, 2);
      const audit = JSON.stringify(await q(`SELECT after_json FROM nzi_console.audit_events WHERE organisation_id = $1 AND action = 'job_items.imported'`, [LOAD]));
      for (const figure of ["750", "500", "350"]) assert.ok(!audit.includes(figure), `the import's audit never carries ${figure}`);
    });

    it("re-run unchanged writes nothing; v7 changed and still as imported → v7 wins; edited here since → refused (R4) — never printing an amount", async () => {
      const unchanged = await loadV7JobItems(database.pool, LOAD, planV7JobItems(extract()), { commit: true, runId: `${JOB_ITEMS_RUN_PREFIX}second` });
      assert.deepEqual([unchanged.inserted, unchanged.updated, unchanged.unchanged], [0, 0, 4]);
      const [report] = await q(`SELECT item_id, version FROM nzi_console.job_items WHERE organisation_id = $1 AND item_code = 'REPORT'`, [LOAD]);
      await updateJobItem(database.pool, { itemId: report.item_id, expectedVersion: report.version, name: "Report, edited here" }, context("ada", "admin", LOAD));
      const changed = extract((rows) => { rows.job_items[0]!.sell_amount = "780.00"; rows.job_items[1]!.item_name = "Report, as v7 renamed it"; });
      const outcome = await loadV7JobItems(database.pool, LOAD, planV7JobItems(changed), { commit: true, runId: `${JOB_ITEMS_RUN_PREFIX}third` });
      assert.deepEqual([outcome.updated, outcome.refused], [1, ["REPORT: changed in v7 since the last load, and edited here since (R4)"]]);
      assert.ok(!JSON.stringify(outcome).includes("780"), "the outcome never carries an amount");
      assert.equal(Number((await q(`SELECT default_sell_amount FROM nzi_console.job_items WHERE organisation_id = $1 AND item_code = 'ASSESS'`, [LOAD]))[0].default_sell_amount), 780);
    });

    it("refuses an item in a currency the organisation does not sell in (E-Q9)", async () => {
      const outcome = await loadV7JobItems(database.pool, LOAD, planV7JobItems(extract((rows) => {
        rows.job_items.push({ item_id: "9", item_code: "EURO", item_name: "Euro work", cost_currency: "EUR", sell_currency: "EUR", sell_amount: "10", is_active: "t" });
      })), { commit: false });
      assert.ok(outcome.refused.includes("EURO: in EUR, but this organisation sells in GBP (E-Q9: one currency per catalogue)"));
    });
  });
});
