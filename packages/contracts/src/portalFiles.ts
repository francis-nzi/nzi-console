/**
 * Portal files — what a file in the portal is, in both directions (BRIEF-portal-files-secure-upload-storage; NZC-046's "virus-scanned
 * uploads" made real). Defined once, here: the commands validate against it, the backend's gate enforces it and the Files tab draws from it.
 *
 * ## The guarantee
 * A file is **quarantined on arrival** and servable only once it is **released**. No scan is perfect, so the guarantee is the gate — a
 * file that has not passed is never served, to staff or client — not the scanner. Download is a **signed, time-limited URL** issued per
 * access and audited; there is no durable link.
 *
 * ## The two directions
 * `client_upload` (client → NZI: evidence, invoices, EPDs) and `deliverable` (NZI → client). Both are tenant-scoped (organisation, client,
 * optionally job), deactivated and never deleted.
 */

/** Where the bytes live. A new provider is a new value here (and in the migration's CHECK) plus one adapter — never a schema rewrite. */
export const FILE_STORAGE_PROVIDERS = ["sharepoint", "local"] as const;
export type FileStorageProvider = (typeof FILE_STORAGE_PROVIDERS)[number];

export const PORTAL_FILE_DIRECTIONS = ["client_upload", "deliverable"] as const;
export type PortalFileDirection = (typeof PORTAL_FILE_DIRECTIONS)[number];

/** quarantined: held, servable by no one · released: passed the gate · rejected: failed it, flagged · deactivated: withdrawn, kept. */
export const PORTAL_FILE_STATUSES = ["quarantined", "released", "rejected", "deactivated"] as const;
export type PortalFileStatus = (typeof PORTAL_FILE_STATUSES)[number];

/** Why a file did not pass. Stored with the record so a flag says what happened. */
export const PORTAL_FILE_FLAGS = ["infected", "oversize", "type_not_allowed", "executable", "macro", "empty", "scan_inconclusive", "scan_failed"] as const;
export type PortalFileFlag = (typeof PORTAL_FILE_FLAGS)[number];

/** The most one upload may be. */
export const PORTAL_FILE_MAX_BYTES = 25 * 1024 * 1024;
/** A signed download URL lives this long, at most. Re-signed per access. */
export const PORTAL_FILE_URL_TTL_SECONDS = 120;
export const PORTAL_FILE_URL_TTL_MAX_SECONDS = 300;

/** The sniffed types a client or staff may upload — by content, never by extension. Anything else is refused. */
export const PORTAL_FILE_ALLOWED_TYPES = ["application/pdf", "image/png", "image/jpeg", "text/csv", "text/plain",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation"] as const;
export type PortalFileType = (typeof PORTAL_FILE_ALLOWED_TYPES)[number];

/** A file as the Files tab and the portal list it: no storage identifiers, no bytes. */
export type PortalFileRecord = {
  fileId: string; clientId: string; jobId: string | null; direction: PortalFileDirection; status: PortalFileStatus;
  fileName: string; contentType: string; sizeBytes: number; sha256: string;
  flag: PortalFileFlag | null; flagDetail: string | null;
  uploadedBy: string; uploadedByPrincipal: "staff" | "portal"; uploadedAt: string;
  releasedAt: string | null; deactivatedAt: string | null; deactivatedBy: string | null;
};

/** The ingest gate's own record of one arrival, handed to the recording command (the bytes stay in the adapter). */
export type PortalFileIngest = {
  /** Server-assigned id, fixed before the bytes are stored so a replay finds the same record. */
  fileId: string;
  jobId: string | null;
  fileName: string; contentType: string; sizeBytes: number; sha256: string;
  storageProvider: FileStorageProvider; externalItemId: string | null;
  status: PortalFileStatus; flag: PortalFileFlag | null; flagDetail: string | null;
};

/** A file name as stored and shown: a leaf name only, no path, no control characters, bounded. */
export function safeFileName(raw: string): string {
  const leaf = raw.split(/[\\/]/).pop() ?? "";
  const cleaned = leaf.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "").replace(/\s+/g, " ").trim().replace(/^\.+/, "");
  return (cleaned || "file").slice(0, 180);
}
