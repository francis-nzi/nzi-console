import { PORTAL_NOTICE_KINDS, type PortalNotice, type PortalNoticeFeed } from "@nzi/contracts";
import { formatDate } from "../../lib/formatDate";

/**
 * The Updates lane's pure parts (RULING-portal-messages, M2): how a notice is worded, where its one action leads, and the checks a route's answer
 * passes before it is drawn. The server returns the facts; the words are built here so the organisation is named from its profile (D3b), dates read
 * dd/mm/yyyy (NZC-040), and there is no money in a notice (NZC-120).
 */

/** The statement a notice makes. `adviser` is how the organisation names itself to this client (its short name, or "your adviser"). */
export function noticeText(notice: PortalNotice, adviser: string): { title: string; body: string | null } {
  const job = notice.jobNumber ? ` for ${notice.jobNumber}` : "";
  const detail = notice.detail;
  switch (detail.kind) {
    case "report":
      return { title: `Your report${job}${detail.scopeLabel ? ` (${detail.scopeLabel})` : ""} is ready to review`, body: `${adviser} has published it. Read it, approve it or ask a question.` };
    case "data":
      return detail.decision === "approved"
        ? { title: `${detail.count === 1 ? "An entry" : `${detail.count} entries`}${job ? ` on ${notice.jobNumber}` : ""} ${detail.count === 1 ? "was" : "were"} accepted`, body: null }
        : { title: `${adviser} has ${detail.count === 1 ? "a question about an entry" : `questions about ${detail.count} entries`}${job ? ` on ${notice.jobNumber}` : ""}`, body: "Open your data to see which and to respond." };
    case "deadline":
      return { title: `Data entry${job ? ` for ${notice.jobNumber}` : ""} closes on ${formatDate(detail.closesOn)}`, body: "Anything you still need to add should go in before then." };
    case "broadcast":
      return { title: detail.title, body: detail.body };
  }
}

/** The views the portal offers this client right now (the rail's own list), so an action never leads to a page that is switched off. */
export function actionHref(notice: PortalNotice, link: (path: string) => string | null, available: ReadonlySet<string>): { label: string; href: string; external: boolean } | null {
  const action = notice.action;
  if (!action) return null;
  if (action.externalUrl) return { label: action.label, href: action.externalUrl, external: true };
  if (!action.path) return null;
  if (action.view && !available.has(action.view)) return null;
  const href = link(action.path);
  return href ? { label: action.label, href, external: false } : null;
}

/** "3" on the bell, "9+" past nine, nothing at zero. */
export const bellLabel = (unread: number): string | null => unread <= 0 ? null : unread > 9 ? "9+" : String(unread);

/** The newest moment among the notices shown - what the user has seen when they have read the list. Null for an empty list. */
export const newestAt = (notices: readonly PortalNotice[]): string | null => notices.reduce<string | null>((newest, notice) => newest === null || notice.at > newest ? notice.at : newest, null);

const str = (value: unknown): value is string => typeof value === "string";
export function isPortalNotice(value: unknown): value is PortalNotice {
  if (!value || typeof value !== "object") return false;
  const n = value as Partial<PortalNotice>;
  return str(n.noticeKey) && str(n.at) && str(n.subjectLabel) && typeof n.unread === "boolean" && (PORTAL_NOTICE_KINDS as readonly unknown[]).includes(n.kind)
    && !!n.detail && typeof n.detail === "object" && n.detail.kind === n.kind;
}
export function isNoticeFeed(value: unknown): value is PortalNoticeFeed {
  if (!value || typeof value !== "object") return false;
  const f = value as Partial<PortalNoticeFeed>;
  return Array.isArray(f.notices) && f.notices.every(isPortalNotice) && typeof f.unread === "number" && (f.seenThrough === null || str(f.seenThrough));
}

/** Fired on the window when the seen state changes, so the bell and the lane (which read the same feed) stay in step. */
export const NOTICES_CHANGED = "nzp-notices-changed";
