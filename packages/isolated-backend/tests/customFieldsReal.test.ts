import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { commandGrantForRole, customFieldListSpec, defaultListQuery, type CommandContext, type CustomFieldOption, type StaffRole } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { syntheticExtract, syntheticRows } from "./support/v7SyntheticExtract";
import { createCustomField, deactivateCustomField, listActiveCustomFields, listCustomFieldsPage, reinstateCustomField, updateCustomField } from "../src/customFields";
import { withTenantRead } from "../src/postgres";
import type { V7Row, V7Table } from "../src/v7ClientExtract";
import { CUSTOM_FIELDS_RUN_PREFIX, loadV7CustomFields, planV7CustomFields } from "../src/v7CustomFieldsLoad";

/**
 * Custom field definitions (admin Phase F3; ruled `phaseF-comms-crm-plan.md`, F-Q5) against a real database: 0151's
 * guarantees (entity, key and type set once; options only on a select; nothing deleted; tenant-confined), the commands
 * (admin.settings; options never removed; a default valid for its type), and load:v7-custom-fields.
 */
const ORG = "fields-org";
const OTHER = "fields-other";
const LOAD = "fields-load";
type Rows = ReturnType<typeof syntheticRows>;
const extract = (mutate?: (rows: Rows) => void): Partial<Record<V7Table, V7Row[]>> => { const rows = syntheticRows(); mutate?.(rows); return syntheticExtract(rows); };
const MODES: CustomFieldOption[] = [{ value: "in_person", label: "In person", active: true }, { value: "online", label: "Online", active: true }];

describe("planning the custom-field import (no database)", () => {
  const plan = planV7CustomFields(extract());

  it("takes v7's definitions with mapped types, and leaves out what cannot be carried — naming why", () => {
    assert.deepEqual(plan.values.map((value) => [value.entityType, value.key, value.type, value.active, value.defaultValue]), [
      ["client", "referral", "select", true, null],
      ["job", "training_delivery_mode", "select", true, "online"],
      ["job", "multi-year-contract-end-date", "date", true, null],
      ["job", "nzn-direct-debit", "checkbox", false, "false"],
    ]);
    assert.deepEqual(plan.skipped.map((skip) => [skip.legacyDbId, skip.reason]).sort(), [
      ["5", "A choice-from-a-list field needs at least one active option."],
      ["6", "the same client key as v7 field 1"],
      ["7", "key \"9lives\" is not a console key (lower-case letters, digits, _ and -, starting with a letter, up to 64)"],
      ["8", "entity \"invoice\" is not one the console knows"],
    ]);
    assert.ok(plan.notes.includes("job.multi-year-contract-end-date: v7's default is not valid for a date field — left blank"));
    assert.ok(plan.notes.includes("job.training_delivery_mode: v7's radio-button field becomes a choice from a list (v7 drew it as one)"));
  });
});

describe("custom field definitions, against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let counter = 0;
  const context = (actor: string, role: StaffRole, org = ORG, reason?: string): CommandContext => {
    counter += 1;
    return { organisationId: org, actorId: actor, principal: "staff", idempotencyKey: `fields-${counter}`, correlationId: `corr-fields-${counter}`, ...(reason ? { reason } : {}), grant: commandGrantForRole(role, org, actor) };
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
  const base = { required: false, sortOrder: 10, options: null, defaultValue: null };

  before(async () => {
    database = (await createDisposableDatabase("customfields"))!;
    for (const org of [ORG, OTHER, LOAD]) {
      await q(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $1)`, [org]);
      await q(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name) VALUES
        ($1, 'ada', 'admin', 'active', 'Ada Admin'), ($1, 'cal', 'consultant', 'active', 'Cal Consultant')`, [org]);
    }
  });
  after(async () => { await database?.end(); });

  describe("the commands (admin.settings)", () => {
    it("adds definitions of each kind; refuses a repeated key per entity, options on a non-select, a bad default, and a consultant", async () => {
      await createCustomField(database.pool, { ...base, entityType: "job", fieldKey: "delivery_mode", fieldType: "select", label: "Delivery mode", options: MODES, defaultValue: "online" }, context("ada", "admin"));
      await createCustomField(database.pool, { ...base, entityType: "job", fieldKey: "contract_end", fieldType: "date", label: "Contract end", sortOrder: 20 }, context("ada", "admin"));
      await createCustomField(database.pool, { ...base, entityType: "client", fieldKey: "delivery_mode", fieldType: "text", label: "Same key, other entity" }, context("ada", "admin"));
      await assert.rejects(createCustomField(database.pool, { ...base, entityType: "job", fieldKey: "delivery_mode", fieldType: "text", label: "Again" }, context("ada", "admin")), refused("fieldKey", "DUPLICATE"));
      await assert.rejects(createCustomField(database.pool, { ...base, entityType: "job", fieldKey: "notes", fieldType: "text", label: "Notes", options: MODES }, context("ada", "admin")), refused("options", "INVALID"));
      await assert.rejects(createCustomField(database.pool, { ...base, entityType: "job", fieldKey: "end", fieldType: "date", label: "End", defaultValue: "31/12/2026" }, context("ada", "admin")), refused("defaultValue", "INVALID"));
      await assert.rejects(createCustomField(database.pool, { ...base, entityType: "job", fieldKey: "mode2", fieldType: "select", label: "No options", options: [] }, context("ada", "admin")), refused("options", "INVALID"));
      await assert.rejects(createCustomField(database.pool, { ...base, entityType: "job", fieldKey: "cal", fieldType: "text", label: "Cal's" }, context("cal", "consultant")), /admin\.settings|permission/i);
      const active = await withTenantRead(database.pool, ORG, (db) => listActiveCustomFields(db, "job"));
      assert.deepEqual(active.map((row) => [row.key, row.type]), [["delivery_mode", "select"], ["contract_end", "date"]]);
    });

    it("never removes an option — relabel, add and deactivate are fine — and the default must stay an active option", async () => {
      const [row] = (await withTenantRead(database.pool, ORG, (db) => listActiveCustomFields(db, "job")));
      const edit = (options: CustomFieldOption[], defaultValue: string | null, version: number) =>
        updateCustomField(database.pool, { definitionId: row!.definitionId, expectedVersion: version, label: "Delivery mode", required: true, sortOrder: 10, options, defaultValue }, context("ada", "admin"));
      await assert.rejects(edit([MODES[1]!], "online", 1), refused("options", "OPTION_REMOVED"));
      await assert.rejects(edit([{ ...MODES[0]!, active: true }, { ...MODES[1]!, active: false }], "online", 1), refused("defaultValue", "INVALID"), "a deactivated option cannot be the default");
      const edited = await edit([{ value: "in_person", label: "Face to face", active: true }, { ...MODES[1]!, active: false }, { value: "hybrid", label: "Hybrid", active: true }], "hybrid", 1);
      assert.deepEqual(edited.data.options?.map((option) => [option.value, option.label, option.active]), [["in_person", "Face to face", true], ["online", "Online", false], ["hybrid", "Hybrid", true]]);
      await assert.rejects(edit(edited.data.options!, "hybrid", edited.data.version), refused("label", "UNCHANGED"), "jsonb's key order does not make a held option look changed");
    });

    it("deactivates with a reason and reinstates; keeps entity, key and type fixed; deletes nothing; tenant-confined", async () => {
      const page = await withTenantRead(database.pool, ORG, (db) => listCustomFieldsPage(db, { ...defaultListQuery(customFieldListSpec), filters: { entity: ["job"] } }));
      const end = page.rows.find((row) => row.key === "contract_end")!;
      await assert.rejects(deactivateCustomField(database.pool, { definitionId: end.definitionId, expectedVersion: end.version }, context("ada", "admin")), /Command validation failed/, "a reason is required");
      const off = await deactivateCustomField(database.pool, { definitionId: end.definitionId, expectedVersion: end.version }, context("ada", "admin", ORG, "Not used"));
      assert.deepEqual((await withTenantRead(database.pool, ORG, (db) => listActiveCustomFields(db, "job"))).map((row) => row.key), ["delivery_mode"]);
      await reinstateCustomField(database.pool, { definitionId: end.definitionId, expectedVersion: off.data.version }, context("ada", "admin"));
      for (const column of ["entity_type = 'client'", "field_key = 'renamed'", "field_type = 'text'"]) {
        await assert.rejects(asApp(ORG, `UPDATE nzi_console.custom_field_definitions SET ${column}`), /permission denied/, column);
      }
      await assert.rejects(asApp(ORG, `DELETE FROM nzi_console.custom_field_definitions`), /permission denied/);
      await assert.rejects(q(`UPDATE nzi_console.custom_field_definitions SET options = NULL WHERE field_key = 'delivery_mode' AND entity_type = 'job'`), /custom_field_definitions_options_for_select/);
      assert.equal((await asApp(OTHER, `SELECT count(*)::int AS n FROM nzi_console.custom_field_definitions`))[0].n, 0);
    });
  });

  describe("load:v7-custom-fields", () => {
    it("inserts v7's definitions into the organisation, keeps a person's own field, and reports what it cannot carry", async () => {
      await createCustomField(database.pool, { ...base, entityType: "client", fieldKey: "referral", fieldType: "select", label: "How they found us",
        options: [{ value: "partner", label: "Partner", active: true }] }, context("ada", "admin", LOAD));
      const dry = await loadV7CustomFields(database.pool, LOAD, planV7CustomFields(extract()), { commit: false });
      assert.deepEqual([dry.inserted, dry.stamped], [3, 1]);
      const outcome = await loadV7CustomFields(database.pool, LOAD, planV7CustomFields(extract()), { commit: true, runId: `${CUSTOM_FIELDS_RUN_PREFIX}first` });
      assert.deepEqual([outcome.inserted, outcome.stamped, outcome.refused, outcome.parity], [3, 1, [], { v7Active: 3, v7Inactive: 1, consoleActive: 3, consoleInactive: 1 }]);
      const [own] = await q(`SELECT label, source_system FROM nzi_console.custom_field_definitions WHERE organisation_id = $1 AND field_key = 'referral'`, [LOAD]);
      assert.deepEqual([own.label, own.source_system], ["How they found us", "nzi-pro-v7"], "the person's own field stands, stamped");
      const audit = await q(`SELECT after_json FROM nzi_console.audit_events WHERE organisation_id = $1 AND action = 'custom_fields.imported'`, [LOAD]);
      assert.equal(audit[0].after_json.inserted, 3);
    });

    it("re-runs: unchanged left alone; an option v7 dropped is kept, deactivated; a type change refused; edited here refused (R4)", async () => {
      const again = await loadV7CustomFields(database.pool, LOAD, planV7CustomFields(extract()), { commit: true, runId: `${CUSTOM_FIELDS_RUN_PREFIX}second` });
      assert.equal(again.unchanged, 4);
      const dropped = await loadV7CustomFields(database.pool, LOAD, planV7CustomFields(extract((rows) => {
        rows.custom_field_definitions[1]!.options = "[{\"value\": \"online\", \"label\": \"Online\"}]";
      })), { commit: true, runId: `${CUSTOM_FIELDS_RUN_PREFIX}third` });
      assert.equal(dropped.updated, 1);
      assert.ok(dropped.notes.includes("job.training_delivery_mode: v7 no longer offers \"in_person\" — kept here, deactivated"));
      const [mode] = await q(`SELECT options FROM nzi_console.custom_field_definitions WHERE organisation_id = $1 AND field_key = 'training_delivery_mode'`, [LOAD]);
      assert.deepEqual((mode.options as CustomFieldOption[]).map((option) => [option.value, option.active]), [["online", true], ["in_person", false]]);
      const retyped = await loadV7CustomFields(database.pool, LOAD, planV7CustomFields(extract((rows) => { rows.custom_field_definitions[2]!.field_type = "text"; })), { commit: false });
      assert.deepEqual(retyped.refused, ["job.multi-year-contract-end-date: v7 changed its type (date → text), which never changes here — make a new field instead"]);
    });
  });
});
