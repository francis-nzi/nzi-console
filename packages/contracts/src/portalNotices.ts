/**
 * Portal Updates (RULING-portal-messages, M2): the read-only notices lane next to Conversations - what has happened that the client should know,
 * derived from events that already exist and re-emitted by nothing.
 *
 * ## What a notice is
 * A tag, a statement and **one** direct action (a deep link to the thing). No replies - a notice is not a thread. It is computed at read time
 * from the system's own records: a published report, a reviewer's decision on the client's own entries, a data-entry window about to close, a
 * broadcast that is live. Nothing is copied into a notices table and no event is emitted for it, so there is nothing to keep in step.
 *
 * ## Scope
 * Client-wide (a broadcast) or on a job the user holds (the rest). A user never sees another client's, nor a job they do not hold, nor a row the
 * client's portal profile hides, and never a reviewer's note - only that a decision was made.
 *
 * ## Seen
 * One watermark per user: everything at or before `seenThrough` is seen. Unread counts only the last {@link PORTAL_NOTICE_UNREAD_WINDOW_DAYS}
 * days, so nobody opens a new feature to a backlog.
 */

export const PORTAL_NOTICE_KINDS = ["report", "data", "deadline", "broadcast"] as const;
export type PortalNoticeKind = (typeof PORTAL_NOTICE_KINDS)[number];

/** A notice older than this is not listed. */
export const PORTAL_NOTICE_HORIZON_DAYS = 60;
/** Only a notice newer than this can be unread, whatever the watermark says. */
export const PORTAL_NOTICE_UNREAD_WINDOW_DAYS = 14;
/** A data-entry window that closes within this many days is a deadline notice. */
export const PORTAL_NOTICE_DEADLINE_DAYS = 14;
export const PORTAL_NOTICE_LIST_CAP = 50;

/** The facts a notice states. The words are built where they are shown, so the organisation is named from its profile (D3b). */
export type PortalNoticeDetail =
  | { kind: "report"; reportVersionId: string; scopeLabel: string | null }
  | { kind: "data"; decision: "approved" | "rejected"; count: number }
  | { kind: "deadline"; closesOn: string }
  | { kind: "broadcast"; broadcastId: string; title: string; body: string; style: "info" | "warning" | "success" | "promo" };

/** Where the single action leads: one of the portal's own views (shown only if that view is on for this client), or an address a broadcast carries. */
export type PortalNoticeAction = { label: string; view: "reports" | "data" | null; path: string | null; externalUrl: string | null };

export type PortalNotice = {
  /** Stable for the same fact: the same notice has the same key every time it is read. */
  noticeKey: string;
  kind: PortalNoticeKind;
  /** When it happened (for a deadline: when it came into view). */
  at: string;
  subjectCode: string; subjectLabel: string;
  jobId: string | null; jobNumber: string | null;
  detail: PortalNoticeDetail;
  action: PortalNoticeAction | null;
  unread: boolean;
};

export type PortalNoticeFeed = { notices: PortalNotice[]; unread: number; seenThrough: string | null };
