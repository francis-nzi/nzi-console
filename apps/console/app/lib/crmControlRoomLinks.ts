import type { CrmDeadline, CrmRedBoxRow, CrmThread } from "@nzi/isolated-backend";

/**
 * Where the Control Room's rows go (BRIEF-crm-control-room-p2), in one place the page, the drawer and the tests share: a job, a
 * conversation (the message drawer, which is the URL `/?msg=<threadId>`), or the client's SRS or plan.
 */
export const threadHref = (threadId: string) => `/?msg=${encodeURIComponent(threadId)}`;

/** Where a conversation is read from, and where a reply goes: the SRS conversation through `srs.message.post`, any other through `client.message.post`. */
export function threadPaths(thread: Pick<CrmThread, "clientId" | "threadId" | "srs">): { read: string; reply: string } {
  const client = `/api/isolated/clients/${encodeURIComponent(thread.clientId)}`;
  const read = `${client}/threads/${encodeURIComponent(thread.threadId)}`;
  return { read, reply: thread.srs ? `${client}/srs-thread` : read };
}

const clientArea = (clientId: string, area: string) => `/clients/${encodeURIComponent(clientId)}?area=${area}`;
const jobHref = (jobId: string | null) => `/jobs/${encodeURIComponent(jobId ?? "")}`;

/** A Red box row's target and its action word. */
export function redBoxLink(row: Pick<CrmRedBoxRow, "kind" | "threadId" | "clientId" | "jobId">): { href: string; go: string } {
  if (row.kind === "unread" && row.threadId) return { href: threadHref(row.threadId), go: "Reply" };
  if (row.kind === "srs-review-request" && row.threadId) return { href: threadHref(row.threadId), go: "Reopen" };
  if (row.kind === "srs-review-overdue" || row.kind === "srs-review-today") return { href: clientArea(row.clientId, "srs"), go: "Review" };
  return { href: jobHref(row.jobId), go: row.kind === "awaiting-approval" ? "Approve" : "Open" };
}

export function deadlineHref(row: Pick<CrmDeadline, "kind" | "clientId" | "jobId">): string {
  return row.kind === "srs-review" ? clientArea(row.clientId, "srs") : row.kind === "action-due" ? clientArea(row.clientId, "strategies") : jobHref(row.jobId);
}
