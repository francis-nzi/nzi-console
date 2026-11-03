import {
  PORTAL_NOTICE_DEADLINE_DAYS, PORTAL_NOTICE_HORIZON_DAYS, PORTAL_NOTICE_LIST_CAP, PORTAL_NOTICE_UNREAD_WINDOW_DAYS,
  type CommandContext, type CommandInputMap, type PortalNotice, type PortalNoticeFeed,
} from "@nzi/contracts";
import type { PortalPrincipal } from "./auth";
import { listLivePortalBroadcasts } from "./portalBroadcasts";
import { clientCategoryGate } from "./portalProfile";
import { withTenantRead, type PoolLike, type Queryable } from "./postgres";
import { CommandValidationError, runPostgresCommand, type StoredOutcome } from "./postgresCommands";

/**
 * Portal Updates (RULING-portal-messages, M2) - the read model behind the Updates lane and the bell.
 *
 * **Nothing is stored or re-emitted for a notice.** Each is computed here, at read time, from a record that already exists:
 *  - a **report** is ready: a `published` report version of a job the user holds (`report_versions`);
 *  - **data** was accepted or queried: a reviewer's decision (`scope_row_review_history`) on an entry the *client* made, on a row their portal
 *    profile shows - grouped per job, decision and day. The reviewer's note is never read: a client is told a decision was made, not what staff wrote;
 *  - a **deadline**: the user's own data-entry window closes within {@link PORTAL_NOTICE_DEADLINE_DAYS} days (`portal_access_grants`);
 *  - a **broadcast**: what is live for this client now, through the broadcasts' own read (`listLivePortalBroadcasts`).
 *
 * **Scope:** a job's notices only for a job the user holds a live grant on; a broadcast to everyone or to this client; never another client's.
 * **Seen:** one watermark per user (`portal_notice_seen`). Unread = newer than the watermark and within {@link PORTAL_NOTICE_UNREAD_WINDOW_DAYS} days.
 * The words are not written here: the facts are returned and the page words them, so the organisation is named from its profile (D3b).
 */
const DAY = 86_400_000;
const iso = (value: Date | string) => new Date(value).toISOString();
/** The calendar day (YYYY-MM-DD) a moment falls on in London - the platform's day (NZC-105). */
const londonDay = (value: Date | string) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date(value));

type Tag = { code: string; label: string };
async function subjectTags(db: Queryable, organisationId: string): Promise<Map<string, string>> {
  const rows = (await db.query<{ subject_code: string; label: string }>(`SELECT subject_code, label FROM nzi_console.portal_thread_subjects WHERE organisation_id = $1`, [organisationId])).rows;
  return new Map(rows.map((row) => [row.subject_code, row.label]));
}

export function getPortalNotices(pool: PoolLike, principal: PortalPrincipal, now = new Date()): Promise<PortalNoticeFeed> {
  return withTenantRead(pool, principal.organisationId, async (db) => {
    const org = principal.organisationId, clientId = principal.clientId, userId = principal.userId;
    const horizon = new Date(now.getTime() - PORTAL_NOTICE_HORIZON_DAYS * DAY).toISOString();
    const tags = await subjectTags(db, org);
    const tag = (code: string, fallback: string): Tag => ({ code, label: tags.get(code) ?? fallback });
    const notices: Array<Omit<PortalNotice, "unread">> = [];

    // The jobs this user holds, and the window of each grant.
    const grants = (await db.query<{ grant_id: string; job_id: string; job_number: string; starts_at: Date | null; expires_at: Date | null }>(
      `SELECT g.grant_id, g.job_id, j.job_number, g.data_entry_starts_at AS starts_at, g.data_entry_expires_at AS expires_at
         FROM nzi_console.portal_access_grants g
         JOIN nzi_console.portal_users u ON (u.organisation_id, u.portal_user_id, u.client_id) = (g.organisation_id, g.portal_user_id, g.client_id)
         JOIN nzi_console.jobs j ON (j.organisation_id, j.job_id, j.client_id) = (g.organisation_id, g.job_id, g.client_id)
        WHERE g.organisation_id = $1 AND g.portal_user_id = $2 AND g.client_id = $3 AND g.revoked_at IS NULL AND u.status = 'active'`, [org, userId, clientId])).rows;
    const jobIds = grants.map((grant) => grant.job_id);
    const numberOf = new Map(grants.map((grant) => [grant.job_id, grant.job_number]));

    if (jobIds.length > 0) {
      // A report is ready.
      const reports = (await db.query<{ report_version_id: string; job_id: string; published_at: Date; scope_kind: string }>(
        `SELECT r.report_version_id, r.job_id, r.published_at, r.scope_kind FROM nzi_console.report_versions r
          WHERE r.organisation_id = $1 AND r.job_id = ANY($2) AND r.status = 'published' AND r.published_at > $3`, [org, jobIds, horizon])).rows;
      const reportsTag = tag("reports", "Reports");
      for (const report of reports) {
        notices.push({
          noticeKey: `report:${report.report_version_id}`, kind: "report", at: iso(report.published_at), subjectCode: reportsTag.code, subjectLabel: reportsTag.label,
          jobId: report.job_id, jobNumber: numberOf.get(report.job_id) ?? null,
          detail: { kind: "report", reportVersionId: report.report_version_id, scopeLabel: report.scope_kind === "sites" ? "selected sites" : null },
          action: { label: "Review the report", view: "reports", path: "/portal/reports", externalUrl: null },
        });
      }

      // A reviewer decided on the client's own entries (only rows their portal profile shows; the note is never read).
      const gate = await clientCategoryGate(db, clientId);
      const decisions = (await db.query<{ job_id: string; decision: "approved" | "rejected"; occurred_at: Date; category_code: string | null; scope: string }>(
        `SELECT h.job_id, h.decision, h.occurred_at, r.category_code, r.scope
           FROM nzi_console.scope_row_review_history h
           JOIN nzi_console.job_scope_rows r ON (r.organisation_id, r.scope_row_id) = (h.organisation_id, h.scope_row_id)
          WHERE h.organisation_id = $1 AND h.job_id = ANY($2) AND h.occurred_at > $3 AND r.provenance_json ->> 'capturedAs' = 'client-portal'`, [org, jobIds, horizon])).rows
        .filter((row) => gate.shows(row.category_code?.trim() || (/^3\.\d+$/.test(row.scope) ? row.scope : null), row.scope));
      const grouped = new Map<string, { jobId: string; decision: "approved" | "rejected"; day: string; count: number; at: Date }>();
      for (const row of decisions) {
        const day = londonDay(row.occurred_at), key = `${row.job_id}:${row.decision}:${day}`;
        const entry = grouped.get(key);
        if (entry) { entry.count += 1; if (row.occurred_at > entry.at) entry.at = row.occurred_at; } else grouped.set(key, { jobId: row.job_id, decision: row.decision, day, count: 1, at: row.occurred_at });
      }
      const dataTag = tag("data", "Data");
      for (const [key, entry] of grouped) {
        notices.push({
          noticeKey: `data:${key}`, kind: "data", at: iso(entry.at), subjectCode: dataTag.code, subjectLabel: dataTag.label, jobId: entry.jobId, jobNumber: numberOf.get(entry.jobId) ?? null,
          detail: { kind: "data", decision: entry.decision, count: entry.count },
          action: { label: "Open your data", view: "data", path: `/portal/jobs/${encodeURIComponent(entry.jobId)}/data`, externalUrl: null },
        });
      }

      // A data-entry window about to close (the user's own grant).
      for (const grant of grants) {
        if (!grant.expires_at) continue;
        const closes = new Date(grant.expires_at).getTime();
        if (closes <= now.getTime() || closes > now.getTime() + PORTAL_NOTICE_DEADLINE_DAYS * DAY) continue;
        if (grant.starts_at && new Date(grant.starts_at).getTime() > now.getTime()) continue;
        const cameIntoView = Math.max(closes - PORTAL_NOTICE_DEADLINE_DAYS * DAY, grant.starts_at ? new Date(grant.starts_at).getTime() : 0);
        notices.push({
          noticeKey: `deadline:${grant.grant_id}:${londonDay(grant.expires_at)}`, kind: "deadline", at: new Date(cameIntoView).toISOString(), subjectCode: dataTag.code, subjectLabel: dataTag.label,
          jobId: grant.job_id, jobNumber: grant.job_number, detail: { kind: "deadline", closesOn: londonDay(grant.expires_at) },
          action: { label: "Open your data", view: "data", path: `/portal/jobs/${encodeURIComponent(grant.job_id)}/data`, externalUrl: null },
        });
      }
    }

    // A broadcast that is live for this client (the broadcasts' own read - to everyone or to this client).
    const generalTag = tag("general", "General");
    for (const broadcast of await listLivePortalBroadcasts(db, clientId)) {
      if (new Date(broadcast.startsAt) <= new Date(horizon)) continue;
      const internal = broadcast.link?.url.startsWith("/") ?? false;
      notices.push({
        noticeKey: `broadcast:${broadcast.broadcastId}`, kind: "broadcast", at: broadcast.startsAt, subjectCode: generalTag.code, subjectLabel: generalTag.label, jobId: null, jobNumber: null,
        detail: { kind: "broadcast", broadcastId: broadcast.broadcastId, title: broadcast.title, body: broadcast.body, style: broadcast.style },
        action: broadcast.link ? { label: broadcast.link.label, view: null, path: internal ? broadcast.link.url : null, externalUrl: internal ? null : broadcast.link.url } : null,
      });
    }

    const watermark = (await db.query<{ seen_through: Date }>(`SELECT seen_through FROM nzi_console.portal_notice_seen WHERE organisation_id = $1 AND portal_user_id = $2`, [org, userId])).rows[0]?.seen_through ?? null;
    const unreadAfter = Math.max(watermark ? new Date(watermark).getTime() : 0, now.getTime() - PORTAL_NOTICE_UNREAD_WINDOW_DAYS * DAY);
    const sorted = notices.sort((a, b) => b.at.localeCompare(a.at) || a.noticeKey.localeCompare(b.noticeKey)).slice(0, PORTAL_NOTICE_LIST_CAP)
      .map((notice): PortalNotice => ({ ...notice, unread: new Date(notice.at).getTime() > unreadAfter }));
    return { notices: sorted, unread: sorted.filter((notice) => notice.unread).length, seenThrough: watermark ? iso(watermark) : null };
  });
}

/** The user has seen the feed through a moment (the newest notice they were shown). Moves the watermark forward only, and never past now. */
export function markPortalNoticesSeen(pool: PoolLike, input: CommandInputMap["portal.notices.seen"], context: CommandContext): Promise<StoredOutcome<Record<string, unknown>>> {
  return runPostgresCommand(pool, "portal.notices.seen", input, context, async (db) => {
    if (input.clientId !== context.portal!.clientId) throw new CommandValidationError([{ field: "clientId", code: "NOT_FOUND", message: "That is not your organisation." }]);
    const requested = new Date(input.seenThrough);
    // Never into the future: a notice that has not happened cannot have been seen.
    const through = new Date(Math.min(requested.getTime(), Date.now())).toISOString();
    const stored = (await db.query<{ seen_through: Date }>(
      `INSERT INTO nzi_console.portal_notice_seen (organisation_id, portal_user_id, seen_through) VALUES ($1,$2,$3)
       ON CONFLICT (organisation_id, portal_user_id) DO UPDATE SET seen_through = GREATEST(portal_notice_seen.seen_through, EXCLUDED.seen_through), updated_at = now()
       RETURNING seen_through`, [context.organisationId, context.actorId, through])).rows[0]!;
    return { data: { clientId: input.clientId, seenThrough: iso(stored.seen_through) }, entityType: "portal_notice_seen", entityId: context.actorId, topic: "portal.notices.seen" };
  });
}
