import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { commandGrantForRole, type CommandContext } from "@nzi/contracts";
import { createDisposableDatabase, TEST_DATABASE_URL, type DisposableDatabase } from "./support/database";
import {
  AuthorizationError, CommandValidationError, deactivateClientFile, eicarTestSignature, ingestFile, issueClientFileDownload, issuePortalFileDownload, listPortalFilesForStaff, listPortalFiles,
  LocalStorageAdapter, recordClientFileDelivery, recordPortalFileUpload, rescanClientFile, type PortalPrincipal, type ScanVerdict, type Scanner,
} from "../src/index";

/**
 * Portal files, against a real database (BRIEF-portal-files-secure-upload-storage): the records and the audited commands around the gate.
 *  1. a quarantined (or rejected, or withdrawn) file is never served — to the client or to staff;
 *  2. an infected/oversize/disallowed file is refused, recorded and flagged; a clean one releases, is hashed, and is served only by a signed URL;
 *  3. every upload, delivery, download, re-scan and withdrawal is an audited event — and no URL or storage id is in it;
 *  4. tenancy: one client (and one job's grant) cannot reach another's files; a portal user cannot run a staff command and vice versa.
 */
const ORG = "demo-nzi-console";
const CLIENT = "client-pf", OTHER_CLIENT = "client-pf-other";
const JOB = "job-pf", UNGRANTED_JOB = "job-pf-2", OTHER_JOB = "job-pf-other";
const USER = "portal-pf", OTHER_USER = "portal-pf-other", STAFF = "staff-pf";
const principal = (userId: string, clientId: string) => ({ principal: "portal", organisationId: ORG, userId, clientId, sessionId: "p", issuedAt: 1, expiresAt: 2, displayName: "P", email: "p@example.invalid" }) as unknown as PortalPrincipal;
const PDF = new TextEncoder().encode("%PDF-1.7\n1 0 obj<<>>endobj\n%%EOF");

describe("portal files: records, audited access, and the gate's guarantee", { skip: TEST_DATABASE_URL ? false : "NZI_TEST_DATABASE_URL is not set" }, () => {
  let database: DisposableDatabase;
  let db: pg.Client;
  let keys = 0;
  let verdict: ScanVerdict = { state: "clean" };
  const adapter = new LocalStorageAdapter();
  // The positive scanner the gate releases on (ClamAV in a deployment; its protocol is proved in clamAvScanner.test.ts).
  const scanner: Scanner = { scan: async (data) => (new TextDecoder("latin1").decode(data).includes(eicarTestSignature()) ? { state: "infected", detail: "test signature" } : verdict) };
  const adapterFor = () => adapter;
  const portal = (userId = USER, clientId = CLIENT): CommandContext => {
    keys += 1;
    return { organisationId: ORG, actorId: userId, principal: "portal", portal: { portalUserId: userId, clientId }, idempotencyKey: `pf-${keys}`, correlationId: `corr-pf-${keys}` };
  };
  const staff = (reason?: string): CommandContext => {
    keys += 1;
    return { organisationId: ORG, actorId: STAFF, principal: "staff", idempotencyKey: `sf-${keys}`, correlationId: `corr-sf-${keys}`, grant: commandGrantForRole("admin", ORG, STAFF), ...(reason ? { reason } : {}) };
  };
  const ingest = (data: Uint8Array, name: string, jobId: string | null = JOB, clientId = CLIENT) => ingestFile({ adapter, scanner, organisationId: ORG, clientId, jobId, fileName: name, bytes: data });
  const audit = async (fileId: string) => (await db.query(`SELECT principal_type, action, after_json FROM nzi_console.audit_events WHERE entity_id=$1 ORDER BY occurred_at`, [fileId])).rows;
  const codes = (error: unknown) => error instanceof CommandValidationError ? error.issues.map((issue) => issue.code) : [];

  before(async () => {
    database = (await createDisposableDatabase("portalfiles"))!;
    db = await database.admin();
    await db.query(`INSERT INTO nzi_console.organisations (organisation_id,name) VALUES ($1,$1)`, [ORG]);
    await db.query(`SELECT nzi_console.provision_organisation($1)`, [ORG]);
    await db.query(`SELECT set_config('app.organisation_id', $1, false)`, [ORG]);
    await db.query(`INSERT INTO nzi_console.clients (organisation_id,client_id,name,status) VALUES ($1,$2,'Co','active'),($1,$3,'Other','active')`, [ORG, CLIENT, OTHER_CLIENT]);
    await db.query(`INSERT INTO nzi_console.memberships (organisation_id,user_id,role_id,status,display_name) VALUES ($1,$2,'admin','active','Sam Staff')`, [ORG, STAFF]);
    for (const [job, client] of [[JOB, CLIENT], [UNGRANTED_JOB, CLIENT], [OTHER_JOB, OTHER_CLIENT]] as const) {
      await db.query(
        `INSERT INTO nzi_console.jobs (organisation_id,job_id,client_id,sequence,job_family,title,status,workflow_stage,reporting_year,reporting_period_start,reporting_period_end)
         VALUES ($1,$2,$3,(SELECT coalesce(max(sequence),0)+1 FROM nzi_console.jobs),'crp','CRP','open','Data entry',2026,'2026-01-01','2026-12-31')`, [ORG, job, client]);
    }
    await db.query(`INSERT INTO nzi_console.portal_users (organisation_id,portal_user_id,client_id,status) VALUES ($1,$2,$3,'active'),($1,$4,$5,'active')`, [ORG, USER, CLIENT, OTHER_USER, OTHER_CLIENT]);
    // The window is irrelevant to files (sharing a document is not data entry): a grant with no window at all.
    await db.query(
      `INSERT INTO nzi_console.portal_access_grants (organisation_id,grant_id,client_id,portal_user_id,job_id,data_entry_starts_at,data_entry_expires_at,revoked_at)
       VALUES ($1,'g-pf',$2,$3,$4,NULL,NULL,NULL), ($1,'g-pf-revoked',$2,$3,$5,NULL,NULL,now()), ($1,'g-pf-other',$6,$7,$8,NULL,NULL,NULL)`,
      [ORG, CLIENT, USER, JOB, UNGRANTED_JOB, OTHER_CLIENT, OTHER_USER, OTHER_JOB]);
  });
  after(async () => { await db?.end(); await database?.end(); });

  let released = "";
  it("records a clean client upload: released and hashed, audited as the portal user, with no storage id or URL in the audit, and replayed idempotently", async () => {
    const file = await ingest(PDF, "evidence.pdf");
    const context = portal();
    const outcome = await recordPortalFileUpload(database.pool, { clientId: CLIENT, ingest: file }, context);
    released = outcome.data.fileId as string;
    const stored = (await db.query(`SELECT * FROM nzi_console.portal_files WHERE file_id=$1`, [released])).rows[0];
    assert.deepEqual([stored.status, stored.direction, stored.uploaded_by_principal, stored.sha256, stored.storage_provider], ["released", "client_upload", "portal", file.sha256, "local"]);
    assert.ok(stored.released_at && stored.external_item_id);
    const events = await audit(released);
    assert.deepEqual(events.map((event) => [event.principal_type, event.action]), [["portal", "portal_file_uploaded"]]);
    assert.doesNotMatch(JSON.stringify(events), new RegExp(stored.external_item_id), "no storage identifier in the audit");
    assert.equal((await recordPortalFileUpload(database.pool, { clientId: CLIENT, ingest: file }, context)).replayed, true);
  });

  it("refuses a forged ingest: a released file with no bytes, a bad hash, an unknown provider or a disallowed type", async () => {
    const good = await ingest(PDF, "ok.pdf");
    for (const forged of [{ ...good, externalItemId: null }, { ...good, sha256: "nope" }, { ...good, storageProvider: "dropbox" }, { ...good, contentType: "application/x-msdownload" }, { ...good, status: "deactivated" }, { ...good, sizeBytes: -1 }]) {
      await assert.rejects(recordPortalFileUpload(database.pool, { clientId: CLIENT, ingest: forged as never }, portal()), CommandValidationError, JSON.stringify(Object.keys(forged)));
    }
  });

  it("holds a portal upload to the client's own grant: no job, an ungranted or revoked job, another client's job, another client's id", async () => {
    const noJob = await ingest(PDF, "a.pdf", null);
    await assert.rejects(recordPortalFileUpload(database.pool, { clientId: CLIENT, ingest: noJob }, portal()), (e) => codes(e).includes("REQUIRED"));
    for (const job of [UNGRANTED_JOB, OTHER_JOB]) await assert.rejects(recordPortalFileUpload(database.pool, { clientId: CLIENT, ingest: await ingest(PDF, "a.pdf", job) }, portal()), CommandValidationError, job);
    await assert.rejects(recordPortalFileUpload(database.pool, { clientId: OTHER_CLIENT, ingest: await ingest(PDF, "a.pdf", OTHER_JOB, OTHER_CLIENT) }, portal()), AuthorizationError);
  });

  it("records an infected, oversize or disallowed upload as rejected and flagged — kept, audited, and never downloadable", async () => {
    const infected = await recordPortalFileUpload(database.pool, { clientId: CLIENT, ingest: await ingest(new TextEncoder().encode(`%PDF-1.4 ${eicarTestSignature()}`), "bad.pdf") }, portal());
    const exe = await recordPortalFileUpload(database.pool, { clientId: CLIENT, ingest: await ingest(new Uint8Array([0x4d, 0x5a, 0, 0]), "setup.pdf") }, portal());
    assert.deepEqual([infected.data.status, infected.data.flag], ["rejected", "infected"]);
    assert.deepEqual([exe.data.status, exe.data.flag], ["rejected", "executable"]);
    assert.equal((await audit(infected.data.fileId as string)).length, 1);
    for (const id of [infected.data.fileId, exe.data.fileId] as string[]) {
      await assert.rejects(issuePortalFileDownload(database.pool, { clientId: CLIENT, fileId: id }, portal(), adapterFor), (e) => codes(e).includes("FILE_NOT_AVAILABLE"));
      await assert.rejects(issueClientFileDownload(database.pool, { clientId: CLIENT, fileId: id }, staff(), adapterFor), (e) => codes(e).includes("FILE_NOT_AVAILABLE"));
    }
    // The client sees their own refusals, with the reason; they see nothing of the scanner beyond it.
    const mine = await listPortalFiles(database.pool, principal(USER, CLIENT));
    assert.ok(mine.some((file) => file.status === "rejected" && file.flag === "infected"));
  });

  let held = "";
  it("holds a file the scanner cannot decide: never served to the client or to staff until a re-scan releases it", async () => {
    verdict = { state: "unknown", detail: "Waiting for the scan." };
    const outcome = await recordPortalFileUpload(database.pool, { clientId: CLIENT, ingest: await ingest(PDF, "pending.pdf") }, portal());
    held = outcome.data.fileId as string;
    assert.deepEqual([outcome.data.status, outcome.data.flag], ["quarantined", "scan_inconclusive"]);
    await assert.rejects(issuePortalFileDownload(database.pool, { clientId: CLIENT, fileId: held }, portal(), adapterFor), (e) => codes(e).includes("FILE_NOT_AVAILABLE"));
    await assert.rejects(issueClientFileDownload(database.pool, { clientId: CLIENT, fileId: held }, staff(), adapterFor), (e) => codes(e).includes("FILE_NOT_AVAILABLE"));
    const stillHeld = await rescanClientFile(database.pool, { clientId: CLIENT, fileId: held }, staff(), adapterFor, scanner);
    assert.equal(stillHeld.data.status, "quarantined");
    verdict = { state: "clean" };
    const released2 = await rescanClientFile(database.pool, { clientId: CLIENT, fileId: held }, staff(), adapterFor, scanner);
    assert.deepEqual([released2.data.status, released2.data.flag], ["released", null]);
    await assert.rejects(rescanClientFile(database.pool, { clientId: CLIENT, fileId: held }, staff(), adapterFor, scanner), (e) => codes(e).includes("NOT_HELD"));
  });

  it("serves a released file only through a signed, time-limited URL — to the client with the grant and to staff — and audits each access without the URL", async () => {
    const mine = await issuePortalFileDownload(database.pool, { clientId: CLIENT, fileId: released }, portal(), adapterFor);
    assert.deepEqual(adapter.fetchSigned(mine.download!.url), PDF);
    assert.ok(Date.parse(mine.download!.expiresAt) > Date.now() && Date.parse(mine.download!.expiresAt) <= Date.now() + 300_000);
    const staffs = await issueClientFileDownload(database.pool, { clientId: CLIENT, fileId: released }, staff(), adapterFor);
    assert.notEqual(staffs.download!.url, mine.download!.url, "re-signed per access");
    const events = await audit(released);
    assert.deepEqual(events.map((event) => event.action), ["portal_file_uploaded", "portal_file_downloaded", "client_file_downloaded"]);
    assert.doesNotMatch(JSON.stringify(events), /local:\/\/|https?:\/\//, "no URL in the audit");
  });

  it("isolates tenants: another client's user cannot download, list or upload against this client's files", async () => {
    await assert.rejects(issuePortalFileDownload(database.pool, { clientId: CLIENT, fileId: released }, portal(OTHER_USER, OTHER_CLIENT), adapterFor), AuthorizationError);
    await assert.rejects(issuePortalFileDownload(database.pool, { clientId: OTHER_CLIENT, fileId: released }, portal(OTHER_USER, OTHER_CLIENT), adapterFor), (e) => codes(e).includes("NOT_FOUND"));
    assert.deepEqual(await listPortalFiles(database.pool, principal(OTHER_USER, OTHER_CLIENT)), []);
    await assert.rejects(issueClientFileDownload(database.pool, { clientId: OTHER_CLIENT, fileId: released }, staff(), adapterFor), (e) => codes(e).includes("NOT_FOUND"));
  });

  it("shares a deliverable: client-wide, or for a job — and a job's file is visible only to a user who holds that job", async () => {
    const wide = await recordClientFileDelivery(database.pool, { clientId: CLIENT, ingest: await ingest(PDF, "report.pdf", null) }, staff());
    const forJob = await recordClientFileDelivery(database.pool, { clientId: CLIENT, ingest: await ingest(PDF, "job-pack.pdf", JOB) }, staff());
    const forOther = await recordClientFileDelivery(database.pool, { clientId: CLIENT, ingest: await ingest(PDF, "other-job.pdf", UNGRANTED_JOB) }, staff());
    const visible = (await listPortalFiles(database.pool, principal(USER, CLIENT))).map((file) => file.fileName);
    assert.ok(visible.includes("report.pdf") && visible.includes("job-pack.pdf"));
    assert.ok(!visible.includes("other-job.pdf"), "a job the user does not hold (their grant is revoked) is not theirs to see");
    assert.ok((await issuePortalFileDownload(database.pool, { clientId: CLIENT, fileId: wide.data.fileId as string }, portal(), adapterFor)).download);
    await assert.rejects(issuePortalFileDownload(database.pool, { clientId: CLIENT, fileId: forOther.data.fileId as string }, portal(), adapterFor), (e) => codes(e).includes("NOT_FOUND"));
    assert.equal((await listPortalFiles(database.pool, principal(USER, CLIENT))).find((file) => file.fileName === "report.pdf")!.uploadedBy, "NZI", "a staff name is not the client's to see");
    assert.equal(forJob.data.status, "released");
  });

  it("keeps the two directions apart in who may send, and the portal and staff commands apart in who may run them", async () => {
    await assert.rejects(recordClientFileDelivery(database.pool, { clientId: CLIENT, ingest: await ingest(PDF, "x.pdf") }, portal()), AuthorizationError);
    await assert.rejects(recordPortalFileUpload(database.pool, { clientId: CLIENT, ingest: await ingest(PDF, "x.pdf") }, staff()), AuthorizationError);
    await assert.rejects(deactivateClientFile(database.pool, { clientId: CLIENT, fileId: released }, { ...portal(), reason: "no" }, adapterFor), AuthorizationError);
    await assert.rejects(db.query(`UPDATE nzi_console.portal_files SET uploaded_by_principal='staff' WHERE file_id=$1`, [released]), /portal_files_direction_principal/);
  });

  it("withdraws a file with a reason — kept, never deleted, no longer served or listed to the client — and lists everything to staff", async () => {
    await assert.rejects(deactivateClientFile(database.pool, { clientId: CLIENT, fileId: released }, staff(), adapterFor), CommandValidationError, "a reason is required");
    const gone = await deactivateClientFile(database.pool, { clientId: CLIENT, fileId: released }, staff("Uploaded to the wrong job"), adapterFor);
    assert.equal(gone.data.previousStatus, "released");
    const row = (await db.query(`SELECT status, external_item_id, deactivated_by, deactivated_reason FROM nzi_console.portal_files WHERE file_id=$1`, [released])).rows[0];
    assert.deepEqual([row.status, row.deactivated_by, row.deactivated_reason], ["deactivated", STAFF, "Uploaded to the wrong job"]);
    assert.equal(adapter.areaOf(row.external_item_id), "deactivated", "the bytes are kept, out of service");
    await assert.rejects(issuePortalFileDownload(database.pool, { clientId: CLIENT, fileId: released }, portal(), adapterFor), (e) => codes(e).includes("FILE_NOT_AVAILABLE"));
    await assert.rejects(deactivateClientFile(database.pool, { clientId: CLIENT, fileId: released }, staff("again"), adapterFor), (e) => codes(e).includes("ALREADY_DEACTIVATED"));
    assert.ok(!(await listPortalFiles(database.pool, principal(USER, CLIENT))).some((file) => file.fileId === released));
    const all = await listPortalFilesForStaff(database.pool, { organisationId: ORG, userId: STAFF, capabilities: commandGrantForRole("admin", ORG, STAFF).capabilities }, CLIENT);
    assert.ok(all.some((file) => file.fileId === released && file.status === "deactivated"), "staff still see it");
    assert.ok(all.every((file) => file.clientId === CLIENT));
    assert.equal((await db.query(`SELECT has_table_privilege('nzi_console_app','nzi_console.portal_files','DELETE') AS can`)).rows[0].can, false, "the application role cannot delete a file record");
  });
});

