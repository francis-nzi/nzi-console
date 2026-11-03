import "server-only";
import { configuredScanner, configuredStorageAdapter, ingestFile, type StorageAdapter } from "@nzi/isolated-backend";
import { PORTAL_FILE_MAX_BYTES, PORTAL_MESSAGE_MAX_ATTACHMENTS, type PortalFileIngest } from "@nzi/contracts";
import { requireConversations } from "./conversations";
import { FilesOffError, UploadRequestError } from "./fileUpload";
import { portalFeatureEnabled } from "./portalFlags";

/**
 * The route half of a message with attachments (RULING-portal-messages, M3). A message is JSON as it has always been; one that carries files is
 * a multipart form - `body` (and, for a new conversation, `jobId`, `subjectCode`, `title`) plus one or more `file` parts. Each file goes through
 * the one gate (`ingestFile`: sniffed, quarantined, scanned) before the command records the outcome with the message, in one transaction.
 *
 * Dark until `portal-conversations`, `portal-files` AND `portal-message-attachments` are all on: the files gate is the dependency, and
 * Conversations can go live without it. While any is off a multipart request is a 404, exactly as a file route is.
 */
export const attachmentsEnabled = (): boolean =>
  portalFeatureEnabled("portal-conversations") && portalFeatureEnabled("portal-files") && portalFeatureEnabled("portal-message-attachments");
export const requireAttachments = (): void => { requireConversations(); if (!attachmentsEnabled()) throw new FilesOffError(); };

export const isMultipart = (request: Request): boolean => (request.headers.get("content-type") ?? "").toLowerCase().startsWith("multipart/form-data");

export type MessageRequest = {
  /** The text fields, as sent (JSON body, or the form's non-file parts). */
  fields: Record<string, unknown>;
  /** Files already through the gate - to be recorded by the command, or withdrawn if it does not record them. */
  ingests: PortalFileIngest[];
  adapter: StorageAdapter | null;
};

/**
 * Read a message request. JSON: the fields, no files. Multipart: the fields and every `file` part, each ingested for `jobId` - the thread's own job
 * (null for a client-wide conversation), so an attachment lands with the conversation it was sent to. `jobIdFor` is asked only when files are present.
 */
export async function readMessageRequest(
  request: Request,
  scope: { organisationId: string; clientId: string; jobIdFor: (fields: Record<string, unknown>) => Promise<string | null> | string | null },
): Promise<MessageRequest> {
  if (!isMultipart(request)) return { fields: await request.json().catch(() => ({})) as Record<string, unknown>, ingests: [], adapter: null };
  requireAttachments();
  const declared = Number(request.headers.get("content-length") ?? "0");
  const ceiling = PORTAL_MESSAGE_MAX_ATTACHMENTS * PORTAL_FILE_MAX_BYTES + 1024 * 1024;
  if (declared > ceiling) throw new UploadRequestError(413, "FILE_TOO_LARGE", `A file can be at most ${Math.floor(PORTAL_FILE_MAX_BYTES / (1024 * 1024))} MB, and a message takes at most ${PORTAL_MESSAGE_MAX_ATTACHMENTS} attachments.`);
  const form = await request.formData().catch(() => { throw new UploadRequestError(400, "BAD_UPLOAD", "Send the message as a form."); });
  const fields: Record<string, unknown> = {};
  for (const [name, value] of form.entries()) if (typeof value === "string" && name !== "file") fields[name] = value;
  if ("jobId" in fields) fields.jobId = String(fields.jobId).trim() || null;
  const files = form.getAll("file").filter((entry): entry is File => entry instanceof File && entry.size > 0);
  if (files.length > PORTAL_MESSAGE_MAX_ATTACHMENTS) throw new UploadRequestError(400, "TOO_MANY_FILES", `A message takes at most ${PORTAL_MESSAGE_MAX_ATTACHMENTS} attachments.`);
  for (const file of files) if (file.size > PORTAL_FILE_MAX_BYTES) throw new UploadRequestError(413, "FILE_TOO_LARGE", `A file can be at most ${Math.floor(PORTAL_FILE_MAX_BYTES / (1024 * 1024))} MB.`);
  if (files.length === 0) return { fields, ingests: [], adapter: null };

  const jobId = await scope.jobIdFor(fields);
  const adapter = configuredStorageAdapter(), scanner = configuredScanner();
  const ingests: PortalFileIngest[] = [];
  try {
    for (const file of files) {
      ingests.push(await ingestFile({ adapter, scanner, organisationId: scope.organisationId, clientId: scope.clientId, jobId, fileName: file.name, bytes: new Uint8Array(await file.arrayBuffer()) }));
    }
  } catch (error) { await withdrawAll(adapter, ingests); throw error; }
  return { fields, ingests, adapter };
}

/** Best-effort: take freshly stored copies out of service (a refused or replayed command must not leave them orphaned). */
export async function withdrawAll(adapter: StorageAdapter | null, ingests: readonly PortalFileIngest[]): Promise<void> {
  if (!adapter) return;
  await Promise.all(ingests.map((ingest) => ingest.externalItemId ? adapter.deactivate(ingest.externalItemId).catch(() => undefined) : undefined));
}

/** Run a recording command for a message; if it throws, or was a replay of one already recorded, the copies stored for this attempt are withdrawn. */
export async function recordWithAttachments<T extends { replayed: boolean }>(message: MessageRequest, record: () => Promise<T>): Promise<T> {
  try {
    const outcome = await record();
    if (outcome.replayed) await withdrawAll(message.adapter, message.ingests);
    return outcome;
  } catch (error) { await withdrawAll(message.adapter, message.ingests); throw error; }
}
