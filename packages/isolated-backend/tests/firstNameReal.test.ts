import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import type pg from "pg";
import { commandGrantForRole, type CommandContext } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { createClientContact, updateClientContact } from "../src/clientContacts";
import { backfillSealedPii } from "../src/piiBackfill";
import { resolveSealingKeys } from "../src/piiSealingKeys";
import { CommandValidationError } from "../src/postgresCommands";
import { withTenantRead } from "../src/postgres";
import { listClientContacts } from "../src/clientContactRecords";
import { addStaff, listStaffPage, updateStaff } from "../src/staffAdmin";
import { staffFirstName } from "../src/addressName";
import { staffListSpec, defaultListQuery } from "@nzi/contracts";

/**
 * A first name on contacts and the team (0207), against a real database:
 *  1. the migration's backfill gives every named row the first word of its name - and none to a row with no name - without bumping a version;
 *  2. a first name is captured on both forms, defaults from the full name when not given or given blank, and is always editable;
 *  3. a first name that still equals the default follows a renamed full name; one that was set to something else is never overwritten;
 *  4. it is sealed beside the plaintext in the same transaction (and the encryption backfill seals what the migration left plaintext-only);
 *  5. the full name is untouched everywhere it records who someone is: the contact's version history and the audit keep it;
 *  6. a person is never greeted blank: no first name held falls back to the first word, and no name at all to nothing for a caller to say "there".
 */
const ORG = "fn-org";
const CLIENT = "fn-client";

describe("first names, against a real database", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;
  let keys = 0;
  const staff = (actor = "fn-ada"): CommandContext => { keys += 1; return { organisationId: ORG, actorId: actor, principal: "staff", idempotencyKey: `fn-${keys}`, correlationId: `corr-fn-${keys}`, grant: commandGrantForRole("admin", ORG, actor) }; };
  const q = async <T extends pg.QueryResultRow = Record<string, any>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
  const contact = async (id: string) => (await q(`SELECT * FROM nzi_console.client_contacts WHERE contact_id = $1`, [id]))[0]!;
  const member = async (id: string) => (await q(`SELECT * FROM nzi_console.memberships WHERE user_id = $1`, [id]))[0]!;
  const migration = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../migrations/0207_first_name.sql"), "utf8");
  /** The migration's own backfill statements, run as written - not a copy of them. */
  const backfill = async () => {
    for (const table of ["client_contacts", "memberships"]) {
      const statement = new RegExp(`UPDATE nzi_console\\.${table}\\s+SET first_name[\\s\\S]*?;`).exec(migration)?.[0];
      assert.ok(statement, `0207 has no backfill for ${table}`);
      await db.query(statement);
    }
  };

  before(async () => {
    database = (await createDisposableDatabase("firstname"))!;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,$1)`, [ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
    await db.query(`INSERT INTO nzi_console.memberships (organisation_id,user_id,role_id,status,display_name,email) VALUES ($1,'fn-ada','admin','active','Ada Admin','ada@example.test')`, [ORG]);
    await db.query(`INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,$2,'Example Ltd','active')`, [ORG, CLIENT]);
  });
  after(async () => { await db?.end(); await database?.end(); });

  it("the migration's backfill: the first word of the name, trimmed - for every named row, none for a row without a name, and no version bumped", async () => {
    // Rows as they stood before 0207: a name, no first name.
    for (const [id, name] of [["k-dr", "Dr. Jane Smith"], ["k-one", "Cher"], ["k-hyphen", "Mary-Jane O'Neil"]]) {
      await db.query(`INSERT INTO nzi_console.client_contacts (organisation_id,contact_id,client_id,full_name,created_by,updated_by) VALUES ($1,$2,$3,$4,'t','t')`, [ORG, id, CLIENT, name]);
    }
    await db.query(`INSERT INTO nzi_console.client_contacts (organisation_id,contact_id,client_id,full_name,created_by,updated_by) VALUES ($1,'k-erased',$2,'Gone Person','t','t')`, [ORG, CLIENT]);
    await db.query(`UPDATE nzi_console.client_contacts SET full_name = NULL WHERE contact_id = 'k-erased'`); // erasure nulls the name (0108)
    for (const [id, name] of [["m-padded", "  Anne   Marie Lee "], ["m-one", "Sam"], ["m-blank", "   "], ["m-null", null]]) {
      await db.query(`INSERT INTO nzi_console.memberships (organisation_id,user_id,role_id,status,display_name) VALUES ($1,$2,'viewer','active',$3)`, [ORG, id, name]);
    }
    const versionsBefore = await q(`SELECT user_id, version, updated_at FROM nzi_console.memberships WHERE user_id IN ('m-padded','m-one') ORDER BY user_id`);
    await backfill();
    assert.deepEqual((await q(`SELECT contact_id, first_name FROM nzi_console.client_contacts WHERE contact_id IN ('k-dr','k-one','k-hyphen','k-erased') ORDER BY contact_id`)).map((r) => [r.contact_id, r.first_name]),
      [["k-dr", "Dr."], ["k-erased", null], ["k-hyphen", "Mary-Jane"], ["k-one", "Cher"]]);
    assert.deepEqual((await q(`SELECT user_id, first_name FROM nzi_console.memberships WHERE user_id IN ('m-padded','m-one','m-blank','m-null') ORDER BY user_id`)).map((r) => [r.user_id, r.first_name]),
      [["m-blank", null], ["m-null", null], ["m-one", "Sam"], ["m-padded", "Anne"]]);
    assert.deepEqual(await q(`SELECT user_id, version, updated_at FROM nzi_console.memberships WHERE user_id IN ('m-padded','m-one') ORDER BY user_id`), versionsBefore, "a default is not an edit: no version bump");
    assert.deepEqual(await q(`SELECT 1 FROM nzi_console.client_contacts WHERE first_name IS NULL AND nullif(btrim(full_name), '') IS NOT NULL`), [], "nothing with a name is left without a first name");
    // Run again: nothing changes - and a first name somebody has since set is not overwritten.
    await db.query(`UPDATE nzi_console.client_contacts SET first_name = 'Janey' WHERE contact_id = 'k-dr'`);
    await backfill();
    assert.equal((await contact("k-dr")).first_name, "Janey");
  });

  it("the encryption backfill seals what the migration left plaintext-only: first_name_sealed is filled for both tables", async () => {
    assert.equal((await contact("k-one")).first_name_sealed, null, "the migration cannot seal - the key lives in the application");
    const outcome = await backfillSealedPii(database.pool, { organisationId: ORG, actorId: "fn-backfill", keys: resolveSealingKeys(), batchSize: 50 });
    assert.ok(outcome, "the backfill ran");
    for (const [table, id, idColumn] of [["client_contacts", "k-one", "contact_id"], ["client_contacts", "k-hyphen", "contact_id"], ["memberships", "m-padded", "user_id"]] as const) {
      const [row] = await q(`SELECT first_name, first_name_sealed FROM nzi_console.${table} WHERE ${idColumn} = $1`, [id]);
      assert.ok(row!.first_name_sealed, `${table}.${id}: first name plaintext with no ciphertext`);
      assert.ok(!JSON.stringify(row!.first_name_sealed).includes(row!.first_name), "the ciphertext is not the name");
    }
  });

  it("a contact: the first name defaults from the full name when not given or blank, is kept when given, and is sealed in the same transaction", async () => {
    const a = (await createClientContact(database.pool, { clientId: CLIENT, fullName: "Grace Hopper", isPrimary: false, roles: [] }, staff())).data.contactId;
    const b = (await createClientContact(database.pool, { clientId: CLIENT, fullName: "Elizabeth Windsor", firstName: "Liz", isPrimary: false, roles: [] }, staff())).data.contactId;
    const c = (await createClientContact(database.pool, { clientId: CLIENT, fullName: "Hedy Lamarr", firstName: "   ", isPrimary: false, roles: [] }, staff())).data.contactId;
    assert.equal((await contact(a)).first_name, "Grace", "not given: the default");
    assert.equal((await contact(b)).first_name, "Liz", "given: kept - the full name is untouched");
    assert.equal((await contact(b)).full_name, "Elizabeth Windsor");
    assert.equal((await contact(c)).first_name, "Hedy", "blank: the default, never nothing");
    for (const id of [a, b, c]) assert.ok((await contact(id)).first_name_sealed, "written with its ciphertext in the same transaction");
    // Read back as the form pre-fills it.
    const listed = await withTenantRead(database.pool, ORG, (tx) => listClientContacts(tx, CLIENT));
    assert.equal(listed.find((item) => item.id === b)!.firstName, "Liz");
    assert.equal(listed.find((item) => item.id === b)!.fullName, "Elizabeth Windsor");
  });

  it("a contact's first name is editable, follows a renamed full name only while it is still the default, and the history keeps the full name", async () => {
    const id = (await createClientContact(database.pool, { clientId: CLIENT, fullName: "Rose Franklin", isPrimary: false, roles: [] }, staff())).data.contactId;
    let version = (await contact(id)).version as number;
    const fields = { contactId: id, isPrimary: false, roles: [] as never[] };
    // A caller that never mentions a first name renames the contact: the default follows.
    await updateClientContact(database.pool, { ...fields, expectedVersion: version, fullName: "Rosalind Franklin" }, staff()); version += 1;
    assert.equal((await contact(id)).first_name, "Rosalind", "still the default, so it follows the rename");
    // Somebody sets it to what she goes by: editable, and from then on a rename leaves it alone.
    await updateClientContact(database.pool, { ...fields, expectedVersion: version, fullName: "Rosalind Franklin", firstName: "Ros" }, staff()); version += 1;
    assert.equal((await contact(id)).first_name, "Ros");
    await updateClientContact(database.pool, { ...fields, expectedVersion: version, fullName: "Rosalind E. Franklin" }, staff()); version += 1;
    assert.equal((await contact(id)).first_name, "Ros", "a first name that was set is never overwritten by a rename");
    assert.equal((await contact(id)).full_name, "Rosalind E. Franklin");
    // Clearing it puts the default back.
    await updateClientContact(database.pool, { ...fields, expectedVersion: version, fullName: "Rosalind E. Franklin", firstName: "" }, staff());
    assert.equal((await contact(id)).first_name, "Rosalind");
    assert.ok((await contact(id)).first_name_sealed);
    // The record of who the person is stays the full name: every version snapshot and the audit.
    const snapshots = await q(`SELECT snapshot_json FROM nzi_console.client_contact_versions WHERE contact_id = $1 ORDER BY version`, [id]);
    assert.deepEqual(snapshots.map((row) => row.snapshot_json.fullName), ["Rose Franklin", "Rosalind Franklin", "Rosalind Franklin", "Rosalind E. Franklin", "Rosalind E. Franklin"]);
    const audited = await q(`SELECT before_json FROM nzi_console.audit_events WHERE entity_id = $1 AND action = 'client_contact_updated' ORDER BY occurred_at LIMIT 1`, [id]);
    assert.equal(audited[0]?.before_json?.fullName, "Rose Franklin", "the audit records the full name");
  });

  it("a team member: captured on add (default or given), editable on update, follows a rename only while it is the default, sealed, and the roster shows it", async () => {
    const added = await addStaff(database.pool, { displayName: "Grace Adviser", email: "grace@example.test" }, staff());
    const withFirst = await addStaff(database.pool, { displayName: "Alexander Adviser", firstName: "Alex", email: "alex@example.test" }, staff());
    const grace = added.data.userId, alex = withFirst.data.userId;
    assert.equal((await member(grace)).first_name, "Grace");
    assert.equal((await member(alex)).first_name, "Alex");
    assert.equal((await member(alex)).display_name, "Alexander Adviser", "the full name is kept");
    for (const id of [grace, alex]) assert.ok((await member(id)).first_name_sealed, "sealed with the write");

    await updateStaff(database.pool, { userId: grace, expectedVersion: (await member(grace)).version, displayName: "Gracie Adviser" }, staff());
    assert.equal((await member(grace)).first_name, "Gracie", "the default follows the rename");
    await updateStaff(database.pool, { userId: alex, expectedVersion: (await member(alex)).version, displayName: "Alexander J. Adviser" }, staff());
    assert.equal((await member(alex)).first_name, "Alex", "a first name that was set is not overwritten");
    await updateStaff(database.pool, { userId: alex, expectedVersion: (await member(alex)).version, displayName: "Alexander J. Adviser", firstName: "Xander" }, staff());
    assert.equal((await member(alex)).first_name, "Xander");
    assert.ok((await member(alex)).first_name_sealed);
    // "Nothing to change" still means nothing: the same name and the same first name is refused, not silently re-saved.
    await assert.rejects(updateStaff(database.pool, { userId: alex, expectedVersion: (await member(alex)).version, displayName: "Alexander J. Adviser", firstName: "Xander" }, staff()),
      (error: unknown) => error instanceof CommandValidationError && error.issues.some((item) => item.code === "NO_CHANGE"));

    const page = await withTenantRead(database.pool, ORG, (tx) => listStaffPage(tx, { ...defaultListQuery(staffListSpec), pageSize: 100 } as never));
    assert.deepEqual([page.rows.find((row) => row.userId === alex)!.firstName, page.rows.find((row) => row.userId === alex)!.displayName], ["Xander", "Alexander J. Adviser"]);
    // The audit says a first name changed - by field name, never its value.
    const audit = await q(`SELECT after_json FROM nzi_console.audit_events WHERE entity_id = $1 AND action = 'staff.updated' ORDER BY occurred_at DESC LIMIT 1`, [alex]);
    assert.ok(audit[0]!.after_json.changed.includes("firstName"));
    assert.ok(!JSON.stringify(audit[0]!.after_json).includes("Xander"), "no name in the audit payload");
  });

  it("nothing is blank: no first name held falls back to the first word; no name at all yields no name for a caller to say \"there\" for", async () => {
    await db.query(`UPDATE nzi_console.memberships SET first_name = NULL WHERE user_id = 'fn-ada'`);
    assert.equal(await withTenantRead(database.pool, ORG, (tx) => staffFirstName(tx, ORG, "fn-ada")), "Ada", "first_name not held: the first word of the name");
    assert.equal(await withTenantRead(database.pool, ORG, (tx) => staffFirstName(tx, ORG, "m-null")), null, "no name at all: null - the greeting says \"there\", the chip says nobody");
    assert.equal(await withTenantRead(database.pool, ORG, (tx) => staffFirstName(tx, ORG, "m-blank")), null);
    assert.equal(await withTenantRead(database.pool, ORG, (tx) => staffFirstName(tx, ORG, "no-such-user")), null);
    const listed = await withTenantRead(database.pool, ORG, (tx) => listClientContacts(tx, CLIENT, { includeInactive: true }));
    assert.ok(listed.every((item) => item.firstName === null || item.firstName.trim() !== ""), "a read model never carries a blank first name");
  });

  it("a first name is personal data: it is in the inventory as sealed and shredded with the key", async () => {
    const { PII_COLUMNS } = await import("../src/piiInventory");
    for (const table of ["client_contacts", "memberships"]) {
      const column = PII_COLUMNS.find((entry) => entry.table === table && entry.column === "first_name");
      assert.ok(column, `${table}.first_name is not in the PII inventory`);
      assert.equal(column.erasure, "shred-key");
      assert.deepEqual(column.storage, { kind: "sealed", sealed: "first_name_sealed" });
    }
  });
});
