import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { commandGrantForRole, type CommandContext, type StaffRole } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { syntheticExtract, syntheticRows } from "./support/v7SyntheticExtract";
import type { StaffPrincipal } from "../src/auth";
import { resolveSealingKeys } from "../src/piiSealingKeys";
import { withTenantRead } from "../src/postgres";
import { eraseSubjectData } from "../src/subjectErasure";
import { blindIndex, openForSubject, unwrapSubjectKey, type SealedValue, type WrappedKey } from "../src/subjectCrypto";
import {
  addSupplierContact, createSupplier, createSupplierItem, deactivateSupplier, listSuppliersPage, readSupplier, reinstateSupplier,
  setSupplierItemRate, updateSupplier, updateSupplierContact, updateSupplierItem,
} from "../src/suppliers";
import type { V7Row, V7Table } from "../src/v7ClientExtract";
import EXTRACT_CONTRACT from "../src/v7ExtractContract.json";
import { contactLegacyValues, loadV7Suppliers, planV7Suppliers, SUPPLIERS_RUN_PREFIX } from "../src/v7SuppliersLoad";

/**
 * Suppliers and their rate card (admin Phase E4; ruled `phaseE-commercial-catalogue-plan.md`, E-Q6–E-Q9) against a real
 * database: 0148's guarantees (nothing deleted, a line's supplier fixed, tenant-confined), the contacts sealed per person
 * and erasable by key-shred with nothing personal in the audit, the agreed rate finance.manage's alone and never in the
 * audit, and load:v7-suppliers (contacts sealed on load, v7's address and notes never read, R4, rates never reported).
 */
const ORG = "suppliers-org";
const OTHER = "suppliers-other";
const LOAD = "suppliers-load";
type Rows = ReturnType<typeof syntheticRows>;
const extract = (mutate?: (rows: Rows) => void): Partial<Record<V7Table, V7Row[]>> => { const rows = syntheticRows(); mutate?.(rows); return syntheticExtract(rows); };
const page = { search: "", filters: {}, sort: { key: "name" as const, dir: "asc" as const }, page: 1, pageSize: 50 };
const keys = resolveSealingKeys();

describe("planning the supplier import (no database)", () => {
  const plan = planV7Suppliers(extract());

  it("never reads v7's address or notes: the extract contract does not name them", () => {
    const entry = (EXTRACT_CONTRACT as Record<string, { required: string[]; optional: string[] }>).suppliers!;
    const columns = [...entry.required, ...entry.optional];
    for (const column of ["address", "notes"]) assert.ok(!columns.includes(column), `the supplier extract names ${column}`);
  });

  it("parses each supplier and its contact, leaving out a name repeated in another case", () => {
    assert.deepEqual(plan.suppliers.map((supplier) => [supplier.legacyDbId, supplier.name, supplier.active, supplier.contact === null ? null : Object.keys(supplier.contact).filter((field) => supplier.contact![field as "fullName"] !== null)]), [
      ["1", "Verifiers Ltd", true, ["fullName", "email", "phone"]],
      ["2", "Data Gatherers", true, null],
      ["3", "Old Partners", false, ["fullName"]],
    ]);
    assert.deepEqual(plan.skipped.filter((skip) => skip.table === "suppliers"), [{ table: "suppliers", legacyDbId: "4", reason: "the same name as v7 supplier 1" }]);
  });

  it("parses the rate card: v7's VAT flag and percentage, a line for an unknown supplier and a negative rate left out", () => {
    assert.deepEqual(plan.items.map((item) => [item.legacyDbId, item.supplierLegacyId, item.unitText, item.agreedRate, item.vatable, item.vatPct, item.active]), [
      ["1", "1", "day", 650, true, 20, true],
      ["2", "1", "fortnight", null, true, 20, true],
      ["3", "2", null, 40, false, null, false],
    ]);
    assert.deepEqual(plan.skipped.filter((skip) => skip.table === "supplier_service_items").map((skip) => [skip.legacyDbId, skip.reason]), [
      ["4", "its supplier (v7 99) is not in this load"], ["5", "a rate that is not a number from 0, to two places"]]);
  });

  it("keeps a contact's v7 values as a keyed digest and the fields present — never the values", () => {
    const legacy = contactLegacyValues(plan.suppliers[0]!.contact!, keys);
    assert.deepEqual(legacy.fields, ["fullName", "email", "phone"]);
    const text = JSON.stringify(legacy);
    for (const value of ["Mary", "verifiers.test", "7000"]) assert.ok(!text.includes(value), `legacy values carry ${value}`);
  });
});

describe("suppliers, against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let counter = 0;
  const context = (actor: string, role: StaffRole, org = ORG, reason?: string): CommandContext => {
    counter += 1;
    return { organisationId: org, actorId: actor, principal: "staff", idempotencyKey: `sup-${counter}`, correlationId: `corr-sup-${counter}`, ...(reason ? { reason } : {}), grant: commandGrantForRole(role, org, actor) };
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
  /** Everything a command left behind it that a wider audience reads: the audit, the idempotency record, the outbox payload. */
  const trailOf = async (org: string) => JSON.stringify([
    await q(`SELECT before_json, after_json FROM nzi_console.audit_events WHERE organisation_id = $1`, [org]),
    await q(`SELECT outcome_json FROM nzi_console.command_idempotency WHERE organisation_id = $1`, [org]),
    await q(`SELECT topic, payload_json FROM nzi_console.transactional_outbox WHERE organisation_id = $1`, [org]),
  ]);
  const opened = async (contactId: string, column: "full_name_sealed" | "email_sealed" | "phone_sealed") => {
    const [row] = await q(
      `SELECT c.${column} AS sealed, k.wrapped_key FROM nzi_console.supplier_contacts c
         JOIN nzi_console.data_subject_links l ON (l.organisation_id, l.source_table, l.source_id) = (c.organisation_id, 'supplier_contacts', c.contact_id)
         JOIN nzi_console.data_subject_keys k ON (k.organisation_id, k.subject_id) = (l.organisation_id, l.subject_id)
        WHERE c.contact_id = $1`, [contactId]);
    return row ? openForSubject(row.sealed as SealedValue, unwrapSubjectKey(row.wrapped_key as WrappedKey, keys.masterKey)) : null;
  };

  before(async () => {
    database = (await createDisposableDatabase("suppliers"))!;
    for (const org of [ORG, OTHER, LOAD]) {
      await q(`INSERT INTO nzi_console.organisations (organisation_id, name) VALUES ($1, $1)`, [org]); // 0145 provisions GBP, the default
      await q(`INSERT INTO nzi_console.memberships (organisation_id, user_id, role_id, status, display_name) VALUES
        ($1, 'ada', 'admin', 'active', 'Ada Admin'), ($1, 'cal', 'consultant', 'active', 'Cal Consultant'), ($1, 'fin', 'finance', 'active', 'Fin Finance')`, [org]);
      for (const [id, label] of [["uom-days", "days"], ["uom-hours", "hours"]]) {
        await q(`INSERT INTO nzi_console.reference_values (organisation_id, category_key, value_id, label, created_by, updated_by) VALUES ($1, 'units_of_measure', $2, $3, 'seed', 'seed')`, [org, `${org}:${id}`, label]);
      }
      await q(`INSERT INTO nzi_console.reference_values (organisation_id, category_key, value_id, label, created_by, updated_by) VALUES ($1, 'industries', $2, 'Not a unit', 'seed', 'seed')`, [org, `${org}:ind-x`]);
      await q(`INSERT INTO nzi_console.vat_rates (organisation_id, vat_rate_id, name, rate_pct, is_default, created_by, updated_by) VALUES
        ($1, 'vat:standard', 'Standard', 20, true, 'seed', 'seed'), ($1, 'vat:zero', 'Zero', 0, false, 'seed', 'seed')`, [org]);
    }
  });
  after(async () => { await database?.end(); });

  describe("the company (admin.lookups)", () => {
    it("adds, edits, deactivates and reinstates a supplier, its name unique case-insensitively; a consultant may not", async () => {
      const made = await createSupplier(database.pool, { name: "  Verifiers   Ltd ", website: "https://verifiers.test" }, context("ada", "admin"));
      assert.deepEqual([made.data.name, made.data.website, made.data.active, made.data.version], ["Verifiers Ltd", "https://verifiers.test", true, 1]);
      await assert.rejects(createSupplier(database.pool, { name: "verifiers ltd" }, context("ada", "admin")), refused("name", "DUPLICATE"));
      const edited = await updateSupplier(database.pool, { supplierId: made.data.supplierId, expectedVersion: 1, name: "Verifiers Ltd", website: null }, context("ada", "admin"));
      assert.equal(edited.data.website, null);
      await assert.rejects(updateSupplier(database.pool, { supplierId: made.data.supplierId, expectedVersion: 2, name: "Verifiers Ltd", website: null }, context("ada", "admin")), refused("name", "UNCHANGED"));
      await assert.rejects(deactivateSupplier(database.pool, { supplierId: made.data.supplierId, expectedVersion: 2 }, context("ada", "admin")), /Command validation failed/, "a reason is required");
      const off = await deactivateSupplier(database.pool, { supplierId: made.data.supplierId, expectedVersion: 2 }, context("ada", "admin", ORG, "Paused"));
      await assert.rejects(addSupplierContact(database.pool, { supplierId: made.data.supplierId, fullName: "Nobody" }, context("ada", "admin")), refused("supplierId", "INACTIVE"));
      await reinstateSupplier(database.pool, { supplierId: made.data.supplierId, expectedVersion: off.data.version }, context("ada", "admin"));
      await assert.rejects(createSupplier(database.pool, { name: "Cal's supplier" }, context("cal", "consultant")), /admin\.lookups|permission/i);
    });
  });

  describe("the people (sealed per person, E-Q6)", () => {
    let contactId = "";
    it("adds a contact sealed under their own subject key, with nothing personal in the audit, idempotency record or outbox", async () => {
      const [supplier] = await q(`SELECT supplier_id FROM nzi_console.suppliers WHERE organisation_id = $1`, [ORG]);
      const added = await addSupplierContact(database.pool, { supplierId: supplier.supplier_id, fullName: "Mary Somerville", email: "Mary@Verifiers.test", phone: "+44 20 7000 0001" }, context("ada", "admin"));
      contactId = added.data.contactId;
      assert.deepEqual(added.data.fields, ["fullName", "email", "phone"]);
      assert.equal(await opened(contactId, "full_name_sealed"), "Mary Somerville", "the name is sealed and reads back");
      assert.equal(await opened(contactId, "phone_sealed"), "+44 20 7000 0001");
      const [row] = await q(`SELECT email_bidx FROM nzi_console.supplier_contacts WHERE contact_id = $1`, [contactId]);
      assert.equal(row.email_bidx, blindIndex("supplier_contacts.email", "mary@verifiers.test", keys.indexKey), "the email is blind-indexed, case-folded");
      const [linkage] = await q(`SELECT count(*)::int AS n FROM nzi_console.data_subject_linkage WHERE source_table = 'supplier_contacts' AND source_id = $1`, [contactId]);
      assert.equal(linkage.n, 1, "the email's linkage digest is recorded");

      const edited = await updateSupplierContact(database.pool, { contactId, expectedVersion: 1, fullName: "Mary Fairfax Somerville", email: "Mary@Verifiers.test", phone: null }, context("ada", "admin"));
      assert.deepEqual(edited.data.fields, ["fullName", "phone"], "which fields changed — never what to");
      assert.equal(await opened(contactId, "full_name_sealed"), "Mary Fairfax Somerville", "re-sealed on edit");
      const trail = await trailOf(ORG);
      // The company's own website is on its row and in its audit — the contact's address, never.
      for (const value of ["Mary", "Somerville", "mary@", "7000"]) assert.ok(!trail.toLowerCase().includes(value.toLowerCase()), `the trail carries ${value}`);
    });

    it("validates a contact: a name required, an email that is an address", async () => {
      const [supplier] = await q(`SELECT supplier_id FROM nzi_console.suppliers WHERE organisation_id = $1`, [ORG]);
      await assert.rejects(addSupplierContact(database.pool, { supplierId: supplier.supplier_id, fullName: " " }, context("ada", "admin")), /Command validation failed/);
      await assert.rejects(addSupplierContact(database.pool, { supplierId: supplier.supplier_id, fullName: "X", email: "not-an-address" }, context("ada", "admin")), /Command validation failed/);
    });

    it("is erased by key-shred: plaintext and index nulled, the row and its supplier kept", async () => {
      const [link] = await q(`SELECT subject_id FROM nzi_console.data_subject_links WHERE source_table = 'supplier_contacts' AND source_id = $1`, [contactId]);
      const dpo = { userId: "ada", organisationId: ORG, role: "admin", capabilities: ["subject.review", "subject.export", "subject.erase"].map((capability) => ({ capability, scope: "all" })) } as unknown as StaffPrincipal;
      const manifest = await eraseSubjectData(database.pool, dpo, { organisationId: ORG, subjectId: link.subject_id, requestRef: "RTBF-supplier", keys });
      const supplierEntries = manifest.entries.filter((entry) => entry.table === "supplier_contacts");
      assert.deepEqual(supplierEntries.map((entry) => [entry.column, entry.outcome]).sort(), [["email", "erased"], ["full_name", "erased"], ["phone", "erased"]]);
      const [row] = await q(`SELECT full_name, email, phone, email_bidx FROM nzi_console.supplier_contacts WHERE contact_id = $1`, [contactId]);
      assert.deepEqual([row.full_name, row.email, row.phone, row.email_bidx], [null, null, null, null]);
      assert.equal(await opened(contactId, "full_name_sealed").catch(() => "unreadable"), "unreadable", "the key is gone");
      const [held] = await q(`SELECT supplier_id FROM nzi_console.supplier_contacts WHERE contact_id = $1`, [contactId]);
      const shown = await withTenantRead(database.pool, ORG, (db) => readSupplier(db, ORG, held.supplier_id, { showRates: false }));
      assert.deepEqual(shown!.contacts.map((contact) => [contact.fullName, contact.erased]), [[null, true]], "shown as erased, never as blank");
      await assert.rejects(updateSupplierContact(database.pool, { contactId, expectedVersion: Number((await q(`SELECT version FROM nzi_console.supplier_contacts WHERE contact_id = $1`, [contactId]))[0].version), fullName: "Back again" }, context("ada", "admin")), refused("contactId", "ERASED"));
    });
  });

  describe("the rate card (the line admin.lookups; the rate finance.manage, never in the audit)", () => {
    it("adds a line in the organisation's currency, unrated, with references checked and a held one standing", async () => {
      const [supplier] = await q(`SELECT supplier_id FROM nzi_console.suppliers WHERE organisation_id = $1`, [ORG]);
      await assert.rejects(createSupplierItem(database.pool, { supplierId: supplier.supplier_id, name: "Wrong kind", unitValueId: `${ORG}:ind-x` }, context("ada", "admin")), refused("unitValueId", "NOT_FOUND"));
      await assert.rejects(createSupplierItem(database.pool, { supplierId: supplier.supplier_id, name: "Other org's", vatRateId: "vat:missing" }, context("ada", "admin")), refused("vatRateId", "NOT_FOUND"));
      const made = await createSupplierItem(database.pool, { supplierId: supplier.supplier_id, costType: "Verification", name: "Limited assurance", unitValueId: `${ORG}:uom-days`, vatRateId: "vat:zero" }, context("ada", "admin"));
      assert.deepEqual([made.data.currency, made.data.costType, made.data.active], ["GBP", "Verification", true]);
      await assert.rejects(createSupplierItem(database.pool, { supplierId: supplier.supplier_id, name: "limited ASSURANCE" }, context("ada", "admin")), refused("name", "DUPLICATE"));
      await q(`UPDATE nzi_console.vat_rates SET active = false WHERE organisation_id = $1 AND vat_rate_id = 'vat:zero'`, [ORG]);
      const edited = await updateSupplierItem(database.pool, { serviceItemId: made.data.serviceItemId, expectedVersion: 1, costType: "Verification", name: "Limited assurance (ISO 14064-3)", unitValueId: `${ORG}:uom-days`, vatRateId: "vat:zero" }, context("ada", "admin"));
      assert.equal(edited.data.vatRateId, "vat:zero", "a held VAT rate stands once deactivated (R3)");
      await q(`UPDATE nzi_console.vat_rates SET active = true WHERE organisation_id = $1 AND vat_rate_id = 'vat:zero'`, [ORG]);
    });

    it("sets the rate only with finance.manage, and the audit, idempotency record and outbox never carry it", async () => {
      const [line] = await q(`SELECT service_item_id, version FROM nzi_console.supplier_service_items WHERE organisation_id = $1`, [ORG]);
      await assert.rejects(setSupplierItemRate(database.pool, { serviceItemId: line.service_item_id, expectedVersion: line.version, agreedRate: 1 }, context("cal", "consultant")), /finance\.manage|permission/i);
      const rated = await setSupplierItemRate(database.pool, { serviceItemId: line.service_item_id, expectedVersion: line.version, agreedRate: 648.75 }, context("fin", "finance"));
      assert.deepEqual([rated.data.rate, rated.data.currency], ["set", "GBP"]);
      await assert.rejects(setSupplierItemRate(database.pool, { serviceItemId: line.service_item_id, expectedVersion: rated.data.version, agreedRate: 648.75 }, context("ada", "admin")), refused("agreedRate", "UNCHANGED"));
      await assert.rejects(setSupplierItemRate(database.pool, { serviceItemId: line.service_item_id, expectedVersion: rated.data.version, agreedRate: -1 }, context("ada", "admin")), /Command validation failed/);
      const trail = await trailOf(ORG);
      assert.ok(!trail.includes("648"), "the trail never carries the rate");
      const supplierId = (await q(`SELECT supplier_id FROM nzi_console.supplier_service_items WHERE service_item_id = $1`, [line.service_item_id]))[0].supplier_id;
      const shown = await withTenantRead(database.pool, ORG, (db) => readSupplier(db, ORG, supplierId, { showRates: true }));
      const hidden = await withTenantRead(database.pool, ORG, (db) => readSupplier(db, ORG, supplierId, { showRates: false }));
      assert.deepEqual(shown!.items[0]!.rate, { agreedRate: 648.75 });
      assert.equal(hidden!.items[0]!.rate, null, "hidden is null, never 0");
      assert.deepEqual([shown!.items[0]!.unit, shown!.items[0]!.vatRate], ["days", "Zero · 0%"]);
    });

    it("lists suppliers with their active contacts and lines counted", async () => {
      const list = await withTenantRead(database.pool, ORG, (db) => listSuppliersPage(db, page));
      assert.deepEqual(list.rows.map((row) => [row.name, row.contacts, row.items, row.provenance]), [["Verifiers Ltd", 1, 1, "added"]]);
    });
  });

  describe("0148's guarantees", () => {
    it("deletes nothing, fixes a line's and a contact's supplier, and is tenant-confined", async () => {
      for (const table of ["suppliers", "supplier_contacts", "supplier_service_items"]) {
        await assert.rejects(asApp(ORG, `DELETE FROM nzi_console.${table}`), /permission denied/, `${table} can be deleted from`);
        assert.equal((await asApp(OTHER, `SELECT count(*)::int AS n FROM nzi_console.${table}`))[0].n, 0, `${table} leaks across organisations`);
      }
      await assert.rejects(asApp(ORG, `UPDATE nzi_console.supplier_service_items SET supplier_id = 'elsewhere'`), /permission denied/);
      await assert.rejects(asApp(ORG, `UPDATE nzi_console.supplier_contacts SET supplier_id = 'elsewhere'`), /permission denied/);
    });

    it("admits supplier contacts to the subject registry, and record_subject_linkage refuses one that does not exist", async () => {
      await assert.rejects(asApp(ORG, `SELECT nzi_console.record_subject_linkage($1, 'supplier_contacts', 'nobody', 'email', 'digest')`, [ORG]), /No supplier_contacts row/);
    });
  });

  describe("load:v7-suppliers (sealed on load, E-Q7)", () => {
    it("inserts suppliers, seals their contacts, resolves the rate card, and reports by v7 id — never a name or a rate", async () => {
      // A person's supplier already holding v7's name "Data Gatherers": stamped, and its own details stand.
      await createSupplier(database.pool, { name: "data gatherers", website: "https://ours.test" }, context("ada", "admin", LOAD));
      const dry = await loadV7Suppliers(database.pool, LOAD, planV7Suppliers(extract()), { commit: false, keys });
      assert.deepEqual([dry.suppliers.inserted, dry.suppliers.stamped, dry.contacts.inserted], [2, 1, 2]);
      assert.equal((await q(`SELECT count(*)::int AS n FROM nzi_console.supplier_contacts WHERE organisation_id = $1`, [LOAD]))[0].n, 0, "a dry run writes nothing");

      const outcome = await loadV7Suppliers(database.pool, LOAD, planV7Suppliers(extract()), { commit: true, keys, runId: `${SUPPLIERS_RUN_PREFIX}first` });
      assert.deepEqual([outcome.suppliers, outcome.contacts, outcome.items, outcome.refused], [
        { inserted: 2, stamped: 1, updated: 0, unchanged: 0 }, { inserted: 2, stamped: 0, updated: 0, unchanged: 0 }, { inserted: 3, stamped: 0, updated: 0, unchanged: 0 }, []]);
      assert.deepEqual(outcome.notes.sort(), [
        "line 2: v7's unit \"fortnight\" is not a unit of measure here — left blank",
        "supplier 2: already held here by name — stamped with v7's identity; its own details stand",
      ]);
      assert.deepEqual([outcome.rated, outcome.parity], [2, { v7Active: 2, v7Inactive: 1, consoleActive: 2, consoleInactive: 1 }]);
      const lines = await q(`SELECT legacy_db_id, unit_value_id, vat_rate_id, agreed_rate::text AS rate, currency_code, active FROM nzi_console.supplier_service_items WHERE organisation_id = $1 ORDER BY legacy_db_id`, [LOAD]);
      assert.deepEqual(lines.map((row) => [row.legacy_db_id, row.unit_value_id, row.vat_rate_id, row.rate, row.currency_code, row.active]), [
        ["1", `${LOAD}:uom-days`, "vat:standard", "650.00", "GBP", true],
        ["2", null, "vat:standard", null, "GBP", true],
        ["3", null, "vat:zero", "40.00", "GBP", false],
      ]);
      assert.equal((await q(`SELECT website FROM nzi_console.suppliers WHERE organisation_id = $1 AND legacy_db_id = '2'`, [LOAD]))[0].website, "https://ours.test", "a person's supplier keeps its own details");

      const [mary] = await q(`SELECT contact_id, legacy_values FROM nzi_console.supplier_contacts WHERE organisation_id = $1 AND legacy_db_id = '1'`, [LOAD]);
      assert.equal(await opened(mary.contact_id, "full_name_sealed"), "Mary Example", "sealed on load, and reads back");
      assert.equal(await opened(mary.contact_id, "email_sealed"), "mary@verifiers.test", "sealed as the index normalises it");
      assert.ok(!JSON.stringify(mary.legacy_values).includes("Mary"), "legacy values carry no name");

      const printed = JSON.stringify(outcome) + await trailOf(LOAD);
      for (const value of ["Mary", "Olive", "mary@", "7000", "650", "Verifiers", "Old Partners"]) assert.ok(!printed.includes(value), `the outcome or trail carries ${value}`);
    });

    it("re-run unchanged writes nothing; v7 changed and still as imported → v7 wins; edited here since → refused (R4)", async () => {
      const unchanged = await loadV7Suppliers(database.pool, LOAD, planV7Suppliers(extract()), { commit: true, keys, runId: `${SUPPLIERS_RUN_PREFIX}second` });
      assert.deepEqual([unchanged.suppliers.unchanged, unchanged.contacts.unchanged, unchanged.items.unchanged], [3, 2, 3]);
      const [line] = await q(`SELECT service_item_id, version FROM nzi_console.supplier_service_items WHERE organisation_id = $1 AND legacy_db_id = '2'`, [LOAD]);
      await updateSupplierItem(database.pool, { serviceItemId: line.service_item_id, expectedVersion: line.version, name: "Site visit, edited here" }, context("ada", "admin", LOAD));
      const changed = extract((rows) => {
        rows.suppliers[0]!.contact_name = "Mary Changed";
        rows.supplier_service_items[0]!.agreed_rate = "700";
        rows.supplier_service_items[1]!.item_name = "Site visit, as v7 renamed it";
      });
      const outcome = await loadV7Suppliers(database.pool, LOAD, planV7Suppliers(changed), { commit: true, keys, runId: `${SUPPLIERS_RUN_PREFIX}third` });
      assert.deepEqual([outcome.contacts.updated, outcome.items.updated, outcome.refused], [1, 1, ["line 2: changed in v7 since the last load, and edited here since (R4)"]]);
      const [mary] = await q(`SELECT contact_id, full_name FROM nzi_console.supplier_contacts WHERE organisation_id = $1 AND legacy_db_id = '1'`, [LOAD]);
      assert.equal(mary.full_name, "Mary Changed");
      assert.equal(await opened(mary.contact_id, "full_name_sealed"), "Mary Changed", "re-sealed with v7's new value");
      assert.ok(!JSON.stringify(outcome).includes("700") && !JSON.stringify(outcome).includes("Mary"), "the outcome never carries a rate or a name");
    });
  });
});
