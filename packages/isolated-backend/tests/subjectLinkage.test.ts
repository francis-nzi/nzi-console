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

  it("cannot be read by the application role, only written", async () => {
    // The confinement that matters, and it is a grant rather than a convention: reading a digest is
    // the correlating act, and it has exactly one entry point.
    await db.query(
      `INSERT INTO nzi_console.data_subject_linkage (organisation_id,source_table,source_id,linkage_bidx)
       VALUES ($1,'trainees','t-1',$2)`, [ORG, linkageDigest("ada@example.test", linkageKey)]);

    const granted = await db.query<{ sel: boolean; ins: boolean }>(
      `SELECT has_table_privilege('nzi_console_app','nzi_console.data_subject_linkage','SELECT') AS sel,
              has_table_privilege('nzi_console_app','nzi_console.data_subject_linkage','INSERT') AS ins`);
    assert.equal(granted.rows[0]!.sel, false, "reading a digest is the correlating act, and is not granted");
    assert.equal(granted.rows[0]!.ins, true, "writing one is, because the linker computes them");

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
