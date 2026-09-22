import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import { resolveSubjectData } from "../src/subjectResolution";
import { sealRowPii, type SealingKeys } from "../src/piiSealing";
import { PII_COLUMNS } from "../src/piiInventory";
import { AuthorizationError, type StaffPrincipal } from "../src/auth";
import {
  assertExportComplete, buildExportDocument, completeSubjectExportDownload, EXPORT_TTL_SECONDS, expireSubjectExports,
  exportSubjectData, ExportIncompleteError, ExportUnavailableError, readSubjectExport,
  renderExportDocument, type SubjectExportDocument,
} from "../src/subjectExport";

/**
 * The subject access response, against real Postgres (NZC-134, NZC-135).
 *
 * Two claims are worth proving here and the rest is detail:
 *
 *   1. **Every field is accounted for.** Not "the export looked right" — every one of the inventory's
 *      columns appears either as a value or as a named reason it does not, and the check that says so can
 *      fail. A completeness assertion that cannot fail is the same thing as no completeness assertion.
 *
 *   2. **The window closes.** The artifact becomes unreadable on a completed download or at expiry,
 *      whichever comes first, and *not* on a dropped connection — because a burned artifact forces a
 *      re-request, and a re-request mints a second copy of the same personal data.
 *
 * One key source, as everywhere in this workstream: what the test seals is what the export opens.
 */

const DATABASE_URL = TEST_DATABASE_URL;
const ORG = "org-exp";
const SUBJECT = "66666666-7777-8888-9999-000000000000";
const RECIPIENT = { principal: "portal" as const, id: "portal-1" };

const principal = (...held: string[]) => ({
  userId: "dpo-a", organisationId: ORG, role: "admin",
  capabilities: held.map((capability) => ({ capability, scope: "all" })),
} as unknown as StaffPrincipal);

const admin = principal("subject.review", "subject.export", "subject.erase");

/** The values the fixture writes, so the export can be checked against them rather than against itself. */
const WRITTEN = {
  fullName: "Ada Lovelace",
  jobTitle: "Director",
  email: "ada@example.test",
  phone: "07700 900123",
};

describe("the subject access response (NZC-134)", { skip: DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;
  const keys: SealingKeys = {
    masterKey: randomBytes(32).toString("base64"),
    indexKey: randomBytes(32).toString("base64"),
    linkageKey: randomBytes(32).toString("base64"),
  };

  before(async () => {
    database = (await createDisposableDatabase("subjectexp"))!;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,'Exp')`, [ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
    await db.query(`INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,'client-1','Acme','active')`, [ORG]);

    // One person across every reach the traversal has: their own record, the history of it, and three
    // rows about something else that name them. A fixture missing a reach would let an export omit that
    // whole class of data and still pass.
    await db.query(
      `INSERT INTO nzi_console.client_contacts (organisation_id,contact_id,client_id,full_name,job_title,email,phone,created_by,updated_by)
       VALUES ($1,'contact-1','client-1',$2,$3,$4,$5,'seed','seed')`,
      [ORG, WRITTEN.fullName, WRITTEN.jobTitle, WRITTEN.email, WRITTEN.phone]);
    await db.query(
      `INSERT INTO nzi_console.client_contact_versions (organisation_id,contact_id,version,snapshot_json,changed_by,correlation_id)
       VALUES ($1,'contact-1',1,$2::jsonb,'seed','corr-1')`,
      [ORG, JSON.stringify({ fullName: "Ada Byron", email: WRITTEN.email })]);

    await db.query(`INSERT INTO nzi_console.data_subjects (organisation_id,subject_id,created_by) VALUES ($1,$2,'seed')`, [ORG, SUBJECT]);

    await db.query(
      `INSERT INTO nzi_console.memberships (organisation_id,user_id,role_id,status,display_name,email)
       VALUES ($1,'user-1','consultant','active',$2,$3)`, [ORG, WRITTEN.fullName, WRITTEN.email]);
    await db.query(
      `UPDATE nzi_console.clients SET owner_user_id='user-1', owner_name=$1 WHERE client_id='client-1'`, [WRITTEN.fullName]);

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
       VALUES ($1,'rv-1','job-1','validated',1,'snap-1',$2,'contact-1',$3,$4)`,
      [ORG, hash, WRITTEN.fullName, WRITTEN.jobTitle]);

    await db.query(
      `INSERT INTO nzi_console.portal_users (organisation_id,portal_user_id,client_id,email_normalized,display_name,status)
       VALUES ($1,'portal-1','client-1',$2,$3,'active')`, [ORG, WRITTEN.email, WRITTEN.fullName]);
    await db.query(
      `INSERT INTO nzi_console.portal_report_comments
         (organisation_id,comment_id,report_version_id,job_id,client_id,author_principal,author_id,author_display_name,body)
       VALUES ($1,'comment-1','rv-1','job-1','client-1','portal','portal-1',$2,'Looks right to me.')`, [ORG, WRITTEN.fullName]);

    for (const [table, id] of [["client_contacts", "contact-1"], ["memberships", "user-1"], ["portal_users", "portal-1"]] as const) {
      await db.query(
        `INSERT INTO nzi_console.data_subject_links (organisation_id,subject_id,source_table,source_id,link_method,linked_by)
         VALUES ($1,$2,$3,$4,'deterministic-email','seed')`, [ORG, SUBJECT, table, id]);
    }

    // Sealed through the one sealing path, so the export decrypts what the application actually writes.
    await sealRowPii(db, {
      organisationId: ORG,
      subject: { sourceTable: "client_contacts", sourceId: "contact-1" },
      table: "client_contacts",
      keyColumns: { organisation_id: ORG, contact_id: "contact-1" },
      sealed: { full_name_sealed: WRITTEN.fullName, job_title_sealed: WRITTEN.jobTitle, phone_sealed: WRITTEN.phone },
      operational: [{ column: "client_contacts.email", sealedColumn: "email_sealed", indexColumn: "email_bidx", field: "email", value: WRITTEN.email }],
    }, keys, "seed");
  });

  after(async () => { await db?.end(); await database?.end(); });

  const produce = (options: { requestRef?: string; ttlSeconds?: number } = {}) =>
    exportSubjectData(database.pool, admin, {
      organisationId: ORG, subjectId: SUBJECT, recipient: RECIPIENT,
      requestRef: options.requestRef ?? "SAR-2026-0001", ttlSeconds: options.ttlSeconds, keys,
    });

  const fetch = (exportId: string, now?: Date) =>
    readSubjectExport(database.pool, RECIPIENT, { organisationId: ORG, exportId, now, keys });

  // ── What the person actually receives ────────────────────────────────────────────────

  it("hands back the values that were written, decrypted, with where each came from", async () => {
    const { exportId } = await produce();
    const { document } = await fetch(exportId);

    const contact = document.records.find((record) => record.source === "client_contacts")!;
    assert.ok(contact, "their own contact record is in the response");
    assert.equal(contact.reach, "person-row");
    assert.equal(contact.describedAs, "a record about you");

    // Sealed when written, so a match here is the whole round trip: seal, store, resolve, decrypt,
    // render. Checked against the fixture's own constants rather than against the export's other half.
    const value = (column: string) => contact.data.find((datum) => datum.provenance.column === column)?.value;
    assert.equal(value("full_name"), WRITTEN.fullName);
    assert.equal(value("job_title"), WRITTEN.jobTitle);
    assert.equal(value("email"), WRITTEN.email);
    assert.equal(value("phone"), WRITTEN.phone);

    // Provenance and a plain-English label on every datum, because "which field is this and where does
    // it live" is the question a person asks about one line of an export.
    for (const datum of contact.data) {
      assert.ok(datum.label.trim(), `${datum.provenance.column} has no label`);
      assert.equal(datum.provenance.table, "client_contacts");
      assert.notEqual(datum.label, datum.provenance.column, "the label is for a person, not the column name");
    }
  });

  it("includes the history of a record and the things the person is named on", async () => {
    const { exportId } = await produce();
    const { document } = await fetch(exportId);

    const byReach = (reach: string) => document.records.filter((record) => record.reach === reach).map((record) => record.source).sort();
    assert.deepEqual(byReach("history-of"), ["client_contact_versions"], "an earlier version of their record");
    assert.deepEqual(byReach("pointer"), ["clients", "portal_report_comments", "report_versions"],
      "the client they own, the report they signed, the comment they wrote");

    // The history carries the *earlier* value, which is the point of including it: an export showing
    // only the present would not be a record of what was held about them.
    const history = document.records.find((record) => record.source === "client_contact_versions")!;
    const snapshot = history.data.find((datum) => datum.provenance.column === "snapshot_json")!;
    assert.match(String(snapshot.value), /Ada Byron/, "the previous name is in the response, not just the current one");

    const comment = document.records.find((record) => record.source === "portal_report_comments")!;
    assert.equal(comment.data.find((datum) => datum.provenance.column === "author_display_name")!.value, WRITTEN.fullName);
  });

  it("names what it holds back, and why, in every category", async () => {
    const { exportId } = await produce();
    const { document } = await fetch(exportId);

    const kinds = new Set(document.heldButNotShown.map((entry) => entry.kind));
    assert.ok(kinds.has("not-attributable-to-you"), "data no path ties to a person is still declared");
    assert.ok(kinds.has("held-not-readable-here"), "a row this path is refused is declared, not dropped");
    assert.ok(kinds.has("never-read-back"), "the matching digest is named");
    assert.ok(kinds.has("no-record-of-this-kind"), "and so is a record they simply do not have");

    // Every one carries a reason. A withheld field without a reason is the thing this section exists to
    // make impossible.
    for (const entry of document.heldButNotShown) {
      assert.ok(entry.because.trim().length > 10, `${entry.provenance.table}.${entry.provenance.column} is withheld without a reason`);
      assert.ok(entry.label.trim(), "and it is named in words a person can read");
    }

    // The specific case that found this whole treatment: staff_credentials is granted to the
    // authentication role alone, so it is reported as held-and-unreadable rather than omitted.
    const credentials = document.heldButNotShown.filter((entry) => entry.provenance.table === "staff_credentials");
    assert.ok(credentials.length > 0, "the staff sign-in address is declared");
    assert.match(credentials[0]!.because, /cannot read/);

    // And the digest is named without its value anywhere in the artifact.
    assert.ok(document.matchingDigests.length > 0, "the person holds indexed addresses, so digests exist");
    for (const digest of document.matchingDigests) {
      assert.ok(digest.field.trim());
      assert.match(digest.note, /never read back/);
    }
  });

  // ── Completeness, and that it can fail ──────────────────────────────────────────────

  it("accounts for every column in the inventory", async () => {
    const { exportId } = await produce();
    const { document } = await fetch(exportId);

    assert.deepEqual(document.completeness.unaccountedFor, [], "a column nobody accounted for is a silent omission");
    assert.equal(document.completeness.inventoryColumns, PII_COLUMNS.length);
    assert.equal(document.completeness.accountedFor, PII_COLUMNS.length,
      "every inventory column is shown, or named with the reason it is not");

    // The same set, checked from the other direction: each column appears somewhere a reader can find it.
    const shown = new Set(document.records.flatMap((record) => record.data.map((datum) => `${datum.provenance.table}.${datum.provenance.column}`)));
    const declared = new Set(document.heldButNotShown.map((entry) => `${entry.provenance.table}.${entry.provenance.column}`));
    const missing = PII_COLUMNS.map((column) => `${column.table}.${column.column}`)
      .filter((name) => !shown.has(name) && !declared.has(name));
    assert.deepEqual(missing, [], "a column in neither the records nor the withheld list is invisible to the reader");
  });

  it("refuses to produce an export that cannot account for a column", async () => {
    // The guard against a vacuous pass. Without this, a completeness check with a bug in it reports zero
    // unaccounted columns for ever and is indistinguishable from one that works.
    const resolved = await resolveSubjectData(database.pool, admin, { organisationId: ORG, subjectId: SUBJECT }, { decrypt: true, keys });
    const document = buildExportDocument(resolved, { producedAt: new Date(), producedBy: "dpo-a", requestRef: null });

    // Take one accounted column back out, exactly as a forgotten branch would.
    const tampered: SubjectExportDocument = {
      ...document,
      heldButNotShown: document.heldButNotShown.slice(1),
      completeness: { ...document.completeness, unaccountedFor: [`${document.heldButNotShown[0]!.provenance.table}.${document.heldButNotShown[0]!.provenance.column}`] },
    };
    assert.throws(() => assertExportComplete(tampered), ExportIncompleteError,
      "an unaccounted column must stop the export, not annotate it");

    // And the untampered one passes, so the assertion is not simply always throwing.
    assert.doesNotThrow(() => assertExportComplete(document));
  });

  it("renders the same content for a person to read, not a summary of it", async () => {
    const { exportId } = await produce();
    const { document, html } = await fetch(exportId);

    // Every value that is in the JSON is in the rendering. A human copy that showed less would make the
    // machine-readable one the real answer and this one a courtesy.
    // Escaped the same way the renderer escapes, or this compares against a string that was never
    // going to be there — a snapshot is JSON, so it is full of quotes.
    const escaped = (value: string) => value.replace(/[&<>"']/g, (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
    for (const record of document.records) {
      for (const datum of record.data) {
        if (datum.value == null || datum.value === "") continue;
        assert.ok(html.includes(escaped(datum.value)),
          `${datum.provenance.column} is in the data but not in the rendering`);
      }
    }
    // And the withheld section is in it, since that is the half a reader would otherwise never see.
    assert.match(html, /Held, but not attributable to you/);
    assert.match(html, /Held, present but not readable here/);
    assert.match(html, /No record of this kind is held about you/);
    assert.ok(renderExportDocument(document).length > 2000, "the rendering is the document, not a stub");
  });

  // ── Capability ──────────────────────────────────────────────────────────────────────

  it("requires subject.export, and reviewing is not enough", async () => {
    await assert.rejects(
      () => exportSubjectData(database.pool, principal("subject.review"), {
        organisationId: ORG, subjectId: SUBJECT, recipient: RECIPIENT, keys,
      }),
      (error: unknown) => error instanceof AuthorizationError && error.permission === "subject.export",
      "reviewing an identity question must not be a way to obtain a person's data in the clear");

    await assert.rejects(
      () => exportSubjectData(database.pool, principal(), {
        organisationId: ORG, subjectId: SUBJECT, recipient: RECIPIENT, keys,
      }),
      AuthorizationError);
  });

  // ── The audit is the act, never the contents ─────────────────────────────────────────

  it("records that an export happened, with none of the exported data in it", async () => {
    const { exportId } = await produce({ requestRef: "SAR-2026-0007" });
    const { rows } = await db.query<{ action: string; actor_id: string; entity_id: string; correlation_id: string; after_json: Record<string, unknown> }>(
      `SELECT action, actor_id, entity_id, correlation_id, after_json FROM nzi_console.audit_events
        WHERE action='subject.export' AND correlation_id='SAR-2026-0007'`);
    const event = rows[0];
    assert.ok(event, "the export is audited");
    assert.equal(event.actor_id, "dpo-a");
    assert.equal(event.entity_id, SUBJECT, "against the subject");
    assert.equal(event.after_json.exportId, exportId);
    assert.ok(Number(event.after_json.records) > 0, "with counts, so it evidences what was fulfilled");

    // The audit of a subject access must not become one more copy of the thing it is about.
    const serialised = JSON.stringify(event.after_json);
    for (const secret of Object.values(WRITTEN)) {
      assert.ok(!serialised.includes(secret), `the audit contains the exported value ${secret}`);
    }
  });

  // ── The window ───────────────────────────────────────────────────────────────────────

  it("stays readable for a dropped connection, and closes on a completed one", async () => {
    const { exportId } = await produce();

    // Two reads without a completion: the recipient's connection dropped and they tried again. This is
    // the case a shred-on-first-byte would have burned, forcing a re-request and a second copy.
    await fetch(exportId);
    const second = await fetch(exportId);
    assert.equal(second.document.subject.subjectId, SUBJECT, "a retry inside the window still works");

    const completed = await completeSubjectExportDownload(database.pool, RECIPIENT, { organisationId: ORG, exportId });
    assert.deepEqual(completed, { destroyed: true, alreadyDestroyed: false });

    await assert.rejects(() => fetch(exportId),
      (error: unknown) => error instanceof ExportUnavailableError && error.reason === "destroyed",
      "once delivered it is gone, and says so rather than returning nothing");

    // Idempotent: a retried completion is not an error, because the desired state is the same.
    assert.deepEqual(
      await completeSubjectExportDownload(database.pool, RECIPIENT, { organisationId: ORG, exportId }),
      { destroyed: false, alreadyDestroyed: true });
  });

  it("destroys the key and the payloads together, and keeps the record that it existed", async () => {
    const { exportId } = await produce({ requestRef: "SAR-2026-0009" });
    const before = await db.query<{ wrapped_key: unknown; sealed_json: unknown; record_count: number }>(
      `SELECT wrapped_key, sealed_json, record_count FROM nzi_console.subject_export_artifacts WHERE export_id=$1`, [exportId]);
    assert.ok(before.rows[0]!.wrapped_key, "sealed and readable to begin with");
    assert.ok(before.rows[0]!.record_count > 0);

    await completeSubjectExportDownload(database.pool, RECIPIENT, { organisationId: ORG, exportId });

    const { rows } = await db.query<{
      wrapped_key: unknown; sealed_json: unknown; sealed_html: unknown;
      destroyed_reason: string; downloaded_at: Date | null; record_count: number; datum_count: number; subject_id: string;
    }>(`SELECT wrapped_key, sealed_json, sealed_html, destroyed_reason, downloaded_at, record_count, datum_count, subject_id
          FROM nzi_console.subject_export_artifacts WHERE export_id=$1`, [exportId]);
    const row = rows[0]!;

    // The shred: the key is gone, which is what reaches any copy of the payloads already taken.
    assert.equal(row.wrapped_key, null, "the ephemeral key is destroyed");
    // The empty: nothing readable is left in the live row either.
    assert.equal(row.sealed_json, null);
    assert.equal(row.sealed_html, null);

    // The compliance record outlives the contents, which is what lets us evidence the request was
    // fulfilled without keeping a copy of somebody's personal data to do it.
    assert.equal(row.destroyed_reason, "downloaded");
    assert.ok(row.downloaded_at, "when it was delivered");
    assert.equal(row.subject_id, SUBJECT);
    assert.ok(row.record_count > 0 && row.datum_count > 0, "and how much it contained");

    const audit = await db.query<{ after_json: Record<string, unknown> }>(
      `SELECT after_json FROM nzi_console.audit_events WHERE action='subject.export.destroyed' AND after_json->>'exportId'=$1`, [exportId]);
    assert.equal(audit.rows[0]!.after_json.reason, "downloaded");
  });

  it("closes the window at expiry even if nobody comes back for it", async () => {
    const { exportId, expiresAt } = await produce({ ttlSeconds: 60 });
    assert.ok(expiresAt.getTime() > Date.now(), "the window is open to begin with");

    // A read after expiry destroys rather than serves, so the TTL is the TTL whatever the sweep's
    // schedule happens to be.
    const after = new Date(Date.now() + 61_000);
    await assert.rejects(() => fetch(exportId, after),
      (error: unknown) => error instanceof ExportUnavailableError && error.reason === "expired");

    const { rows } = await db.query<{ destroyed_reason: string; wrapped_key: unknown }>(
      `SELECT destroyed_reason, wrapped_key FROM nzi_console.subject_export_artifacts WHERE export_id=$1`, [exportId]);
    assert.equal(rows[0]!.destroyed_reason, "expired");
    assert.equal(rows[0]!.wrapped_key, null, "a lapsed artifact is shredded, not merely refused");
  });

  it("sweeps the ones nobody ever read", async () => {
    const { exportId } = await produce({ ttlSeconds: 60 });
    const swept = await expireSubjectExports(database.pool, { organisationId: ORG, now: new Date(Date.now() + 61_000) });
    assert.ok(swept.destroyed.includes(exportId), "the backstop finds a lapsed artifact");

    const { rows } = await db.query<{ destroyed_reason: string; wrapped_key: unknown; sealed_json: unknown }>(
      `SELECT destroyed_reason, wrapped_key, sealed_json FROM nzi_console.subject_export_artifacts WHERE export_id=$1`, [exportId]);
    assert.equal(rows[0]!.destroyed_reason, "expired");
    assert.equal(rows[0]!.wrapped_key, null);
    assert.equal(rows[0]!.sealed_json, null);

    // And it does not touch one whose window is still open.
    const live = await produce();
    const again = await expireSubjectExports(database.pool, { organisationId: ORG });
    assert.ok(!again.destroyed.includes(live.exportId), "an artifact inside its window is left alone");
  });

  it("is retrievable only by the recipient it was produced for", async () => {
    const { exportId } = await produce();
    await assert.rejects(
      () => readSubjectExport(database.pool, { principal: "portal", id: "portal-somebody-else" }, { organisationId: ORG, exportId, keys }),
      (error: unknown) => error instanceof ExportUnavailableError && error.reason === "not-the-recipient");
    await assert.rejects(
      () => completeSubjectExportDownload(database.pool, { principal: "staff", id: "portal-1" }, { organisationId: ORG, exportId }),
      (error: unknown) => error instanceof ExportUnavailableError && error.reason === "not-the-recipient",
      "the principal type is part of the identity, not decoration");

    // Still intact: a refused reader must not have consumed somebody else's response.
    const { document } = await fetch(exportId);
    assert.equal(document.subject.subjectId, SUBJECT);
  });

  it("has a window that is short and stated in one place", () => {
    // Not an arbitrary assertion: the TTL is the retention position, so a change to it should be a
    // deliberate edit here as well as there.
    assert.equal(EXPORT_TTL_SECONDS, 24 * 60 * 60);
  });
});
