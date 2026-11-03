import { PORTAL_THREAD_STATES, type PortalMessage, type PortalThreadDetail, type PortalThreadState, type PortalThreadSubject, type PortalThreadSummary } from "@nzi/contracts";
import { formatDate } from "../../lib/formatDate";

/**
 * The Conversations lane's pure parts (RULING-portal-messages, M1): how a state, a target and a message author are worded, and the checks a
 * route's answer must pass before anything is drawn. The client's wording names the organisation as its profile does (D3b); the staff
 * wording is internal. Nothing here widens what the server decided the reader may see.
 */

/** The state as the client reads it. `adviser` is how the organisation names itself to this client (its short name, or "your adviser"). */
export function clientStateLabel(state: PortalThreadState, adviser: string): string {
  return state === "awaiting_nzi" ? `Awaiting ${adviser}` : state === "awaiting_client" ? "Awaiting you" : state === "resolved" ? "Resolved" : "Open";
}
/** The state as staff read it. */
export const STAFF_STATE_LABEL: Record<PortalThreadState, string> = { open: "Open", awaiting_nzi: "Awaiting adviser", awaiting_client: "Awaiting client", resolved: "Resolved" };

/**
 * The response target in words: only while the client is waiting on the adviser, as a date to look at (dd/mm/yyyy) - never as a promise or a
 * countdown. `null` when there is nothing to say.
 */
export function targetNote(thread: Pick<PortalThreadSummary, "state" | "responseTargetAt">, audience: "client" | "staff", adviser = "your adviser"): string | null {
  if (thread.state !== "awaiting_nzi" || !thread.responseTargetAt) return null;
  return audience === "client" ? `A reply from ${adviser} is expected by ${formatDate(thread.responseTargetAt)}` : `Reply target ${formatDate(thread.responseTargetAt)}`;
}

/** Who wrote a message, from the client's side. */
export const clientAuthorLabel = (author: PortalMessage["author"], adviser: string): string => author === "you" ? "You" : author === "colleague" ? "A colleague" : adviser;

/** The thread to show first: the one the reader has most to read in, else the latest. */
export function pickThread(threads: readonly PortalThreadSummary[], current: string | null): string | null {
  if (current && threads.some((thread) => thread.threadId === current)) return current;
  return (threads.find((thread) => thread.unread > 0) ?? threads[0])?.threadId ?? null;
}

/** Filter a list by subject tag, then order it as the server did (latest activity first). */
export const filterBySubject = (threads: readonly PortalThreadSummary[], code: string | "all"): PortalThreadSummary[] => code === "all" ? [...threads] : threads.filter((thread) => thread.subjectCode === code);

const isStr = (value: unknown): value is string => typeof value === "string";
export function isThreadSummary(value: unknown): value is PortalThreadSummary {
  if (!value || typeof value !== "object") return false;
  const t = value as Partial<PortalThreadSummary>;
  return isStr(t.threadId) && isStr(t.title) && isStr(t.subjectCode) && isStr(t.subjectLabel) && isStr(t.lastMessageAt) && typeof t.unread === "number" && typeof t.messageCount === "number"
    && (PORTAL_THREAD_STATES as readonly unknown[]).includes(t.state) && (t.scope === "client" || t.scope === "job");
}
export const isThreadList = (value: unknown): value is PortalThreadSummary[] => Array.isArray(value) && value.every(isThreadSummary);
export const isSubjectList = (value: unknown): value is PortalThreadSubject[] => Array.isArray(value) && value.every((s) => !!s && typeof s === "object" && isStr((s as PortalThreadSubject).code) && isStr((s as PortalThreadSubject).label));
export function isThreadDetail(value: unknown): value is PortalThreadDetail {
  if (!value || typeof value !== "object") return false;
  const d = value as Partial<PortalThreadDetail>;
  return isThreadSummary(d.thread) && Array.isArray(d.messages) && d.messages.every((m) => !!m && typeof m === "object" && isStr(m.messageId) && isStr(m.body) && isStr(m.createdAt) && typeof m.seq === "number");
}
