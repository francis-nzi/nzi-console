import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { resolveSubjectData } from "../src/subjectResolution";
import { sealRowPii, type SealingKeys } from "../src/piiSealing";
import { isAttributable, PII_COLUMNS } from "../src/piiInventory";
import { AuthorizationError, type StaffPrincipal } from "../src/auth";

/**
 * The shared subject-resolution read path, against real Postgres (NZC-128).
 *
 * It is the traversal under both the export and erasure, so what it reaches decides what either can
 * claim. The assertions are about reach rather than formatting: which rows it finds, what it says about
 * the ones it cannot, and that it never reads a linkage digest.
 */

const DATABASE_URL = TEST_DATABASE_URL;
const ORG = "org-res";
const SUBJECT = "11111111-2222-3333-4444-555555555555";

const admin = {
  userId: "dpo-a", organisationId: ORG, role: "admin",
  capabilities: [{ capability: "subject.review", scope: "all" }],
} as unknown as StaffPrincipal;

describe("resolving everything that belongs to one person (NZC-128)", { skip: DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;
  const keys: SealingKeys = {
    masterKey: randomBytes(32).toString("base64"),
    indexKey: randomBytes(32).toString("base64"),
    linkageKey: randomBytes(32).toString("base64"),
  };

  before(async () => {
    database = (await createDisposableDatabase("subjectres"))!;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,'Res')`, [ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
    await db.query(`INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,'client-1','Acme','active')`, [ORG]);

    // One person, reachable three ways: their contact record, its history, and a report they signed.
    await db.query(
      `INSERT INTO nzi_console.client_contacts (organisation_id,contact_id,client_id,full_name,job_title,email,phone,created_by,updated_by)
       VALUES ($1,'contact-1','client-1','Ada Lovelace','Director','ada@example.test','07700 900123','seed','seed')`, [ORG]);
    await db.query(
      `INSERT INTO nzi_console.client_contact_versions (organisation_id,contact_id,version,snapshot_json,changed_by,correlation_id)
       VALUES ($1,'contact-1',1,$2::jsonb,'seed','corr-1')`,
      [ORG, JSON.stringify({ fullName: "Ada Lovelace", email: "ada@example.test" })]);

    await db.query(
      `INSERT INTO nzi_console.data_subjects (organisation_id,subject_id,created_by) VALUES ($1,$2,'seed')`, [ORG, SUBJECT]);
    await db.query(
      `INSERT INTO nzi_console.data_subject_links (organisation_id,subject_id,source_table,source_id,link_method,linked_by)
       VALUES ($1,$2,'client_contacts','contact-1','deterministic-email','seed')`, [ORG, SUBJECT]);

    // Sealed through the one sealing path, so this reads what the application actually writes.
    await sealRowPii(db, {
      organisationId: ORG,
      subject: { sourceTable: "client_contacts", sourceId: "contact-1" },
      table: "client_contacts",
      keyColumns: { organisation_id: ORG, contact_id: "contact-1" },
      sealed: { full_name_sealed: "Ada Lovelace", job_title_sealed: "Director", phone_sealed: "07700 900123" },
      operational: [{ column: "client_contacts.email", sealedColumn: "email_sealed", indexColumn: "email_bidx", field: "email", value: "ada@example.test" }],
    }, keys, "seed");
  });

  after(async () => { await db?.end(); await database?.end(); });

  it("reaches the person's record, its history, and what they are named on", async () => {
    const resolved = await resolveSubjectData(database.pool, admin, { organisationId: ORG, subjectId: SUBJECT }, { decrypt: true, keys });
    const reached = resolved.rows.map((row) => `${row.table}:${row.reach}`).sort();
    assert.deepEqual(reached, ["client_contact_versions:history-of", "client_contacts:person-row"],
      "the live record and its history, both from one link");
  });

  it("decrypts what it gathers, when asked to", async () => {
    const resolved = await resolveSubjectData(database.pool, admin, { organisationId: ORG, subjectId: SUBJECT }, { decrypt: true, keys });
    const contact = resolved.rows.find((row) => row.table === "client_contacts")!;
    const byColumn = new Map(contact.data.map((datum) => [datum.column, datum]));
    assert.equal(byColumn.get("full_name")!.value, "Ada Lovelace");
    assert.equal(byColumn.get("email")!.value, "ada@example.test");
    assert.equal(byColumn.get("phone")!.value, "07700 900123");
  });

  it("reaches the same rows without decrypting, which is how erasure agrees with export", async () => {
    // The property the two modes exist for: erasure must not have a different idea of what a person's
    // data is than the export did, or one of them is lying.
    const forExport = await resolveSubjectData(database.pool, admin, { organisationId: ORG, subjectId: SUBJECT }, { decrypt: true, keys });
    const forErasure = await resolveSubjectData(database.pool, admin, { organisationId: ORG, subjectId: SUBJECT }, { decrypt: false });

    const shape = (subject: typeof forExport) =>
      subject.rows.map((row) => `${row.table}|${JSON.stringify(row.keys)}|${row.data.map((d) => d.column).join(",")}`).sort();
    assert.deepEqual(shape(forErasure), shape(forExport), "the same rows and the same columns, read or not");

    const contact = forErasure.rows.find((row) => row.table === "client_contacts")!;
    for (const datum of contact.data) {
      if (datum.storage === "sealed" || datum.storage === "sealed-and-indexed") {
        assert.equal(datum.value, undefined, `${datum.column} was read despite decrypt:false`);
        assert.match(datum.unavailable!, /not read/);
      }
    }
  });

  it("says what it holds and cannot attribute, rather than omitting it", async () => {
    // The axis the inventory exists for. An export that dropped these would tell somebody they had been
    // shown everything.
    const resolved = await resolveSubjectData(database.pool, admin, { organisationId: ORG, subjectId: SUBJECT }, { decrypt: true, keys });
    const expected = PII_COLUMNS.filter((column) => !isAttributable(column)).length;
    assert.equal(resolved.notAttributable.length, expected);
    assert.ok(expected > 0, "the axis has stopped meaning anything if nothing is on this side");
    for (const entry of resolved.notAttributable) {
      assert.ok(entry.because.trim(), `${entry.table}.${entry.column} is unattributable without saying why`);
      assert.ok(entry.label.trim(), "and it still has to be nameable to the person");
    }
  });

  it("names the digests it holds and never reads one", async () => {
    const resolved = await resolveSubjectData(database.pool, admin, { organisationId: ORG, subjectId: SUBJECT }, { decrypt: true, keys });
    assert.deepEqual(resolved.linkage, [{ sourceTable: "client_contacts", sourceId: "contact-1", field: "email" }]);

    // The confinement, from the other direction: the whole answer carries no digest, and the value that
    // is actually stored appears nowhere in it.
    const stored = await db.query<{ linkage_bidx: string }>(
      `SELECT linkage_bidx FROM nzi_console.data_subject_linkage WHERE source_id='contact-1'`);
    assert.ok(stored.rows[0]!.linkage_bidx, "a digest is stored");
    assert.ok(!JSON.stringify(resolved).includes(stored.rows[0]!.linkage_bidx),
      "and resolution does not carry it");
  });

  it("refuses a principal without the capability", async () => {
    const consultant = { ...admin, role: "consultant", capabilities: [] } as unknown as StaffPrincipal;
    // Asserted on the error's own field rather than its wording, which is how the rest of this repo
    // checks authorisation: a message can be reworded, and the capability it refused cannot.
    await assert.rejects(
      () => resolveSubjectData(database.pool, consultant, { organisationId: ORG, subjectId: SUBJECT }, { decrypt: true, keys }),
      (error) => error instanceof AuthorizationError && error.permission === "subject.review");
  });

  it("records the act with counts and none of the data", async () => {
    const ref = `dsar-${randomUUID()}`;
    await resolveSubjectData(database.pool, admin, { organisationId: ORG, subjectId: SUBJECT, requestRef: ref }, { decrypt: true, keys });
    const { rows } = await db.query<{ after_json: Record<string, unknown> }>(
      `SELECT after_json FROM nzi_console.audit_events WHERE action='subject.resolve' AND correlation_id=$1`, [ref]);
    assert.equal(rows.length, 1);
    const serialised = JSON.stringify(rows[0]!.after_json);
    assert.ok(Number(rows[0]!.after_json.rows) > 0, "it counts what it reached");
    for (const value of ["Ada Lovelace", "ada@example.test", "900123"]) {
      assert.ok(!serialised.includes(value), `the audit of a subject access must not restate ${value}`);
    }
  });

  it("says nothing about other organisations, because it cannot", async () => {
    const resolved = await resolveSubjectData(database.pool, admin, { organisationId: ORG, subjectId: SUBJECT }, { decrypt: true, keys });
    assert.equal(resolved.crossTenant, "not-answerable-here");
  });
});
