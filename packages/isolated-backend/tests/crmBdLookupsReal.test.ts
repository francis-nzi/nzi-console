import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { bdStageListSpec, commandGrantForRole, defaultListQuery, type CommandContext, type StaffRole } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { syntheticExtract, syntheticRows } from "./support/v7SyntheticExtract";
import { createBdStage, deactivateBdStage, listBdStagesPage, reinstateBdStage, updateBdStage } from "../src/bdFunnelStages";
import { withTenantRead } from "../src/postgres";
import { createReferenceValue } from "../src/referenceEngine";
import type { V7Row, V7Table } from "../src/v7ClientExtract";
import { CRM_BD_RUN_PREFIX, loadV7CrmBdLookup, loadV7FunnelStages, planV7CrmBdLookup, planV7FunnelStages } from "../src/v7CrmBdLoad";

/**
 * CRM and BD lookups (admin Phase F2; ruled `phaseF-comms-crm-plan.md`, F-Q4) against a real database: 0150's two lookup
 * categories (migration-owned; service lines carrying a code), the typed funnel (a key set once, a probability, ordered
 * with no default flag, the last active stage kept, nothing deleted, tenant-confined), and the three v7 loaders.
 */
const ORG = "crmbd-org";
const OTHER = "crmbd-other";
const LOAD = "crmbd-load";
type Rows = ReturnType<typeof syntheticRows>;
const extract = (mutate?: (rows: Rows) => void): Partial<Record<V7Table, V7Row[]>> => { const rows = syntheticRows(); mutate?.(rows); return syntheticExtract(rows); };
const page = defaultListQuery(bdStageListSpec);

describe("planning the CRM and BD imports (no database)", () => {
  it("takes CRM tags by name, keeping v7's colour only in what v7 held, and leaves out a nameless one", () => {
    const plan = planV7CrmBdLookup("crm-tags", extract());
    assert.deepEqual(plan.values.map((value) => [value.legacyDbId, value.label, value.code, value.active]), [
      ["1", "follow-up", null, true], ["2", "risk", null, true], ["3", "finance", null, true], ["4", "client-waiting", null, false]]);
    assert.equal(plan.values[0]!.legacyValues.colorHex, "#F59E0B");
    assert.deepEqual(plan.skipped, [{ legacyDbId: "5", reason: "a value with no name" }]);
  });

  it("takes BD service lines with v7's key as the code, in v7's order", () => {
    const plan = planV7CrmBdLookup("bd-service-lines", extract());
    assert.deepEqual(plan.values.map((value) => [value.code, value.label, value.sortOrder, value.active]), [
      ["market-targeting", "Industry & Role Targeting", 0, true], ["carbon-reduction-plan", "Carbon Reduction Plans", 1, true],
      ["consultancy", "Consultancy", 3, true], ["life-cycle-assessments", "Life Cycle Assessments (LCA)", 5, false]]);
  });

  it("takes funnel stages with key, order and probability, leaving out a key that cannot be a console key and a repeated name", () => {
    const plan = planV7FunnelStages(extract());
    assert.deepEqual(plan.values.map((value) => [value.key, value.name, value.sortOrder, value.probabilityPct, value.active]), [
      ["lead", "Lead", 1, 10, true], ["qualified", "Qualified", 2, 35, true], ["proposal", "Proposal", 3, 65.5, true], ["closed", "Closed", 4, 100, true]]);
    assert.deepEqual(plan.skipped, [
      { legacyDbId: "5", reason: "key \"On Hold!\" is not a console stage key (lower-case letters, digits and -, up to 40)" },
      { legacyDbId: "6", reason: "the same name as v7 stage 1" }]);
  });
});

describe("CRM and BD lookups, against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let counter = 0;
  const context = (actor: string, role: StaffRole, org = ORG, reason?: string): CommandContext => {
    counter += 1;
    return { organisationId: org, actorId: actor, principal: "staff", idempotencyKey: `crmbd-${counter}`, correlationId: `corr-crmbd-${counter}`, ...(reason ? { reason } : {}), grant: commandGrantForRole(role, org, actor) };
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
  const refused = (field: string, code: string) => (error: Error & { issues?: Array<{ field: string; code: string }> }) => error.issues?.some((issue) => issue.field === field && issue.code === code) === true;
  const stages = async (org: string) => (await withTenantRead(database.pool, org, (db) => listBdStagesPage(db, page))).rows;

  before(async () => {
    database = (await createDisposableDatabase("crmbdlookups"))!;
    for (const org of [ORG, OTHER, LOAD]) {
      await q(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $1)`, [org]);
      await q(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name) VALUES
        ($1, 'ada', 'admin', 'active', 'Ada Admin'), ($1, 'cal', 'consultant', 'active', 'Cal Consultant')`, [org]);
    }
  });
  after(async () => { await database?.end(); });

  describe("the two lookup categories", () => {
    it("are migration-owned; a service line carries a code, a CRM tag does not", async () => {
      const categories = await q(`SELECT category_key, carries_code, code_label FROM nzi_console.reference_categories WHERE category_key IN ('crm_tags', 'bd_service_lines') ORDER BY category_key`);
      assert.deepEqual(categories.map((row) => [row.category_key, row.carries_code, row.code_label]), [["bd_service_lines", true, "Key"], ["crm_tags", false, null]]);
      await assert.rejects(asApp(ORG, `INSERT INTO nzi_console.reference_categories (category_key, label, scope, description) VALUES ('x', 'X', 'organisation', 'x')`), /permission denied/);
      await createReferenceValue(database.pool, { categoryKey: "bd_service_lines", label: "Training", code: "training-workshops" }, context("ada", "admin"));
      await createReferenceValue(database.pool, { categoryKey: "crm_tags", label: "urgent" }, context("ada", "admin"));
      await assert.rejects(createReferenceValue(database.pool, { categoryKey: "crm_tags", label: "coded", code: "c" }, context("ada", "admin")), /does not carry a code|Command validation failed/);
    });
  });

  describe("the funnel (admin.lookups)", () => {
    it("adds stages with a key set once and a probability; refuses a repeated key or name, a bad probability, and a consultant", async () => {
      for (const [key, name, sortOrder, probabilityPct] of [["lead", "Lead", 1, 10], ["qualified", "Qualified", 2, 35], ["won", "Won", 3, 100]] as const) {
        await createBdStage(database.pool, { stageKey: key, name, sortOrder, probabilityPct }, context("ada", "admin"));
      }
      await assert.rejects(createBdStage(database.pool, { stageKey: "lead", name: "Lead again", sortOrder: 9, probabilityPct: 1 }, context("ada", "admin")), refused("stageKey", "DUPLICATE"));
      await assert.rejects(createBdStage(database.pool, { stageKey: "lead-2", name: "LEAD", sortOrder: 9, probabilityPct: 1 }, context("ada", "admin")), refused("name", "DUPLICATE"));
      await assert.rejects(createBdStage(database.pool, { stageKey: "x", name: "X", sortOrder: 9, probabilityPct: 100.5 }, context("ada", "admin")), /Command validation failed/);
      await assert.rejects(createBdStage(database.pool, { stageKey: "Bad Key", name: "Bad", sortOrder: 9, probabilityPct: 1 }, context("ada", "admin")), /Command validation failed/);
      await assert.rejects(createBdStage(database.pool, { stageKey: "cal", name: "Cal's", sortOrder: 9, probabilityPct: 1 }, context("cal", "consultant")), /admin\.lookups|permission/i);
      assert.deepEqual((await stages(ORG)).map((row) => [row.key, row.probabilityPct, row.entry]), [["lead", 10, true], ["qualified", 35, false], ["won", 100, false]]);
    });

    it("edits against the version; moving a stage first moves the entry; refuses an unchanged edit", async () => {
      const qualified = (await stages(ORG)).find((row) => row.key === "qualified")!;
      const edited = await updateBdStage(database.pool, { stageId: qualified.stageId, expectedVersion: 1, name: "Qualified", sortOrder: 0, probabilityPct: 40 }, context("ada", "admin"));
      assert.equal(edited.data.probabilityPct, 40);
      assert.equal((await stages(ORG)).find((row) => row.entry)!.key, "qualified", "the entry is the first active by order");
      await assert.rejects(updateBdStage(database.pool, { stageId: qualified.stageId, expectedVersion: 2, name: "Qualified", sortOrder: 0, probabilityPct: 40 }, context("ada", "admin")), refused("name", "UNCHANGED"));
    });

    it("deactivates with a reason, never the last active stage, and reinstates", async () => {
      const rows = await stages(ORG);
      await assert.rejects(deactivateBdStage(database.pool, { stageId: rows[0]!.stageId, expectedVersion: rows[0]!.version }, context("ada", "admin")), /Command validation failed/, "a reason is required");
      for (const row of rows.slice(0, 2)) await deactivateBdStage(database.pool, { stageId: row.stageId, expectedVersion: row.version }, context("ada", "admin", ORG, "Simplifying the funnel"));
      const last = (await stages(ORG)).find((row) => row.active)!;
      await assert.rejects(deactivateBdStage(database.pool, { stageId: last.stageId, expectedVersion: last.version }, context("ada", "admin", ORG, "Everything")), refused("stageId", "LAST_ACTIVE"));
      assert.equal(last.entry, true, "the one active stage is the way in");
      const back = (await stages(ORG)).find((row) => row.key === "lead")!;
      await reinstateBdStage(database.pool, { stageId: back.stageId, expectedVersion: back.version }, context("ada", "admin"));
    });

    it("sets a key once, deletes nothing, and is tenant-confined", async () => {
      await assert.rejects(asApp(ORG, `UPDATE nzi_console.bd_funnel_stages SET stage_key = 'renamed'`), /permission denied/);
      await assert.rejects(asApp(ORG, `DELETE FROM nzi_console.bd_funnel_stages`), /permission denied/);
      assert.equal((await asApp(OTHER, `SELECT count(*)::int AS n FROM nzi_console.bd_funnel_stages`))[0].n, 0);
    });
  });

  describe("the v7 loaders", () => {
    it("load:v7-crm-tags inserts, keeps a person's own tag, and is R4 on re-runs — the audit counts only", async () => {
      await createReferenceValue(database.pool, { categoryKey: "crm_tags", label: "Risk" }, context("ada", "admin", LOAD));
      const dry = await loadV7CrmBdLookup(database.pool, LOAD, planV7CrmBdLookup("crm-tags", extract()), { commit: false });
      assert.deepEqual([dry.inserted, dry.stamped], [3, 1]);
      const first = await loadV7CrmBdLookup(database.pool, LOAD, planV7CrmBdLookup("crm-tags", extract()), { commit: true, runId: `${CRM_BD_RUN_PREFIX}tags-1` });
      assert.deepEqual([first.inserted, first.stamped, first.parity], [3, 1, { v7Active: 3, v7Inactive: 1, consoleActive: 3, consoleInactive: 1 }]);
      const labels = await q(`SELECT label, active, legacy_db_id FROM nzi_console.reference_values WHERE organisation_id = $1 AND category_key = 'crm_tags' ORDER BY legacy_db_id`, [LOAD]);
      assert.deepEqual(labels.map((row) => [row.legacy_db_id, row.label, row.active]), [["1", "follow-up", true], ["2", "Risk", true], ["3", "finance", true], ["4", "client-waiting", false]],
        "the person's \"Risk\" keeps its own label");
      const again = await loadV7CrmBdLookup(database.pool, LOAD, planV7CrmBdLookup("crm-tags", extract()), { commit: true, runId: `${CRM_BD_RUN_PREFIX}tags-2` });
      assert.deepEqual([again.inserted, again.updated, again.unchanged], [0, 0, 4]);
      const changed = await loadV7CrmBdLookup(database.pool, LOAD, planV7CrmBdLookup("crm-tags", extract((rows) => { rows.crm_tags[0]!.tag_name = "follow up"; })), { commit: true, runId: `${CRM_BD_RUN_PREFIX}tags-3` });
      assert.equal(changed.updated, 1, "v7 wins on a value the import wrote");
      const audit = await q(`SELECT after_json FROM nzi_console.audit_events WHERE organisation_id = $1 AND action = 'crm_tags.imported'`, [LOAD]);
      assert.equal(audit.length, 2, "one event per run that wrote");
    });

    it("load:v7-bd-service-lines carries v7's key as the code", async () => {
      const outcome = await loadV7CrmBdLookup(database.pool, LOAD, planV7CrmBdLookup("bd-service-lines", extract()), { commit: true, runId: `${CRM_BD_RUN_PREFIX}lines-1` });
      assert.equal(outcome.inserted, 4);
      const lines = await q(`SELECT code, label, active FROM nzi_console.reference_values WHERE organisation_id = $1 AND category_key = 'bd_service_lines' ORDER BY sort_order`, [LOAD]);
      assert.deepEqual(lines.map((row) => [row.code, row.active]), [["market-targeting", true], ["carbon-reduction-plan", true], ["consultancy", true], ["life-cycle-assessments", false]]);
    });

    it("load:v7-bd-funnel-stages inserts the funnel, keeps a person's stage by key, names the entry, and never renames a key", async () => {
      await createBdStage(database.pool, { stageKey: "proposal", name: "Proposal sent", sortOrder: 30, probabilityPct: 60 }, context("ada", "admin", LOAD));
      const outcome = await loadV7FunnelStages(database.pool, LOAD, planV7FunnelStages(extract()), { commit: true, runId: `${CRM_BD_RUN_PREFIX}stages-1` });
      assert.deepEqual([outcome.inserted, outcome.stamped, outcome.refused, outcome.entry], [3, 1, [], "lead"]);
      const proposal = await q(`SELECT name, probability_pct::text AS p, source_system FROM nzi_console.bd_funnel_stages WHERE organisation_id = $1 AND stage_key = 'proposal'`, [LOAD]);
      assert.deepEqual([proposal[0].name, proposal[0].p, proposal[0].source_system], ["Proposal sent", "60.00", "nzi-pro-v7"], "the person's own stage stands, stamped");
      const renamed = await loadV7FunnelStages(database.pool, LOAD, planV7FunnelStages(extract((rows) => { rows.bd_funnel_stages[1]!.stage_key = "sql"; })), { commit: false });
      assert.deepEqual(renamed.refused, ["qualified: v7 has renamed its key to sql, and a key never changes here"]);
    });
  });
});
