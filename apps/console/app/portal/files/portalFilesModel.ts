import { PORTAL_FILE_CATEGORIES, PORTAL_FILE_CATEGORY_LABELS, PORTAL_FILE_FLAG_LABELS, type PortalFileCategory, type PortalFileHistoryEntry, type PortalFileRecord } from "@nzi/contracts";

/**
 * The client Files view's pure parts (RULING-portal-files-client-ui): how a file is grouped, labelled and filtered, so what the page shows
 * is testable without rendering it. The server decides what the client may see (`listPortalFiles`); nothing here widens that.
 */

/** What the client's own upload is called while it is checked, once it has passed, and if it could not be released. */
export type ScanLabel = "Scanning" | "Clean" | "Quarantined";

/** The scan state of a file, shown for the client's own uploads only (a colleague's or NZI's file is not theirs to read the scan of). */
export function scanLabel(file: Pick<PortalFileRecord, "status" | "direction" | "uploadedBy">): ScanLabel | null {
  if (file.direction !== "client_upload" || file.uploadedBy !== "You") return null;
  if (file.status === "released") return "Clean";
  if (file.status === "rejected") return "Quarantined";
  if (file.status === "quarantined") return "Scanning";
  return null; // withdrawn: its state is the withdrawal
}

/** A file is downloadable only once it has been released - the server refuses anything else; this just does not offer it. */
export const canDownload = (file: Pick<PortalFileRecord, "status">): boolean => file.status === "released";

/** The words beside a file that is not (or no longer) available: why, in the client's terms. */
/** `adviser` is how the organisation names itself to this client (D3b: its short name, or "your adviser"). */
export function unavailableNote(file: Pick<PortalFileRecord, "status" | "flag" | "deactivatedReason">, adviser: string): string | null {
  if (file.status === "deactivated") return file.deactivatedReason ? `Withdrawn by ${adviser}: ${file.deactivatedReason}` : `Withdrawn by ${adviser}`;
  if (file.status === "rejected") return `Quarantined - not available. ${file.flag ? PORTAL_FILE_FLAG_LABELS[file.flag] : "It did not pass the checks"}.`;
  if (file.status === "quarantined") return "Being checked - you can download it once it has passed.";
  return null;
}

export type FileGroup = { key: string; heading: string; jobs: Array<{ jobId: string | null; heading: string; files: PortalFileRecord[] }> };

/**
 * The two directions, each by job: "From you" (what the client sent) then "From NZI" (what NZI shared). A client-wide deliverable has no job
 * and sits under "All jobs". A group with nothing in it is not drawn. Newest first within a job, as the server sent them.
 */
export function groupFiles(files: readonly PortalFileRecord[], jobTitle: (jobId: string) => string, adviser: string): FileGroup[] {
  const make = (key: string, heading: string, direction: PortalFileRecord["direction"]): FileGroup => {
    const byJob = new Map<string | null, PortalFileRecord[]>();
    for (const file of files.filter((candidate) => candidate.direction === direction)) byJob.set(file.jobId, [...(byJob.get(file.jobId) ?? []), file]);
    const jobs = [...byJob.entries()]
      .sort(([a], [b]) => (a === null ? -1 : b === null ? 1 : jobTitle(a).localeCompare(jobTitle(b))))
      .map(([jobId, grouped]) => ({ jobId, heading: jobId === null ? "All jobs" : jobTitle(jobId), files: grouped }));
    return { key, heading, jobs };
  };
  return [make("from-you", "From you", "client_upload"), make("from-adviser", `From ${adviser}`, "deliverable")].filter((group) => group.jobs.length > 0);
}

export type CategoryFilter = PortalFileCategory | "all";
export const CATEGORY_FILTERS: ReadonlyArray<{ value: CategoryFilter; label: string }> = [
  { value: "all", label: "All" }, ...PORTAL_FILE_CATEGORIES.map((value) => ({ value, label: PORTAL_FILE_CATEGORY_LABELS[value] })),
];
export const filterByCategory = (files: readonly PortalFileRecord[], filter: CategoryFilter): PortalFileRecord[] => filter === "all" ? [...files] : files.filter((file) => file.category === filter);

export const HISTORY_ACTION_LABEL: Record<PortalFileHistoryEntry["action"], string> = {
  uploaded: "Uploaded", shared: "Shared", scanned: "Scanned", released: "Released", downloaded: "Downloaded", withdrawn: "Withdrawn",
};
export const historyWho = (who: PortalFileHistoryEntry["who"], Adviser: string): string => who === "you" ? "You" : who === "colleague" ? "A colleague" : Adviser;

export const fileSize = (bytes: number) => bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/** Whether a value read from the route is a list of files (verified before anything is drawn - a malformed answer is a failure, not an empty list). */
export function isPortalFileList(value: unknown): value is PortalFileRecord[] {
  return Array.isArray(value) && value.every((file) => !!file && typeof file === "object"
    && typeof (file as PortalFileRecord).fileId === "string" && typeof (file as PortalFileRecord).fileName === "string"
    && (PORTAL_FILE_CATEGORIES as readonly unknown[]).includes((file as PortalFileRecord).category));
}
export function isPortalFileHistory(value: unknown): value is PortalFileHistoryEntry[] {
  return Array.isArray(value) && value.every((entry) => !!entry && typeof entry === "object" && typeof (entry as PortalFileHistoryEntry).at === "string" && typeof (entry as PortalFileHistoryEntry).action === "string");
}
