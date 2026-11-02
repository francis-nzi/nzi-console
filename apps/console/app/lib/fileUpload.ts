import "server-only";
import { FileStorageUnavailableError, type StorageAdapter } from "@nzi/isolated-backend";
import { PORTAL_FILE_MAX_BYTES, type PortalFileIngest } from "@nzi/contracts";
import { portalFeatureEnabled } from "./portalFlags";

/**
 * The route half of a file upload: read one multipart file within the size limit, and answer for the failures that are the store's or the
 * request's rather than the file's. What the file *is* — its type, its scan — is the gate's (`ingestFile`), and the outcome is recorded by a command.
 * Dark until `portal-files` is on, and 404 while it is off, as the portal's other flagged surfaces are.
 */
export class FilesOffError extends Error { constructor() { super("Not found."); this.name = "FilesOffError"; } }
export const requirePortalFiles = (): void => { if (!portalFeatureEnabled("portal-files")) throw new FilesOffError(); };

export class UploadRequestError extends Error { constructor(readonly status: number, readonly code: string, message: string) { super(message); this.name = "UploadRequestError"; } }

export async function readUpload(request: Request): Promise<{ fileName: string; bytes: Uint8Array; fields: FormData }> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  // Refused before it is read into memory. (A file over the limit is not recorded: it was never stored, scanned or hashed.)
  if (declared > PORTAL_FILE_MAX_BYTES + 1024 * 1024) throw new UploadRequestError(413, "FILE_TOO_LARGE", `A file can be at most ${Math.floor(PORTAL_FILE_MAX_BYTES / (1024 * 1024))} MB.`);
  const fields = await request.formData().catch(() => { throw new UploadRequestError(400, "BAD_UPLOAD", "Send one file as a form upload."); });
  const file = fields.get("file");
  if (!(file instanceof File)) throw new UploadRequestError(400, "BAD_UPLOAD", "Send one file as a form upload.");
  if (file.size > PORTAL_FILE_MAX_BYTES) throw new UploadRequestError(413, "FILE_TOO_LARGE", `A file can be at most ${Math.floor(PORTAL_FILE_MAX_BYTES / (1024 * 1024))} MB.`);
  return { fileName: file.name, bytes: new Uint8Array(await file.arrayBuffer()), fields };
}

/** A replayed command means this arrival is a duplicate of one already recorded: its freshly stored copy is withdrawn, not left orphaned. */
export async function withdrawIfReplayed(adapter: StorageAdapter, ingest: PortalFileIngest, replayed: boolean): Promise<void> {
  if (replayed && ingest.externalItemId) await adapter.deactivate(ingest.externalItemId).catch(() => undefined);
}

/** The failures a file route answers for itself; the command's own are the callers' (`commandFailure`, `portalCommandFailure`). */
export function uploadFailure(error: unknown): Response | null {
  if (error instanceof FilesOffError) return Response.json({ code: "NOT_FOUND", message: "Not found." }, { status: 404 });
  if (error instanceof UploadRequestError) return Response.json({ code: error.code, message: error.message }, { status: error.status });
  if (error instanceof FileStorageUnavailableError) return Response.json({ code: "FILE_STORAGE_UNAVAILABLE", message: "File storage isn't available just now. Nothing was saved." }, { status: 503 });
  return null;
}
