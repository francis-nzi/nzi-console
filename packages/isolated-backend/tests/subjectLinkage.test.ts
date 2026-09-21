import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { blindIndex, linkageDigest, normaliseEmailAtRest } from "../src/subjectCrypto";

/**
 * The linkage digest, and the confinement that makes it safe to have (NZC-118).
 *
 * The column digests are domain-separated so one table cannot confirm a value in another. That is
 * what makes them safe, and it is why the linker cannot use them — the same address gives a
 * different digest per table, which is the comparison the linker exists to make. So linkage has its
 * own digest, and is confined rather than separated. These tests are about the confinement.
 */

const DATABASE_URL = TEST_DATABASE_URL;
const ORG = "org-a";

describe("the linkage digest (NZC-118)", { skip: DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;
  const indexKey = randomBytes(32).toString("base64");
  const linkageKey = randomBytes(32).toString("base64");

  before(async () => {
    database = (await createDisposableDatabase("linkage"))!;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,'Org')`, [ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
  });

  after(async () => { await db?.end(); await database?.end(); });

  it("is the same across tables, which the column digests deliberately are not", () => {
    // The whole reason this exists. Ada in `trainees` and Ada in `client_contacts` must look like
    // one person to the linker, and like two unrelated values to everything else.
    const a = linkageDigest("ada@example.test", linkageKey);
    const b = linkageDigest(" Ada@Example.test ", linkageKey);
    assert.ok(a);
    assert.equal(a, b, "normalises the same way the columns do");

    const fromTrainees = blindIndex("trainees.personal_email", "ada@example.test", indexKey);
    const fromContacts = blindIndex("client_contacts.email", "ada@example.test", indexKey);
    assert.notEqual(fromTrainees, fromContacts, "column digests stay separated");
    assert.notEqual(a, fromTrainees, "and linkage is neither of them");
  });

  it("cannot be computed by whoever can compute a column digest", () => {
    // Its own key: the ability to log somebody in does not carry the ability to correlate them
    // across the estate.
    assert.notEqual(linkageDigest("ada@example.test", indexKey), linkageDigest("ada@example.test", linkageKey));
  });

  it("is nothing for an absent address", () => {
    assert.equal(linkageDigest(null, linkageKey), null);
    assert.equal(linkageDigest("   ", linkageKey), null);
  });

  it("cannot be read or written directly by the application role", async () => {
    // 0101 granted INSERT and UPDATE and revoked SELECT, and the seal path then found the gap between
    // those: `INSERT … ON CONFLICT DO UPDATE` needs SELECT on the conflict target, so a statement that
    // looked permitted was not. Widening the grant to fix it would also have made the correlating read
    // legal, so 0103 took the other direction — no direct privilege at all, two definer doors (NZC-121).
    await db.query(
      `INSERT INTO nzi_console.data_subject_linkage (organisation_id,source_table,source_id,linkage_bidx)
       VALUES ($1,'trainees','t-1',$2)`, [ORG, linkageDigest("ada@example.test", linkageKey)]);

    const granted = await db.query<{ sel: boolean; ins: boolean; upd: boolean; exec_write: boolean; exec_read: boolean }>(
      `SELECT has_table_privilege('nzi_console_app','nzi_console.data_subject_linkage','SELECT') AS sel,
              has_table_privilege('nzi_console_app','nzi_console.data_subject_linkage','INSERT') AS ins,
              has_table_privilege('nzi_console_app','nzi_console.data_subject_linkage','UPDATE') AS upd,
              has_function_privilege('nzi_console_app','nzi_console.record_subject_linkage(text,text,text,text,text)','EXECUTE') AS exec_write,
              has_function_privilege('nzi_console_app','nzi_console.subjects_sharing_linkage(text,text,text[])','EXECUTE') AS exec_read`);
    assert.equal(granted.rows[0]!.sel, false, "reading a digest is the correlating act, and is not granted");
    assert.equal(granted.rows[0]!.ins, false, "nor is writing one directly");
    assert.equal(granted.rows[0]!.upd, false, "nor updating one");
    assert.equal(granted.rows[0]!.exec_write, true, "the write goes through the function");
    assert.equal(granted.rows[0]!.exec_read, true, "and so does the only read a write path needs");

    // The behaviour, by becoming the role for one statement rather than connecting as it — the
    // runtime roles are NOLOGIN, so connecting would fail for a reason that has nothing to do with
    // privilege, and the test would pass without exercising it.
    await db.query("BEGIN");
    await db.query("SET LOCAL ROLE nzi_console_app");
    await assert.rejects(
      () => db.query(`SELECT linkage_bidx FROM nzi_console.data_subject_linkage`),
      /permission denied/i, "the application role cannot read a linkage digest");
    await db.query("ROLLBACK");

    await db.query(
      `INSERT INTO nzi_console.data_subject_linkage (organisation_id,source_table,source_id,linkage_bidx)
       VALUES ($1,'client_contacts','c-1',$2)`, [ORG, linkageDigest("ada@example.test", linkageKey)]);
  });

  it("records a digest through the function, for the row in hand and no other", async () => {
    // The write door. Becoming the role for the statement, because the runtime roles are NOLOGIN and
    // connecting as one would fail before any privilege was checked.
    await db.query(
      `INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,'client-fn','Acme','active')`, [ORG]);
    await db.query(
      `INSERT INTO nzi_console.client_contacts (organisation_id,contact_id,client_id,full_name,created_by,updated_by)
       VALUES ($1,'c-fn','client-fn','Grace Hopper','seed','seed')`, [ORG]);
    const digest = linkageDigest("grace@example.test", linkageKey)!;

    await db.query("BEGIN");
    await db.query("SET LOCAL ROLE nzi_console_app");
    await db.query(`SELECT nzi_console.record_subject_linkage($1,'client_contacts','c-fn','email',$2)`, [ORG, digest]);
    await db.query("COMMIT");

    const stored = await db.query<{ linkage_bidx: string }>(
      `SELECT linkage_bidx FROM nzi_console.data_subject_linkage WHERE source_id='c-fn'`);
    assert.equal(stored.rows[0]!.linkage_bidx, digest, "the row the arguments named, written as the owner");

    // Idempotent, which is what the failing upsert was for: sealing the same row twice must not raise.
    await db.query("BEGIN");
    await db.query("SET LOCAL ROLE nzi_console_app");
    await db.query(`SELECT nzi_console.record_subject_linkage($1,'client_contacts','c-fn','email',$2)`, [ORG, digest]);
    await db.query("COMMIT");
  });

  it("refuses to record linkage for a person who does not exist, or another tenant's", async () => {
    // The integrity the table cannot express: it has no foreign keys to the person-tables, because it is
    // written by a role that cannot read it. A linkage row for nobody is one the linker reconciles for ever.
    await db.query("BEGIN");
    await db.query("SET LOCAL ROLE nzi_console_app");
    await assert.rejects(
      () => db.query(`SELECT nzi_console.record_subject_linkage($1,'client_contacts','no-such','email','deadbeef')`, [ORG]),
      /No client_contacts row/i);
    await db.query("ROLLBACK");

    await db.query("BEGIN");
    await db.query("SET LOCAL ROLE nzi_console_app");
    await assert.rejects(
      () => db.query(`SELECT nzi_console.record_subject_linkage('other-org','client_contacts','c-fn','email','deadbeef')`),
      /outside the current organisation/i, "a definer function's first job is to refuse what its privilege would allow");
    await db.query("ROLLBACK");
  });

  it("answers about digests the caller supplied, a few at a time, and returns no digest", async () => {
    // The read door. It exists so a write path can avoid minting a rival subject for somebody already
    // known, without being able to correlate the estate.
    const digest = linkageDigest("grace@example.test", linkageKey)!;
    const subject = await db.query<{ subject_id: string }>(
      `INSERT INTO nzi_console.data_subjects (organisation_id,subject_id,created_by)
       VALUES ($1,gen_random_uuid(),'seed') RETURNING subject_id`, [ORG]);
    await db.query(
      `INSERT INTO nzi_console.data_subject_links (organisation_id,subject_id,source_table,source_id,link_method,linked_by)
       VALUES ($1,$2,'client_contacts','c-fn','deterministic-email','seed')`, [ORG, subject.rows[0]!.subject_id]);

    await db.query("BEGIN");
    await db.query("SET LOCAL ROLE nzi_console_app");
    const found = await db.query<{ subject_id: string; same_table: boolean }>(
      `SELECT subject_id, same_table FROM nzi_console.subjects_sharing_linkage($1,'trainees',ARRAY[$2]::text[])`,
      [ORG, digest]);
    assert.equal(found.rows.length, 1, "the address is known, under one subject");
    assert.equal(found.rows[0]!.same_table, false, "and the match was in another table, which is what makes it the same person");
    assert.ok(!JSON.stringify(found.rows).includes(digest), "the answer carries no digest");

    // A cap, because asking about four digests you already hold is a lookup and asking about forty
    // thousand is an enumeration. This is what keeps the door from being an oracle.
    await assert.rejects(
      () => db.query(`SELECT * FROM nzi_console.subjects_sharing_linkage($1,'trainees',ARRAY['a','b','c','d','e']::text[])`, [ORG]),
      /one and four digests/i);
    await db.query("ROLLBACK");
  });

  it("tells the linker which rows match, and never what they matched on", async () => {
    const { rows } = await db.query<{ group_key: number; source_table: string; source_id: string }>(
      `SELECT * FROM nzi_console.subject_linkage_groups($1)`, [ORG]);
    // Ada's two rows are one group.
    assert.equal(rows.length, 2);
    assert.equal(new Set(rows.map((row) => row.group_key)).size, 1);
    assert.deepEqual(rows.map((row) => row.source_table).sort(), ["client_contacts", "trainees"]);
    // And the digest itself is not in the answer, so a caller cannot take it away and compare it
    // against a guess.
    const serialised = JSON.stringify(rows);
    assert.ok(!serialised.includes(linkageDigest("ada@example.test", linkageKey)!));
  });

  it("does not group a row with itself, so a lone address raises nothing", async () => {
    await db.query(
      `INSERT INTO nzi_console.data_subject_linkage (organisation_id,source_table,source_id,linkage_bidx)
       VALUES ($1,'memberships','m-1',$2)`, [ORG, linkageDigest("solo@example.test", linkageKey)]);
    const { rows } = await db.query<{ source_id: string }>(
      `SELECT * FROM nzi_console.subject_linkage_groups($1)`, [ORG]);
    assert.ok(!rows.some((row) => row.source_id === "m-1"), "a singleton is not a match");
  });

  it("stops correlating once the digest is nulled", async () => {
    // Erasure nulls it alongside the operational digests. After that the person is not merely
    // unreadable — they are uncorrelatable, so nothing can rebuild the link from what remains.
    await db.query(
      `UPDATE nzi_console.data_subject_linkage SET linkage_bidx=NULL
        WHERE organisation_id=$1 AND source_table='trainees' AND source_id='t-1'`, [ORG]);
    const { rows } = await db.query<{ source_id: string }>(
      `SELECT * FROM nzi_console.subject_linkage_groups($1)`, [ORG]);
    assert.ok(!rows.some((row) => row.source_id === "t-1"), "the erased row is in no group");
    assert.ok(!rows.some((row) => row.source_id === "c-1"), "and its former partner is alone again");
  });
});

describe("normalisation at rest, now that the database no longer checks it (NZC-118)", () => {
  it("stores an address the way every write path already stored it", () => {
    // 0100 dropped four CHECKs that asserted an address equalled its own lower-cased trimmed form,
    // because ciphertext cannot satisfy them. That moved the invariant from the database into the
    // application — so it is pinned here instead of being left to whoever writes the next writer.
    assert.equal(normaliseEmailAtRest(" Ada@Example.test "), "ada@example.test");
    assert.equal(normaliseEmailAtRest("ALREADY@NORMAL.TEST"), "already@normal.test");
  });

  it("agrees with what the digests normalise, by construction", () => {
    // The two must not drift: a digest computed over a differently-normalised string would match
    // nothing, and the failure would look like a wrong password.
    const key = randomBytes(32).toString("base64");
    const asEntered = " Ada@Example.test ";
    assert.equal(
      blindIndex("trainees.personal_email", asEntered, key),
      blindIndex("trainees.personal_email", normaliseEmailAtRest(asEntered), key));
    assert.equal(
      linkageDigest(asEntered, key),
      linkageDigest(normaliseEmailAtRest(asEntered), key));
  });
});
