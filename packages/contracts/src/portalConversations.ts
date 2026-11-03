/**
 * Portal conversations (RULING-portal-messages, M1): a client's two-way threads with their adviser, tagged by subject, owned by a member of
 * staff, with a state and a surfaced (not enforced) response target. Defined once, here: the commands validate against it, the backend
 * enforces the transitions and the Conversations lane and the staff surface draw from it.
 *
 * ## The model
 * A **thread** has a subject tag (a CRM-configurable lookup, seeded Data / Reports / SRS / Actions / General), a scope (the whole client, or
 * one job), an owner (staff) and a state. A **message** is append-only; nothing is edited or deleted. The report page's Messages tab and
 * these threads are one conversation, not two: a report's comments are mirrored in and out (`reportVersionId` on the thread).
 *
 * ## State
 * Open (neutral - set by staff) · Awaiting <adviser> (the client spoke last) · Awaiting client (staff spoke last) · Resolved (staff close it;
 * a new message from either side reopens it). A client post moves the thread to Awaiting adviser and sets the response target; a staff post
 * moves it to Awaiting client and clears it. The target is a date to look at - nothing is enforced or escalated in v1.
 *
 * ## Who is named
 * A message names its author by id only; a name is joined when read, so an erased person's name goes with their identity. The client sees
 * "You", "A colleague" or their adviser (in the organisation's own words), never a staff name.
 */

export const PORTAL_THREAD_STATES = ["open", "awaiting_nzi", "awaiting_client", "resolved"] as const;
export type PortalThreadState = (typeof PORTAL_THREAD_STATES)[number];
export const PORTAL_THREAD_SCOPES = ["client", "job"] as const;
export type PortalThreadScope = (typeof PORTAL_THREAD_SCOPES)[number];

/** The subject tags every organisation starts with (the lookup is theirs to change). */
export const DEFAULT_PORTAL_THREAD_SUBJECTS: ReadonlyArray<{ code: string; label: string; sortOrder: number }> = [
  { code: "data", label: "Data", sortOrder: 10 }, { code: "reports", label: "Reports", sortOrder: 20 }, { code: "srs", label: "SRS", sortOrder: 30 },
  { code: "actions", label: "Actions", sortOrder: 40 }, { code: "general", label: "General", sortOrder: 50 },
];
export const PORTAL_SUBJECT_CODE_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;

export const PORTAL_MESSAGE_MAX = 4000;
export const PORTAL_THREAD_TITLE_MAX = 160;
/** The response target, in working days from the client's last message. A date to look at, not an obligation enforced here. */
export const PORTAL_RESPONSE_TARGET_WORKING_DAYS = 2; // computed by `nzi_console.portal_response_target` (migration 0201) - one definition, in the database

export type PortalThreadSubject = { code: string; label: string; sortOrder: number; active: boolean };

/** A thread as the list draws it. `ownerName`, `startedByName` and `staff*` fields exist on the staff read only. */
export type PortalThreadSummary = {
  threadId: string; clientId: string; scope: PortalThreadScope; jobId: string | null; jobNumber: string | null;
  subjectCode: string; subjectLabel: string; title: string; state: PortalThreadState;
  /** The report version this thread is the conversation of, when it came from (or is mirrored to) a report's comments. */
  reportVersionId: string | null;
  messageCount: number; lastMessageAt: string; createdAt: string;
  /** The date a reply is looked for by: set while the client is waiting on the adviser, otherwise null. Surfaced, not enforced. */
  responseTargetAt: string | null;
  /** Client read: messages from others since this user last read. Staff read: messages from the client since staff last replied. */
  unread: number;
  /** Staff read only. */
  ownerId?: string | null; ownerName?: string | null;
  /** Staff read only: the version a staff change is guarded by (client.thread.update `expectedVersion`). */
  version?: number;
};

/** Who wrote a message, from the reader's side. */
export type PortalMessageAuthor = "you" | "colleague" | "adviser";
export type PortalMessage = {
  messageId: string; seq: number; body: string; createdAt: string;
  /** Client read: you / a colleague / the adviser. Staff read: portal or staff, with the name below. */
  author: PortalMessageAuthor;
  authorPrincipal: "portal" | "staff";
  /** Staff read only - joined at read from the person's own record, never stored with the message. */
  authorName?: string | null;
};

export type PortalThreadDetail = { thread: PortalThreadSummary; messages: PortalMessage[] };

/** The next state after a post: who spoke last decides who is awaited. */
export function stateAfterPost(author: "portal" | "staff"): PortalThreadState { return author === "portal" ? "awaiting_nzi" : "awaiting_client"; }
