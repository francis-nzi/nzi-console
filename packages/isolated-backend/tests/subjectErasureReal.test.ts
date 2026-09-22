import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { resolveSubjectData } from "../src/subjectResolution";
import { sealRowPii, sealValuesForSubject, type SealingKeys } from "../src/piiSealing";
import { PII_COLUMNS, PII_TABLES } from "../src/piiInventory";
import { blindIndex, linkageDigest, normaliseEmailAtRest } from "../src/subjectCrypto";
import { AuthorizationError, type StaffPrincipal } from "../src/auth";
import { exportSubjectData, readSubjectExport } from "../src/subjectExport";
import {
  eraseSubjectData, ErasureIncompleteError, outstandingByPrerequisite, partiallyErasedSubjects,
  planErasure, readErasureRecord,
} from "../src/subjectErasure";

/**
 * Erasure against real Postgres (NZC-136, NZC-137).
 *
 * The command is irreversible, so the test that matters is not "did it run" but **"is the person gone
 * from every path that could produce them"**. That means all of these, against the inventory rather than
 * against a list somebody typed:
 *
 *   * decrypting — the key is destroyed;
 *   * the plaintext kept beside each ciphertext — nulled, because a shred does not reach it;
 *   * the blind index — nulled, so a **correct guess** at the address matches nothing. This is the one
 *     that separates erasure from deletion: if the index survives, anybody who can guess the value can
 *     still confirm the person was here;
 *   * the linkage digest — the same, across tables;
 *   * the history — sealed under the live record's key, so one shred covers it;
 *   * the export path — run it afterwards and no cleartext comes back.
 *
 * Two subjects, on purpose. One has data everywhere, including the two things this system cannot yet
 * erase, and must come out **partial**. The other has only what can be erased, and must come out
 * **complete** — without which "partial" could be what the code always returns and every assertion above
 * would still pass.
 */

const DATABASE_URL = TEST_DATABASE_URL;
const ORG = "org-erase";
const FULL = "aaaaaaaa-1111-2222-3333-444444444444";
const SIMPLE = "bbbbbbbb-5555-6666-7777-888888888888";

const principal = (...held: string[]) => ({
  userId: "dpo-a", organisationId: ORG, role: "admin",
  capabilities: held.map((capability) => ({ capability, scope: "all" })),
} as unknown as StaffPrincipal);

const admin = principal("subject.review", "subject.export", "subject.erase");

const ADA = { fullName: "Ada Lovelace", jobTitle: "Director", email: "ada@example.test", phone: "07700 900123" };
const GRACE = { displayName: "Grace Hopper", email: "grace@example.test" };

describe("erasure: the right to be forgotten (NZC-136)", { skip: DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;
  const keys: SealingKeys = {
    masterKey: randomBytes(32).toString("base64"),
    indexKey: randomBytes(32).toString("base64"),
    linkageKey: randomBytes(32).toString("base64"),
  };

  before(async () => {
    database = (await createDisposableDatabase("subjecterase"))!;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,'Erase')`, [ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
    await db.query(`INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,'client-1','Acme','active')`, [ORG]);

    // ── Ada: data across every reach, including the two that cannot yet be finished ────
    await db.query(
      `INSERT INTO nzi_console.client_contacts (organisation_id,contact_id,client_id,full_name,job_title,email,phone,created_by,updated_by)
       VALUES ($1,'contact-1','client-1',$2,$3,$4,$5,'seed','seed')`,
      [ORG, ADA.fullName, ADA.jobTitle, ADA.email, ADA.phone]);
    const snapshot = JSON.stringify({ fullName: ADA.fullName, email: ADA.email });
    await db.query(
      `INSERT INTO nzi_console.memberships (organisation_id,user_id,role_id,status,display_name,email)
       VALUES ($1,'user-1','consultant','active',$2,$3)`, [ORG, ADA.fullName, ADA.email]);
    await db.query(`UPDATE nzi_console.clients SET owner_user_id='user-1', owner_name=$1 WHERE client_id='client-1'`, [ADA.fullName]);

    await db.query(
      `INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage)
       VALUES ($1,'job-1','client-1',1,'crp','CRP','open','setup')`, [ORG]);
    const hash = `sha256:${"a".repeat(64)}`;
    await db.query(
      `INSERT INTO nzi_console.reviewed_crp_snapshots
         (organisation_id,snapshot_id,job_id,snapshot_version,job_version,data_hash,payload_json,created_by)
       VALUES ($1,'snap-1','job-1',1,1,$2,'{}'::jsonb,'seed')`, [ORG, hash]);
    await db.query(
      `INSERT INTO nzi_console.report_versions
         (organisation_id,report_version_id,job_id,status,manifest_version,reviewed_snapshot_id,data_hash,
          signee_contact_id,signee_name,signee_job_title)
       VALUES ($1,'rv-1','job-1','validated',1,'snap-1',$2,'contact-1',$3,$4)`, [ORG, hash, ADA.fullName, ADA.jobTitle]);
    await db.query(
      `INSERT INTO nzi_console.portal_users (organisation_id,portal_user_id,client_id,email_normalized,display_name,status)
       VALUES ($1,'portal-1','client-1',$2,$3,'active')`, [ORG, ADA.email, ADA.fullName]);
    await db.query(
      `INSERT INTO nzi_console.portal_report_comments
         (organisation_id,comment_id,report_version_id,job_id,client_id,author_principal,author_id,author_display_name,body)
       VALUES ($1,'comment-1','rv-1','job-1','client-1','portal','portal-1',$2,'Looks right to me.')`, [ORG, ADA.fullName]);

    await db.query(`INSERT INTO nzi_console.data_subjects (organisation_id,subject_id,created_by) VALUES ($1,$2,'seed')`, [ORG, FULL]);
    for (const [table, id] of [["client_contacts", "contact-1"], ["memberships", "user-1"], ["portal_users", "portal-1"]] as const) {
      await db.query(
        `INSERT INTO nzi_console.data_subject_links (organisation_id,subject_id,source_table,source_id,link_method,linked_by)
         VALUES ($1,$2,$3,$4,'deterministic-email','seed')`, [ORG, FULL, table, id]);
    }
    await sealRowPii(db, {
      organisationId: ORG,
      subject: { sourceTable: "client_contacts", sourceId: "contact-1" },
      table: "client_contacts",
      keyColumns: { organisation_id: ORG, contact_id: "contact-1" },
      sealed: { full_name_sealed: ADA.fullName, job_title_sealed: ADA.jobTitle, phone_sealed: ADA.phone },
      operational: [{ column: "client_contacts.email", sealedColumn: "email_sealed", indexColumn: "email_bidx", field: "email", value: ADA.email }],
    }, keys, "seed");

    // The history, sealed the way the write path seals it: the snapshot's ciphertext goes in with the
    // row, because the table is append-only (NZC-120). After the links exist, because sealing resolves
    // the subject and would otherwise mint a second one for the same person.
    const sealedSnapshot = await sealValuesForSubject(db, {
      organisationId: ORG,
      subject: { sourceTable: "client_contacts", sourceId: "contact-1" },
      values: { snapshot_sealed: snapshot },
    }, keys, "seed");
    await db.query(
      `INSERT INTO nzi_console.client_contact_versions (organisation_id,contact_id,version,snapshot_json,snapshot_sealed,changed_by,correlation_id)
       VALUES ($1,'contact-1',1,$2::jsonb,$3::jsonb,'seed','corr-1')`,
      [ORG, snapshot, sealedSnapshot.snapshot_sealed]);

    // ── Grace: a portal account and nothing else, so nothing blocks her erasure ────────
    await db.query(
      `INSERT INTO nzi_console.portal_users (organisation_id,portal_user_id,client_id,email_normalized,display_name,status)
       VALUES ($1,'portal-2','client-1',$2,$3,'active')`, [ORG, GRACE.email, GRACE.displayName]);
    await db.query(`INSERT INTO nzi_console.data_subjects (organisation_id,subject_id,created_by) VALUES ($1,$2,'seed')`, [ORG, SIMPLE]);
    await db.query(
      `INSERT INTO nzi_console.data_subject_links (organisation_id,subject_id,source_table,source_id,link_method,linked_by)
       VALUES ($1,$2,'portal_users','portal-2','deterministic-email','seed')`, [ORG, SIMPLE]);
    await sealRowPii(db, {
      organisationId: ORG,
      subject: { sourceTable: "portal_users", sourceId: "portal-2" },
      table: "portal_users",
      keyColumns: { organisation_id: ORG, portal_user_id: "portal-2" },
      sealed: { display_name_sealed: GRACE.displayName },
      operational: [{ column: "portal_users.email_normalized", sealedColumn: "email_sealed", indexColumn: "email_bidx", field: "email", value: GRACE.email }],
    }, keys, "seed");
  });

  after(async () => { await db?.end(); await database?.end(); });

  // ── What the inventory says is outstanding, before anything runs ────────────────────

  it("names exactly what it cannot yet finish, and what each waits on", () => {
    // Derived from the inventory rather than listed here, so a column that becomes erasable leaves this
    // set on its own and a new unerasable one joins it without anybody remembering to update a test.
    const outstanding = outstandingByPrerequisite();

    assert.deepEqual([...outstanding.get("auth-bridge")!].sort(), [
      "staff_credentials.email_normalized",
      "trainee_email_changes.current_email",
      "trainee_email_changes.new_email",
      "trainees.current_employer_name",
      "trainees.full_name",
      "trainees.personal_email",
      "trainees.phone",
    ], "seven columns, not one: the bridge blocks every column it seals, not only the staff login");

    assert.deepEqual([...outstanding.get("plaintext-drop")!].sort(), [
      "client_contact_versions.snapshot_json",
      "portal_report_comments.author_display_name",
    ], "both append-only tables, where no runtime role can null the plaintext beside the ciphertext");

    // Of the append-only tables, these two are the ones where it actually blocks an erasure: the rest
    // either hold nothing attributable or are retained on their own basis anyway.
    const declared = Object.entries(PII_TABLES).filter(([, definition]) => definition.appendOnly).map(([table]) => table).sort();
    for (const table of ["client_contact_versions", "portal_report_comments"]) {
      assert.ok(declared.includes(table), `${table} must be declared append-only`);
    }
  });

  it("checks its append-only claim against the real grants", async () => {
    // The plan says a column is pending because no runtime role may update its table. If that were
    // merely asserted in TypeScript it could drift, and the drift would read as "erased" for a column
    // erasure never touched — the worst direction for this particular mistake.
    const { rows } = await db.query<{ table_name: string; grantee: string }>(
      `SELECT table_name, grantee FROM information_schema.table_privileges
        WHERE table_schema='nzi_console' AND privilege_type='UPDATE'
          AND grantee IN ('nzi_console_app','nzi_console_worker','nzi_console_auth')`);
    const updatable = new Set(rows.map((row) => row.table_name));

    for (const [table, definition] of Object.entries(PII_TABLES)) {
      if (definition.appendOnly) {
        assert.ok(!updatable.has(table), `${table} is declared append-only but a runtime role may UPDATE it`);
      } else if (PII_COLUMNS.some((column) => column.table === table)) {
        assert.ok(updatable.has(table), `${table} is not declared append-only but no runtime role may UPDATE it`);
      }
    }
  });

  // ── Capability ──────────────────────────────────────────────────────────────────────

  it("requires subject.erase, which neither of the others confers", async () => {
    for (const held of [["subject.review"], ["subject.export"], ["subject.review", "subject.export"], []]) {
      await assert.rejects(
        () => eraseSubjectData(database.pool, principal(...held), { organisationId: ORG, subjectId: SIMPLE, keys }),
        (error: unknown) => error instanceof AuthorizationError && error.permission === "subject.erase",
        `holding ${held.join("+") || "nothing"} must not be a way to erase somebody`);
    }
  });

  it("lets the erase capability alone reach the read path it depends on", async () => {
    // The gate used to be inferred from whether the caller was decrypting, so erasure — which does not —
    // would have been gated on subject.review and refused for an eraser holding exactly subject.erase.
    const reached = await resolveSubjectData(
      database.pool, principal("subject.erase"), { organisationId: ORG, subjectId: FULL },
      { decrypt: false, purpose: "erase" });
    assert.ok(reached.rows.length > 0);

    // And naming a purpose is not a way around the decryption gate.
    await assert.rejects(
      () => resolveSubjectData(database.pool, principal("subject.erase"), { organisationId: ORG, subjectId: FULL },
        { decrypt: true, purpose: "erase", keys }),
      (error: unknown) => error instanceof AuthorizationError && error.permission === "subject.export");
  });

  // ── The plan refuses rather than half-erasing ───────────────────────────────────────

  it("refuses to erase anybody while a column has no treatment", async () => {
    // The anti-vacuity guard, at the command. A column added to the inventory and not to the planner is
    // exactly how a half-erasure would ship, and a half-erasure that reports success is worse than a
    // refusal because nothing afterwards can say which half happened.
    // On a table the inventory knows *and this person has a row in*, so what this proves is that an
    // unrecognised treatment refuses. The column is a real one, because a name no table has fails the read
    // long before it reaches the planner — a different gap with a different answer. On a table the person
    // has nothing in, "nothing held" would be the honest
    // answer and no refusal would be due — which is correct, and would have made this test prove nothing.
    const phantom = {
      table: "portal_users", column: "status", label: "Something nobody planned for",
      storage: { kind: "plaintext" }, stage: "deferred", erasure: "no-such-treatment",
    } as unknown as (typeof PII_COLUMNS)[number];

    const before = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM nzi_console.subject_erasures`);

    (PII_COLUMNS as unknown as Array<typeof phantom>).push(phantom);
    try {
      // The planner has no case for this treatment, so it must not decide for itself what to do with
      // somebody's data — and it must refuse before destroying any of the rest of it.
      await assert.rejects(
        () => eraseSubjectData(database.pool, admin, { organisationId: ORG, subjectId: SIMPLE, keys }),
        ErasureIncompleteError,
        "a column with no treatment must stop the erasure, not be guessed at");
    } finally {
      (PII_COLUMNS as unknown as Array<typeof phantom>).pop();
    }

    // Nothing was erased along the way.
    assert.equal(
      (await db.query<{ count: string }>(`SELECT count(*)::text AS count FROM nzi_console.subject_erasures`)).rows[0]!.count,
      before.rows[0]!.count);
  });

  // ── Grace: a complete erasure, which is what proves "partial" is not the only answer ─

  it("completes an erasure when nothing blocks it", async () => {
    const manifest = await eraseSubjectData(database.pool, admin, {
      organisationId: ORG, subjectId: SIMPLE, requestRef: "RTBF-2026-0002", keys,
    });

    assert.equal(manifest.status, "complete", "a person with only erasable data is erased, not partial");
    assert.deepEqual(manifest.pendingOn, []);
    assert.equal(manifest.counts.pending, 0);
    assert.ok(manifest.counts.erased > 0, "and something was actually destroyed");
    assert.deepEqual(manifest.completeness.unaccountedFor, []);
    assert.equal(manifest.completeness.accountedFor, PII_COLUMNS.length);

    const { rows } = await db.query<{ status: string }>(
      `SELECT status FROM nzi_console.data_subjects WHERE subject_id=$1`, [SIMPLE]);
    assert.equal(rows[0]!.status, "erased");
  });

  it("leaves nothing of the completely erased person on any path", async () => {
    // Every path, against the row itself rather than against the manifest — a manifest is a claim, and
    // this is the check on it.
    const { rows } = await db.query<{
      email_normalized: string | null; display_name: string | null;
      email_bidx: string | null; email_sealed: unknown; display_name_sealed: unknown;
    }>(`SELECT email_normalized, display_name, email_bidx, email_sealed, display_name_sealed
          FROM nzi_console.portal_users WHERE portal_user_id='portal-2'`);
    const row = rows[0]!;

    assert.equal(row.email_normalized, null, "the plaintext address is gone");
    assert.equal(row.display_name, null, "and the plaintext name");
    assert.equal(row.email_bidx, null, "and the blind index, or a guess would still match");
    // The ciphertext deliberately stays: it is unreadable, and removing it would take the row with it.
    assert.ok(row.email_sealed, "the ciphertext stays where it is");
    assert.ok(row.display_name_sealed);

    // The key is destroyed, which is what makes that ciphertext meaningless.
    const key = await db.query<{ wrapped_key: unknown; shredded_at: Date | null }>(
      `SELECT wrapped_key, shredded_at FROM nzi_console.data_subject_keys WHERE subject_id=$1`, [SIMPLE]);
    assert.equal(key.rows[0]!.wrapped_key, null);
    assert.ok(key.rows[0]!.shredded_at, "and when");
  });

  it("does not match a correct guess at the erased address", async () => {
    // The assertion that separates erasure from deletion. Somebody who knows the address can compute the
    // same digests we did; if either survived the erasure, they could confirm this person was here —
    // which is the fact the erasure was supposed to remove.
    const guessIndex = blindIndex("portal_users.email_normalized", GRACE.email, keys.indexKey);
    const guessDigest = linkageDigest(normaliseEmailAtRest(GRACE.email), keys.linkageKey);
    assert.ok(guessIndex && guessDigest, "the guess computes to something, or this test proves nothing");

    const byIndex = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM nzi_console.portal_users WHERE organisation_id=$1 AND email_bidx=$2`,
      [ORG, guessIndex]);
    assert.equal(Number(byIndex.rows[0]!.count), 0, "a correct guess still matches the blind index");

    const byDigest = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM nzi_console.data_subject_linkage
        WHERE organisation_id=$1 AND linkage_bidx=$2`, [ORG, guessDigest]);
    assert.equal(Number(byDigest.rows[0]!.count), 0, "a correct guess still matches the linkage digest");

    // The digest rows are still there, holding nothing — deactivate, not delete.
    const remaining = await db.query<{ count: string; nulled: string }>(
      `SELECT count(*)::text AS count, count(*) FILTER (WHERE linkage_bidx IS NULL)::text AS nulled
         FROM nzi_console.data_subject_linkage WHERE organisation_id=$1 AND source_id='portal-2'`, [ORG]);
    assert.ok(Number(remaining.rows[0]!.count) > 0, "the linkage rows survive");
    assert.equal(remaining.rows[0]!.nulled, remaining.rows[0]!.count, "and every one of them is empty");
  });

  it("gives the export nothing to export afterwards", async () => {
    // The two commands share a traversal, so this is the end-to-end statement of the whole workstream:
    // what the export would have handed over is what the erasure destroyed.
    const { exportId } = await exportSubjectData(database.pool, admin, {
      organisationId: ORG, subjectId: SIMPLE, recipient: { principal: "portal", id: "portal-2" },
      requestRef: "SAR-after-erasure", keys,
    });
    const { document } = await readSubjectExport(database.pool, { principal: "portal", id: "portal-2" },
      { organisationId: ORG, exportId, keys });

    for (const record of document.records) {
      for (const datum of record.data) {
        assert.ok(datum.value == null || datum.value === "",
          `${datum.provenance.table}.${datum.provenance.column} still reads back as "${datum.value}" after erasure`);
      }
    }
    // And it says why, rather than looking like a person with no data.
    const withheld = document.records.flatMap((record) => record.data).filter((datum) => datum.withheld);
    assert.ok(withheld.some((datum) => /key has been destroyed|nothing stored/.test(datum.withheld!)),
      "the export explains that the data is unreadable rather than absent");
  });

  // ── Ada: the honest partial ─────────────────────────────────────────────────────────

  it("reports partial, never erased, while a column of theirs remains", async () => {
    const manifest = await eraseSubjectData(database.pool, admin, {
      organisationId: ORG, subjectId: FULL, requestRef: "RTBF-2026-0001", keys,
    });

    assert.equal(manifest.status, "partial", "a person with data this system cannot reach is not erased");
    assert.deepEqual([...manifest.pendingOn].sort(), ["auth-bridge", "plaintext-drop"]);

    const pending = manifest.entries.filter((entry) => entry.outcome === "pending");
    assert.deepEqual(pending.map((entry) => `${entry.table}.${entry.column}`).sort(), [
      "client_contact_versions.snapshot_json",
      "portal_report_comments.author_display_name",
      "staff_credentials.email_normalized",
    ], "named individually, never rolled into a total");
    for (const entry of pending) {
      assert.ok(entry.pendingOn, `${entry.column} is pending on nothing in particular`);
      assert.ok(entry.because.length > 20, "and says why in a sentence somebody can act on");
    }

    const { rows } = await db.query<{ status: string }>(
      `SELECT status FROM nzi_console.data_subjects WHERE subject_id=$1`, [FULL]);
    assert.equal(rows[0]!.status, "erasure-partial", "the subject's own status says so too");
  });

  it("erases everything it can in the same pass, rather than stopping at the first thing it cannot", async () => {
    // Run-and-report-partial: the maximum shred now, the residual named. Stopping would leave the person
    // wholly un-erased because of one column.
    const contact = await db.query<{ full_name: string | null; email: string | null; phone: string | null; email_bidx: string | null; full_name_sealed: unknown }>(
      `SELECT full_name, email, phone, email_bidx, full_name_sealed FROM nzi_console.client_contacts WHERE contact_id='contact-1'`);
    assert.equal(contact.rows[0]!.full_name, null);
    assert.equal(contact.rows[0]!.email, null);
    assert.equal(contact.rows[0]!.phone, null);
    assert.equal(contact.rows[0]!.email_bidx, null);
    assert.ok(contact.rows[0]!.full_name_sealed, "the unreadable ciphertext stays");

    // The associations keep their shape and lose the name (NZC-127).
    const client = await db.query<{ owner_user_id: string | null; owner_name: string | null }>(
      `SELECT owner_user_id, owner_name FROM nzi_console.clients WHERE client_id='client-1'`);
    assert.equal(client.rows[0]!.owner_name, null, "the client no longer says who owns it");
    assert.equal(client.rows[0]!.owner_user_id, "user-1", "and still says that somebody does");

    const report = await db.query<{ signee_name: string | null; signee_contact_id: string | null }>(
      `SELECT signee_name, signee_contact_id FROM nzi_console.report_versions WHERE report_version_id='rv-1'`);
    assert.equal(report.rows[0]!.signee_name, null);
    assert.equal(report.rows[0]!.signee_contact_id, "contact-1", "the signature still points somewhere");
  });

  it("leaves the history unreadable, and says the plaintext is still there", async () => {
    // Both halves of NZC-120 under erasure: the sealed snapshot is shredded with the live record's key,
    // and the plaintext beside it cannot be nulled on an append-only table — so it is reported, not
    // counted.
    const { rows } = await db.query<{ snapshot_json: unknown; snapshot_sealed: unknown }>(
      `SELECT snapshot_json, snapshot_sealed FROM nzi_console.client_contact_versions WHERE contact_id='contact-1'`);
    assert.ok(rows[0]!.snapshot_sealed, "the ciphertext is present and now unreadable");
    assert.ok(rows[0]!.snapshot_json, "and the plaintext is, honestly, still readable");

    const manifest = (await readErasureRecord(database.pool, { organisationId: ORG, subjectId: FULL }))!;
    const entry = manifest.entries.find((candidate) => candidate.column === "snapshot_json")!;
    assert.equal(entry.outcome, "pending");
    assert.equal(entry.pendingOn, "plaintext-drop");
  });

  it("keeps the record of the erasure, which is the only thing that can evidence it", async () => {
    const { rows } = await db.query<{
      status: string; pending_on: string[]; erased_count: number; pending_count: number;
      manifest: { entries: Array<{ because: string }> }; completed_at: Date | null;
    }>(`SELECT status, pending_on, erased_count, pending_count, manifest, completed_at
          FROM nzi_console.subject_erasures WHERE subject_id=$1`, [FULL]);
    const row = rows[0]!;
    assert.equal(row.status, "partial");
    assert.equal(row.completed_at, null, "not complete, so not dated complete");
    assert.deepEqual([...row.pending_on].sort(), ["auth-bridge", "plaintext-drop"]);
    assert.ok(row.erased_count > 0 && row.pending_count === 3);

    // No value anywhere in it. An erasure manifest quoting what it erased would be the one copy that
    // survived the erasure.
    const serialised = JSON.stringify(row.manifest);
    for (const secret of [...Object.values(ADA), ...Object.values(GRACE)]) {
      assert.ok(!serialised.includes(secret), `the manifest still contains ${secret}`);
    }

    const audit = await db.query<{ after_json: Record<string, unknown> }>(
      `SELECT after_json FROM nzi_console.audit_events WHERE action='subject.erase' AND correlation_id='RTBF-2026-0001'`);
    assert.equal(audit.rows[0]!.after_json.status, "partial");
    for (const secret of Object.values(ADA)) {
      assert.ok(!JSON.stringify(audit.rows[0]!.after_json).includes(secret), "nor does the audit");
    }
  });

  it("lists the partial subjects, so the residual cannot be forgotten", async () => {
    const partial = await partiallyErasedSubjects(database.pool, { organisationId: ORG });
    assert.deepEqual(partial.map((entry) => entry.subjectId), [FULL],
      "the one who is not finished, and not the one who is");
    assert.deepEqual([...partial[0]!.pendingOn].sort(), ["auth-bridge", "plaintext-drop"]);
  });

  it("is idempotent, and a re-run is how a partial is finished later", async () => {
    const first = (await readErasureRecord(database.pool, { organisationId: ORG, subjectId: FULL }))!;
    const again = await eraseSubjectData(database.pool, admin, {
      organisationId: ORG, subjectId: FULL, requestRef: "RTBF-2026-0001", keys,
    });

    // Same answer, no second key to shred, nothing new destroyed — the second run is the mechanism that
    // promotes partial to complete once a prerequisite lands, so it has to be safe to run at any time.
    assert.equal(again.status, first.status);
    assert.deepEqual(again.counts, first.counts);
    assert.deepEqual([...again.pendingOn], [...first.pendingOn]);

    const rows = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM nzi_console.subject_erasures WHERE subject_id=$1`, [FULL]);
    assert.equal(rows.rows[0]!.count, "1", "one record per subject, updated rather than appended to");
  });

  it("keeps the person's skeleton, so nothing that pointed at them dangles", async () => {
    // Deactivate, not delete. Every row is still there and every foreign key still resolves; what they
    // no longer contain is a person.
    for (const [table, column, id] of [
      ["client_contacts", "contact_id", "contact-1"],
      ["client_contact_versions", "contact_id", "contact-1"],
      ["memberships", "user_id", "user-1"],
      ["portal_users", "portal_user_id", "portal-1"],
      ["portal_report_comments", "comment_id", "comment-1"],
      ["report_versions", "report_version_id", "rv-1"],
    ] as const) {
      const { rows } = await db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM nzi_console.${table} WHERE ${column}=$1`, [id]);
      assert.equal(rows[0]!.count, "1", `${table} lost a row to an erasure that should not delete any`);
    }

    // And the subject itself remains, as a tombstone with a status and no personal data.
    const { rows } = await db.query<{ status: string; subject_id: string }>(
      `SELECT status, subject_id FROM nzi_console.data_subjects WHERE subject_id=$1`, [FULL]);
    assert.equal(rows[0]!.subject_id, FULL, "the identifier survives, so a later request can be answered");
    assert.equal(rows[0]!.status, "erasure-partial");
  });
});
