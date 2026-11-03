import { PORTAL_FILE_FLAG_LABELS, PORTAL_FILE_URL_TTL_MAX_SECONDS, PORTAL_FILE_URL_TTL_SECONDS, type CommandContext, type CommandInputMap, type PortalFileCategory, type PortalFileDirection, type PortalFileFlag, type PortalFileHistoryEntry, type PortalFileIngest, type PortalFileRecord, type PortalFileStatus } from "@nzi/contracts";
import { assertCapabilityOnClient, type CapabilityHolder } from "./access";
import { AuthorizationError, type PortalPrincipal } from "./auth";
import { rescanFile, type Scanner, type StorageAdapter } from "./fileStorage";
import { withTenantRead, type PoolLike, type Queryable } from "./postgres";
import { CommandValidationError, runPostgresCommand, type StoredOutcome } from "./postgresCommands";

/**
 * Portal files — the records and the audited commands around them (BRIEF-portal-files-secure-upload-storage). The bytes are the storage
 * adapter's and the gate's (`fileStorage/`); this file records what the gate decided and controls who may be given a signed URL.
 *
 *  - **Upload / deliver** record the gate's outcome. The command re-validates its shape (a forged ingest is refused) and ties the file to
 *    its client and, if named, a job of that client. Whatever the gate decided — released, held or rejected — is audited.
 *  - **Download** issues a signed URL for a **released** file only, per access, and audits it. The URL is never in the audit data.
 *  - **Rescan** takes a held file through the same decision as on arrival. **Deactivate** withdraws one — the record and bytes are kept.
 *  - A portal user sees a deliverable if it is client-wide or for a job they hold a live grant on, and the client uploads of jobs they
 *    hold a grant on; never another client's, never a file that has not been released (their own are listed with their state).
 *
 * Every function that touches bytes is handed the adapter — nothing here names a provider.
 */
type FileRow = {
  file_id: string; client_id: string; job_id: string | null; direction: PortalFileDirection; status: PortalFileStatus; file_name: string; content_type: string;
  size_bytes: string; sha256: string; storage_provider: string; external_item_id: string | null; flag: PortalFileFlag | null; flag_detail: string | null;
  uploaded_by: string; uploaded_by_principal: "staff" | "portal"; uploaded_at: Date; released_at: Date | null; deactivated_at: Date | null; deactivated_by: string | null;
  category: PortalFileCategory; deactivated_reason: string | null;
};
const COLUMNS = `file_id,client_id,job_id,direction,status,file_name,content_type,size_bytes::text AS size_bytes,sha256,storage_provider,external_item_id,flag,flag_detail,uploaded_by,uploaded_by_principal,uploaded_at,released_at,deactivated_at,deactivated_by,category,deactivated_reason`;
const iso = (value: Date | string | null) => (value ? new Date(value).toISOString() : null);
const toRecord = (row: FileRow): PortalFileRecord => ({
  fileId: row.file_id, clientId: row.client_id, jobId: row.job_id, direction: row.direction, status: row.status, fileName: row.file_name, contentType: row.content_type,
  sizeBytes: Number(row.size_bytes), sha256: row.sha256, flag: row.flag, flagDetail: row.flag_detail, uploadedBy: row.uploaded_by, uploadedByPrincipal: row.uploaded_by_principal,
  uploadedAt: iso(row.uploaded_at)!, releasedAt: iso(row.released_at), deactivatedAt: iso(row.deactivated_at), deactivatedBy: row.deactivated_by,
  category: row.category, deactivatedReason: row.deactivated_reason,
});
const refuse = (field: string, code: string, message: string) => new CommandValidationError([{ field, code, message }]);
const NOT_FOUND = () => refuse("fileId", "NOT_FOUND", "That file was not found.");
const FILE_NOT_AVAILABLE = () => refuse("fileId", "FILE_NOT_AVAILABLE", "That file isn't available to download.");

/** The job, if one is named, must be the client's own. */
async function requireClientJob(db: Queryable, context: CommandContext, clientId: string, jobId: string | null): Promise<void> {
  if (!jobId) return;
  const job = await db.query(`SELECT 1 FROM nzi_console.jobs WHERE organisation_id = $1 AND job_id = $2 AND client_id = $3`, [context.organisationId, jobId, clientId]);
  if (!job.rows[0]) throw refuse("ingest.jobId", "NOT_FOUND", "That job was not found.");
}
/** A portal user's live grant on a job — any window: sharing a document is not data entry. */
async function portalHoldsJob(db: Queryable, context: CommandContext, jobId: string): Promise<boolean> {
  const held = await db.query(
    `SELECT 1 FROM nzi_console.portal_access_grants g JOIN nzi_console.portal_users u ON (u.organisation_id, u.portal_user_id, u.client_id) = (g.organisation_id, g.portal_user_id, g.client_id)
      WHERE g.organisation_id = $1 AND g.portal_user_id = $2 AND g.client_id = $3 AND g.job_id = $4 AND g.revoked_at IS NULL AND u.status = 'active'`,
    [context.organisationId, context.actorId, context.portal!.clientId, jobId]);
  return !!held.rows[0];
}

export async function insertFile(db: Queryable, context: CommandContext, clientId: string, direction: PortalFileDirection, ingest: PortalFileIngest, category: PortalFileCategory): Promise<void> {
  await db.query(
    `INSERT INTO nzi_console.portal_files (organisation_id,file_id,client_id,job_id,direction,status,file_name,content_type,size_bytes,sha256,storage_provider,external_item_id,flag,flag_detail,uploaded_by,uploaded_by_principal,released_at,category)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,CASE WHEN $6 = 'released' THEN now() END,$17)`,
    [context.organisationId, ingest.fileId, clientId, ingest.jobId, direction, ingest.status, ingest.fileName, ingest.contentType, ingest.sizeBytes, ingest.sha256, ingest.storageProvider,
      ingest.externalItemId, ingest.flag, ingest.flagDetail?.slice(0, 500) ?? null, context.actorId, context.principal === "portal" ? "portal" : "staff", category]);
}
const recorded = (clientId: string, ingest: PortalFileIngest, topic: string) => ({
  // What is audited: the outcome and the evidence of the file (its hash), never the bytes and never a storage identifier.
  data: { fileId: ingest.fileId, clientId, jobId: ingest.jobId, fileName: ingest.fileName, contentType: ingest.contentType, sizeBytes: ingest.sizeBytes, sha256: ingest.sha256, status: ingest.status, flag: ingest.flag },
  entityType: "portal_file", entityId: ingest.fileId, topic,
});

/** A client's upload, as the gate decided it. The client must hold a live grant on the job it names; a portal upload names one. */
export function recordPortalFileUpload(pool: PoolLike, input: CommandInputMap["portal.file.upload"], context: CommandContext): Promise<StoredOutcome<ReturnType<typeof recorded>["data"]>> {
  return runPostgresCommand(pool, "portal.file.upload", input, context, async (db) => {
    if (!input.ingest.jobId) throw refuse("ingest.jobId", "REQUIRED", "Choose the job this file is for.");
    await requireClientJob(db, context, input.clientId, input.ingest.jobId);
    if (!(await portalHoldsJob(db, context, input.ingest.jobId))) throw refuse("ingest.jobId", "NOT_FOUND", "That job was not found.");
    await insertFile(db, context, input.clientId, "client_upload", input.ingest, input.category);
    return recorded(input.clientId, input.ingest, "portal.file.uploaded");
  });
}

/** A deliverable NZI shares with the client, as the gate decided it (portal.admin on this client). */
export function recordClientFileDelivery(pool: PoolLike, input: CommandInputMap["client.file.deliver"], context: CommandContext): Promise<StoredOutcome<ReturnType<typeof recorded>["data"]>> {
  return runPostgresCommand(pool, "client.file.deliver", input, context, async (db) => {
    const client = await db.query(`SELECT 1 FROM nzi_console.clients WHERE organisation_id = $1 AND client_id = $2`, [context.organisationId, input.clientId]);
    if (!client.rows[0]) throw refuse("clientId", "NOT_FOUND", "Client was not found.");
    await requireClientJob(db, context, input.clientId, input.ingest.jobId);
    await insertFile(db, context, input.clientId, "deliverable", input.ingest, input.category ?? "other");
    return recorded(input.clientId, input.ingest, "client.file.delivered");
  });
}

async function loadFile(db: Queryable, context: CommandContext, clientId: string, fileId: string): Promise<FileRow> {
  const row = (await db.query<FileRow>(`SELECT ${COLUMNS} FROM nzi_console.portal_files WHERE organisation_id = $1 AND client_id = $2 AND file_id = $3 FOR UPDATE`, [context.organisationId, clientId, fileId])).rows[0];
  if (!row) throw NOT_FOUND();
  return row;
}

/** Whether a portal user may be given a released file: client-wide deliverables, else the job's grant. Their own client's, always. */
async function portalMayHave(db: Queryable, context: CommandContext, file: FileRow): Promise<boolean> {
  if (file.client_id !== context.portal!.clientId) return false;
  if (file.job_id === null ? file.direction === "deliverable" : await portalHoldsJob(db, context, file.job_id)) return true;
  // A message attachment (M3) is the thread's: whoever may see the thread may be given the file - never anyone else, whatever its direction.
  return !!(await db.query(
    `SELECT 1 FROM nzi_console.portal_message_attachments a
       JOIN nzi_console.portal_messages m ON (m.organisation_id, m.message_id) = (a.organisation_id, a.message_id)
       JOIN nzi_console.portal_threads t ON (t.organisation_id, t.thread_id) = (m.organisation_id, m.thread_id)
      WHERE a.organisation_id = $1 AND a.file_id = $2 AND t.client_id = $3
        AND (t.scope = 'client' OR t.job_id IN (SELECT g.job_id FROM nzi_console.portal_access_grants g JOIN nzi_console.portal_users u ON (u.organisation_id, u.portal_user_id, u.client_id) = (g.organisation_id, g.portal_user_id, g.client_id)
                                                 WHERE g.organisation_id = $1 AND g.portal_user_id = $4 AND g.client_id = $3 AND g.revoked_at IS NULL AND u.status = 'active'))`,
    [context.organisationId, file.file_id, file.client_id, context.actorId])).rows[0];
}

export type FileDownload = { url: string; expiresAt: string; fileName: string; contentType: string };
const ttl = (requested?: number) => Math.min(Math.max(requested ?? PORTAL_FILE_URL_TTL_SECONDS, 10), PORTAL_FILE_URL_TTL_MAX_SECONDS);

async function issue(db: Queryable, context: CommandContext, file: FileRow, adapter: StorageAdapter, capture: { value: FileDownload | null }) {
  if (file.status !== "released" || !file.external_item_id) throw FILE_NOT_AVAILABLE();
  const signed = await adapter.signedUrl(file.external_item_id, ttl());
  capture.value = { url: signed.url, expiresAt: signed.expiresAt, fileName: file.file_name, contentType: file.content_type };
  // Audited: who, which file, its hash and when the access lapses — never the URL itself.
  return { data: { fileId: file.file_id, clientId: file.client_id, jobId: file.job_id, direction: file.direction, sha256: file.sha256, expiresAt: signed.expiresAt }, entityType: "portal_file", entityId: file.file_id, topic: "portal.file.downloaded" };
}

/** A signed URL for a released file, for a portal user entitled to it. `download` is null when the command was replayed (sign again). */
export async function issuePortalFileDownload(pool: PoolLike, input: CommandInputMap["portal.file.download"], context: CommandContext, adapterFor: (provider: string) => StorageAdapter) {
  const capture: { value: FileDownload | null } = { value: null };
  const outcome = await runPostgresCommand(pool, "portal.file.download", input, context, async (db) => {
    const file = await loadFile(db, context, input.clientId, input.fileId);
    if (!(await portalMayHave(db, context, file))) throw NOT_FOUND();
    return issue(db, context, file, adapterFor(file.storage_provider), capture);
  });
  return { outcome, download: capture.value };
}
export async function issueClientFileDownload(pool: PoolLike, input: CommandInputMap["client.file.download"], context: CommandContext, adapterFor: (provider: string) => StorageAdapter) {
  const capture: { value: FileDownload | null } = { value: null };
  const outcome = await runPostgresCommand(pool, "client.file.download", input, context, async (db) => {
    const file = await loadFile(db, context, input.clientId, input.fileId);
    return issue(db, context, file, adapterFor(file.storage_provider), capture);
  });
  return { outcome, download: capture.value };
}

/** Take a held file through the gate's decision again (the scanner was still working, or had failed). */
export function rescanClientFile(pool: PoolLike, input: CommandInputMap["client.file.rescan"], context: CommandContext, adapterFor: (provider: string) => StorageAdapter, scanner: Scanner) {
  return runPostgresCommand(pool, "client.file.rescan", input, context, async (db) => {
    const file = await loadFile(db, context, input.clientId, input.fileId);
    if (file.status !== "quarantined" || !file.external_item_id) throw refuse("fileId", "NOT_HELD", "Only a held file is scanned again.");
    const adapter = adapterFor(file.storage_provider);
    const decided = await rescanFile(adapter, scanner, { fileId: file.file_id, jobId: file.job_id, fileName: file.file_name, contentType: file.content_type, sizeBytes: Number(file.size_bytes), sha256: file.sha256,
      storageProvider: adapter.provider, externalItemId: file.external_item_id, status: "quarantined", flag: file.flag, flagDetail: file.flag_detail });
    await db.query(
      `UPDATE nzi_console.portal_files SET status = $4, flag = $5, flag_detail = $6, external_item_id = $7, released_at = CASE WHEN $4 = 'released' THEN now() END WHERE organisation_id = $1 AND client_id = $2 AND file_id = $3`,
      [context.organisationId, input.clientId, input.fileId, decided.status, decided.flag, decided.flagDetail?.slice(0, 500) ?? null, decided.externalItemId]);
    return { data: { fileId: file.file_id, clientId: file.client_id, sha256: file.sha256, status: decided.status, flag: decided.flag }, entityType: "portal_file", entityId: file.file_id, topic: "client.file.rescanned" };
  });
}

/** Withdraw a file from service. Kept: the record and the bytes stay, so the trail is whole. */
export function deactivateClientFile(pool: PoolLike, input: CommandInputMap["client.file.deactivate"], context: CommandContext, adapterFor: (provider: string) => StorageAdapter) {
  return runPostgresCommand(pool, "client.file.deactivate", input, context, async (db) => {
    const file = await loadFile(db, context, input.clientId, input.fileId);
    if (file.status === "deactivated") throw refuse("fileId", "ALREADY_DEACTIVATED", "That file is already withdrawn.");
    if (file.external_item_id) await adapterFor(file.storage_provider).deactivate(file.external_item_id);
    await db.query(
      `UPDATE nzi_console.portal_files SET status = 'deactivated', deactivated_at = now(), deactivated_by = $4, deactivated_reason = $5 WHERE organisation_id = $1 AND client_id = $2 AND file_id = $3`,
      [context.organisationId, input.clientId, input.fileId, context.actorId, context.reason?.slice(0, 500) ?? null]);
    return { data: { fileId: file.file_id, clientId: file.client_id, sha256: file.sha256, previousStatus: file.status }, entityType: "portal_file", entityId: file.file_id, topic: "client.file.deactivated" };
  });
}

// ── Reads ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The Files tab: everything for one client, both directions, every status, under portal.admin on this client. */
export function listPortalFilesForStaff(pool: PoolLike, holder: CapabilityHolder, clientId: string): Promise<PortalFileRecord[]> {
  return withTenantRead(pool, holder.organisationId, async (db) => {
    await assertCapabilityOnClient(db, holder, "portal.admin", { clientId });
    return (await db.query<FileRow>(`SELECT ${COLUMNS} FROM nzi_console.portal_files WHERE organisation_id = $1 AND client_id = $2 ORDER BY uploaded_at DESC`, [holder.organisationId, clientId])).rows.map(toRecord);
  });
}

/**
 * What a portal user sees (RULING-portal-files-client-ui): released deliverables for their client (client-wide, or for a job they hold), the
 * released client files of jobs they hold, and their OWN uploads in every state - held and refused so a refusal is explained, withdrawn so the
 * reason is. Another user's held, refused or withdrawn file is never listed, and nor is another client's. $1 organisation, $2 client, $3 user.
 */
const PORTAL_VISIBLE = `f.organisation_id = $1 AND f.client_id = $2
  AND ((f.status = 'released' AND ((f.job_id IS NULL AND f.direction = 'deliverable')
         OR f.job_id IN (SELECT g.job_id FROM nzi_console.portal_access_grants g WHERE g.organisation_id = $1 AND g.portal_user_id = $3 AND g.client_id = $2 AND g.revoked_at IS NULL)))
       OR (f.direction = 'client_upload' AND f.uploaded_by = $3))`;
/** The client never sees a storage identifier, a user id or a staff name: toRecord carries none, and who uploaded is "You", "A colleague" or "NZI" - who withdrew is never shown. */
const forClient = (row: FileRow, viewerId: string): PortalFileRecord => {
  const record = toRecord(row);
  // Never a user id or a staff name: "You", "A colleague" or "NZI".
  return { ...record, uploadedBy: record.uploadedByPrincipal === "staff" ? "NZI" : record.uploadedBy === viewerId ? "You" : "A colleague", deactivatedBy: null };
};

export function listPortalFiles(pool: PoolLike, principal: PortalPrincipal): Promise<PortalFileRecord[]> {
  return withTenantRead(pool, principal.organisationId, async (db) =>
    (await db.query<FileRow>(`SELECT ${COLUMNS} FROM nzi_console.portal_files f WHERE ${PORTAL_VISIBLE} ORDER BY f.uploaded_at DESC`,
      [principal.organisationId, principal.clientId, principal.userId])).rows.map((row) => forClient(row, principal.userId)));
}

type AuditRow = { actor_id: string; principal_type: "staff" | "portal" | "system"; action: string; reason: string | null; after_json: { status?: string; flag?: PortalFileFlag | null } | null; occurred_at: Date | string };
const scanDetail = (status: string | undefined, flag: PortalFileFlag | null | undefined) =>
  status === "released" ? "Clean" : status === "rejected" ? `Quarantined: ${flag ? PORTAL_FILE_FLAG_LABELS[flag] : "it did not pass the checks"}` : "Held while it is checked";

/** A file's audit rows as the client reads them. Pure, so what it shows - and does not - is testable without a database. */
export function portalFileHistory(rows: readonly AuditRow[], viewerId: string): PortalFileHistoryEntry[] {
  const entries: PortalFileHistoryEntry[] = [];
  for (const row of rows) {
    const at = new Date(row.occurred_at).toISOString();
    const who: PortalFileHistoryEntry["who"] = row.principal_type === "portal" ? (row.actor_id === viewerId ? "you" : "colleague") : "nzi";
    const status = row.after_json?.status, flag = row.after_json?.flag;
    switch (row.action) {
      case "portal_file_uploaded": case "client_file_delivered":
        entries.push({ at, who, action: row.action === "client_file_delivered" ? "shared" : "uploaded", detail: null });
        entries.push({ at, who: "nzi", action: "scanned", detail: scanDetail(status, flag) });
        if (status === "released") entries.push({ at, who: "nzi", action: "released", detail: null });
        break;
      case "client_file_rescanned":
        entries.push({ at, who: "nzi", action: "scanned", detail: scanDetail(status, flag) });
        if (status === "released") entries.push({ at, who: "nzi", action: "released", detail: null });
        break;
      case "portal_file_downloaded": case "client_file_downloaded": entries.push({ at, who, action: "downloaded", detail: null }); break;
      case "client_file_deactivated": entries.push({ at, who: "nzi", action: "withdrawn", detail: row.reason }); break;
      default: break; // anything else about the file is staff's business, not the client's
    }
  }
  return entries;
}

/**
 * One file's History for the portal user entitled to the file (the same rule as the list, so a file they cannot see has no history for them
 * either): uploaded, scanned, released, downloaded, withdrawn - who and when, "you", "a colleague" or "NZI", never a staff name.
 */
export function getPortalFileHistory(pool: PoolLike, principal: PortalPrincipal, fileId: string): Promise<PortalFileHistoryEntry[]> {
  return withTenantRead(pool, principal.organisationId, async (db) => {
    const visible = await db.query(`SELECT 1 FROM nzi_console.portal_files f WHERE ${PORTAL_VISIBLE} AND f.file_id = $4`, [principal.organisationId, principal.clientId, principal.userId, fileId]);
    if (!visible.rows[0]) throw new AuthorizationError("tenant", "That file is not available to your account.");
    const { rows } = await db.query<AuditRow>(
      `SELECT actor_id, principal_type, action, reason, after_json, occurred_at FROM nzi_console.audit_events
        WHERE organisation_id = $1 AND entity_type = 'portal_file' AND entity_id = $2 ORDER BY occurred_at, audit_event_id`, [principal.organisationId, fileId]);
    return portalFileHistory(rows, principal.userId);
  });
}
