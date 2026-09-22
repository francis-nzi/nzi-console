import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { SEALABLE_ROWS, SEALED_COLUMNS, plaintextColumnsOf, unsealedPredicate, type SealingKeys } from "../src/piiSealing";
import { resolveSealingKeys } from "../src/piiSealingKeys";
import { backfillSealedPii } from "../src/piiBackfill";
import { insertClientContact } from "../src/clientContactRecords";
import { updateClientContact } from "../src/clientContacts";
import { staffGrant } from "./support/access";
import { openForSubject, unwrapSubjectKey, type SealedValue, type WrappedKey } from "../src/subjectCrypto";

/**
 * The standing invariant: no row has personal data without ciphertext beside it (NZC-119).
 *
 * Francis's wording, and the reason it is a standing check rather than a one-off: *after backfill
 * completes with dual-write live, zero rows have plaintext-but-null-ciphertext.* A one-off run proves
 * a moment; a check proves the property, including after the next write path is added.
 *
 * ## Why it also proves it can fail
 *
 * A check over an empty set passes. This repo has been bitten twice by exactly that — a date gate that
 * went green over zero files because a path with a space in it percent-encoded, and three privilege
 * tests that "proved" a denial by connecting as a `NOLOGIN` role, so the login failed and the grant was
 * never exercised. So here there are three guards against a vacuous pass:
 *
 *   1. the columns checked are counted, and the count must match the inventory;
 *   2. every column the backfill knows how to fill must appear in that inventory;
 *   3. one column is deliberately emptied and the same query must report it.
 *
 * Without the third, a query with a typo in it reports zero violations for ever.
 */

const DATABASE_URL = TEST_DATABASE_URL;
const ORG = "org-seal";
const ACTOR = "staff-seal";

/** The stages whose columns are expected to be filled once the backfill has run. */
const EXPECTED_FILLED = SEALED_COLUMNS.filter((column) => column.stage !== "deferred");

describe("personal data has ciphertext beside it (NZC-119)", { skip: DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;
  /**
   * The keys the *application* seals with, not a second set minted here.
   *
   * The write path takes its keys from the environment (`resolveSealingKeys`), so a suite that mints
   * its own is running the backfill under one key and the dual-write under another. Nothing failed,
   * because nothing this suite asserted ever decrypted what the application had sealed — it checked
   * that ciphertext was present and stopped there. Sharing the source is what lets a test open a value
   * the command wrote, and the keys are random per run regardless (see tests/support/sealingKeys.ts).
   */
  const keys: SealingKeys = resolveSealingKeys();

  before(async () => {
    database = (await createDisposableDatabase("piicover"))!;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,'Sealing')`, [ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    // The owner is subject to its own policies here (FORCE ROW LEVEL SECURITY), so the fixture needs
    // a tenant context like any other writer.
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);

    await db.query(`INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,'client-1','Acme','active')`, [ORG]);

    // A staff member: the membership is the subject, the credential is their login.
    //
    // `consultant` as a literal, because there is no roles table to read one from: `role_id` is text
    // governed by a CHECK, whose list 0066 replaced — 'administrator' became 'admin' and the rest moved to
    // ('admin','consultant','reviewer','finance','viewer'). An earlier draft selected from a
    // roles table that has never existed in this schema — which is what the reference guard now catches.
    await db.query(
      `INSERT INTO nzi_console.memberships (organisation_id,user_id,role_id,status,display_name,email)
       VALUES ($1,'user-1','consultant','active','Ada Lovelace','ada@nzi.test')`, [ORG]);
    await db.query(
      `INSERT INTO nzi_console.staff_credentials
         (organisation_id,user_id,email_normalized,password_salt,password_hash,totp_ciphertext,totp_iv,totp_tag)
       VALUES ($1,'user-1','ada@nzi.test','salt','hash','c','i','t')`, [ORG]);

    // A client contact, a portal account, and a trainee with a pending address change.
    await db.query(
      `INSERT INTO nzi_console.client_contacts (organisation_id,contact_id,client_id,full_name,job_title,email,phone,created_by,updated_by)
       VALUES ($1,'contact-1','client-1','Grace Hopper','Director','grace@acme.test','+44 20 7000 0000',$2,$2)`, [ORG, ACTOR]);
    await db.query(
      `INSERT INTO nzi_console.portal_users (organisation_id,portal_user_id,client_id,email_normalized,display_name,status)
       VALUES ($1,'portal-1','client-1','grace@acme.test','Grace Hopper','active')`, [ORG]);
    await db.query(
      `INSERT INTO nzi_console.trainees (organisation_id,trainee_id,full_name,personal_email,phone,current_employer_name,created_by)
       VALUES ($1,'trainee-1','Alan Turing','alan@acme.test','','',$2)`, [ORG, ACTOR]);
    await db.query(
      `INSERT INTO nzi_console.trainee_email_changes (organisation_id,change_id,trainee_id,current_email,new_email,token_hash,expires_at)
       VALUES ($1,'change-1','trainee-1','alan@acme.test','alan.turing@acme.test','token-hash', now() + interval '1 day')`, [ORG]);

    await backfillSealedPii(database.pool, { organisationId: ORG, actorId: ACTOR, keys, batchSize: 50 });
  });

  after(async () => { await db?.end(); await database?.end(); });

  /** The invariant, as one query per column. */
  const violations = async (column: (typeof SEALED_COLUMNS)[number]): Promise<number> => {
    const { rows } = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM nzi_console.${column.table}
        WHERE nullif(btrim(${column.plaintext}::text), '') IS NOT NULL AND ${column.sealed} IS NULL`);
    return Number(rows[0]!.count);
  };

  it("leaves no row with plaintext and no ciphertext, in any column it covers", async () => {
    const checked: string[] = [];
    const offenders: string[] = [];
    for (const column of EXPECTED_FILLED) {
      checked.push(`${column.table}.${column.plaintext}`);
      const count = await violations(column);
      if (count > 0) offenders.push(`${column.table}.${column.plaintext}: ${count} row(s)`);
    }
    assert.deepEqual(offenders, [], "personal data with no ciphertext is unencrypted and unerasable");

    // The meta-assertion: a pass has to mean the columns were looked at, not that the loop was empty.
    assert.equal(checked.length, EXPECTED_FILLED.length);
    assert.ok(checked.length >= 16, `only ${checked.length} columns checked — the inventory has shrunk or the filter is wrong`);
  });

  it("covers every column the backfill knows how to fill", async () => {
    // The two lists are separate structures, so this is where they are made to agree. A column the
    // backfill fills but the check does not look at is a column that can silently stop being filled.
    const inventory = new Set(SEALED_COLUMNS.map((column) => `${column.table}.${column.plaintext}`));
    const missing = SEALABLE_ROWS.flatMap((row) => plaintextColumnsOf(row).map((plaintext) => `${row.table}.${plaintext}`))
      .filter((name) => !inventory.has(name));
    assert.deepEqual(missing, [], "the backfill fills a column the standing check never looks at");
  });

  it("reports a violation when there is one", async () => {
    // Guards the query itself. Without this, a typo in the predicate reports zero for ever and the
    // suite is indistinguishable from one that passes.
    const column = EXPECTED_FILLED.find((entry) => entry.table === "client_contacts" && entry.plaintext === "full_name")!;
    assert.equal(await violations(column), 0, "sealed before the tamper");
    await db.query(`UPDATE nzi_console.client_contacts SET full_name_sealed=NULL WHERE contact_id='contact-1'`);
    try {
      assert.equal(await violations(column), 1, "the check must see plaintext with its ciphertext removed");
    } finally {
      await backfillSealedPii(database.pool, { organisationId: ORG, actorId: ACTOR, keys, batchSize: 50 });
    }
    assert.equal(await violations(column), 0, "and the backfill puts it back");
  });

  it("seals a row the moment the application writes it, not when the backfill next runs", async () => {
    // Dual-write is the half that closes the window: a row created after the backfill has passed must
    // already have its ciphertext, because nothing is coming back for it.
    const context = { organisationId: ORG, actorId: ACTOR, correlationId: "corr-1", principal: "staff" } as never;
    await database.pool.query(`SELECT 1`);
    const client = await database.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SELECT set_config('app.organisation_id', $1, true)`, [ORG]);
      const row = await insertClientContact(client, context, "client-1", {
        fullName: "Katherine Johnson", jobTitle: "Mathematician", email: "katherine@acme.test",
        phone: "+44 20 7000 0001", isPrimary: false, roles: [],
      } as never);
      await client.query("COMMIT");

      const stored = await db.query<{ full_name_sealed: SealedValue | null; email_bidx: string | null }>(
        `SELECT full_name_sealed, email_bidx FROM nzi_console.client_contacts WHERE contact_id=$1`, [row.contact_id]);
      assert.ok(stored.rows[0]!.full_name_sealed, "the name was sealed in the same transaction");
      assert.ok(stored.rows[0]!.email_bidx, "and the address was indexed");

      // And it is the name, not merely ciphertext: present-but-unreadable would satisfy the invariant
      // and have lost the row.
      const { rows } = await db.query<{ wrapped_key: WrappedKey }>(
        `SELECT k.wrapped_key FROM nzi_console.data_subject_keys k
           JOIN nzi_console.data_subject_links l
             ON (l.organisation_id, l.subject_id) = (k.organisation_id, k.subject_id)
          WHERE l.source_table='client_contacts' AND l.source_id=$1`, [row.contact_id]);
      assert.equal(
        openForSubject(stored.rows[0]!.full_name_sealed!, unwrapSubjectKey(rows[0]!.wrapped_key, keys.masterKey)),
        "Katherine Johnson");
    } finally {
      client.release();
    }
  });

  it("seals under a key that reads the value back, and one subject per person", async () => {
    // Proves the ciphertext is the value rather than merely present — a sealed column filled with
    // something unreadable would satisfy the invariant and lose the data.
    const { rows } = await db.query<{ full_name_sealed: SealedValue; wrapped_key: WrappedKey }>(
      `SELECT c.full_name_sealed, k.wrapped_key
         FROM nzi_console.client_contacts c
         JOIN nzi_console.data_subject_links l
           ON (l.organisation_id, l.source_table, l.source_id) = (c.organisation_id, 'client_contacts', c.contact_id)
         JOIN nzi_console.data_subject_keys k
           ON (k.organisation_id, k.subject_id) = (l.organisation_id, l.subject_id)
        WHERE c.contact_id='contact-1'`);
    const row = rows[0];
    assert.ok(row, "the contact has a subject and the subject has a key");
    assert.equal(openForSubject(row.full_name_sealed, unwrapSubjectKey(row.wrapped_key, keys.masterKey)), "Grace Hopper");
  });

  it("reaches the history of a record, not only its present (NZC-120)", async () => {
    // Sealing the live contact and leaving its versions readable means a shred erases the latest value
    // of a person and none of the earlier ones, which has erased nobody.
    //
    // Three real edits through the command, not three hand-written inserts. The distinction matters: an
    // insert into `client_contact_versions` by the test proves the *backfill* can seal history, which is
    // the half that covers the past. Whether the application seals a version it writes today is a
    // different claim, and only the real path can make it.
    // A real grant, because the command is permission-checked and a context without one is refused —
    // which is the correct behaviour and the reason this goes through the command rather than around it.
    const context = {
      organisationId: ORG, actorId: ACTOR, principal: "staff" as const,
      grant: staffGrant("admin", ORG, ACTOR),
    };
    let version = 1;
    for (const name of ["Grace Hopper-Smith", "Grace B Hopper", "Grace Hopper"]) {
      const outcome = await updateClientContact(database.pool, {
        contactId: "contact-1", expectedVersion: version, fullName: name, jobTitle: "Director",
        email: "grace@acme.test", phone: "+44 20 7000 0000", isPrimary: false, roles: [],
      } as never, { ...context, correlationId: `corr-${name}`, idempotencyKey: `idem-${name}` } as never);
      version = outcome.data.version;
    }

    // No backfill in between: if the write path did not seal these, they are unsealed right now.
    const history = await db.query<{ version: number; snapshot_sealed: SealedValue | null; wrapped_key: WrappedKey }>(
      `SELECT v.version, v.snapshot_sealed, k.wrapped_key
         FROM nzi_console.client_contact_versions v
         JOIN nzi_console.data_subject_links l
           ON (l.organisation_id, l.source_table, l.source_id) = (v.organisation_id, 'client_contacts', v.contact_id)
         JOIN nzi_console.data_subject_keys k
           ON (k.organisation_id, k.subject_id) = (l.organisation_id, l.subject_id)
        WHERE v.contact_id='contact-1' ORDER BY v.version`);
    assert.ok(history.rows.length >= 3,
      `only ${history.rows.length} history rows — the fixture did not build a history to be wrong about`);

    // Under *one* key, the live record's. This is the property that makes a single shred cover a
    // person's present and their past together, instead of an erasure having to remember a list of keys.
    const wrapped = new Set(history.rows.map((row) => JSON.stringify(row.wrapped_key)));
    assert.equal(wrapped.size, 1, "the history is sealed under one key, the live record's");

    const subjectKey = unwrapSubjectKey(history.rows[0]!.wrapped_key, keys.masterKey);
    for (const row of history.rows) {
      assert.ok(row.snapshot_sealed, `version ${row.version} was written without ciphertext`);
      // Decrypted and parsed, not merely non-empty: a jsonb column reaches the seal already parsed, and
      // `String(…)` on one of those seals the text "[object Object]" — which would decrypt cleanly and
      // have thrown the snapshot away.
      const snapshot = JSON.parse(openForSubject(row.snapshot_sealed, subjectKey));
      assert.equal(typeof snapshot.fullName, "string", `version ${row.version} did not seal its snapshot`);
    }

    // And the past half: the backfill fills a version whose ciphertext is missing, which is what the
    // rows written before this column existed look like.
    const column = EXPECTED_FILLED.find((entry) => entry.table === "client_contact_versions")!;
    await db.query(`UPDATE nzi_console.client_contact_versions SET snapshot_sealed=NULL WHERE contact_id='contact-1'`);
    assert.ok(await violations(column) >= 3, "the standing check must see history with its ciphertext removed");
    await backfillSealedPii(database.pool, { organisationId: ORG, actorId: ACTOR, keys, batchSize: 50 });
    assert.equal(await violations(column), 0, "and the backfill seals every version, not just the latest");
  });

  it("has nothing left to do on a second run", async () => {
    // Resumability, from the other side: the queue is the outstanding work, so a finished backfill
    // selects nothing and a re-run is free rather than a second pass over everything.
    const outcome = await backfillSealedPii(database.pool, { organisationId: ORG, actorId: ACTOR, keys, batchSize: 50 });
    const worked = outcome.tables.filter((table) => table.sealed > 0);
    assert.deepEqual(worked.map((table) => table.table), [], "a completed backfill re-seals nothing");
    for (const descriptor of SEALABLE_ROWS) {
      const { rows } = await db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM nzi_console.${descriptor.table}
          WHERE organisation_id=$1 AND (${unsealedPredicate(descriptor)})`, [ORG]);
      assert.equal(Number(rows[0]!.count), 0, `${descriptor.table} still has unsealed rows`);
    }
  });
});
