"use client";

import React, { useEffect, useMemo, useState } from "react";
import type { PortalNotice } from "@nzi/contracts";
import { useOrganisationName } from "../../lib/OrganisationNameProvider";
import { formatDate } from "../../lib/formatDate";
import { usePortalSurface } from "../portalSurface";
import { shellNav } from "../shell/shellNav";
import { actionHref, newestAt, noticeText } from "./noticesModel";
import { useNotices } from "./useNotices";

/**
 * The Updates feed (RULING-portal-messages, M2) - the same list in the Messages page's Updates lane and in the bell's panel. Each notice is a
 * subject tag, a statement and one direct action; there is nothing to reply to. Opening the feed marks it seen through the newest notice shown
 * (the audited portal.notices.seen), which clears the bell; the notices that were new stay marked for this opening so the user can see which.
 */
export function PortalUpdatesFeed({ compact = false }: { compact?: boolean }) {
  const org = useOrganisationName();
  const surface = usePortalSurface();
  const { notices, markSeen } = useNotices(true);
  const [fresh, setFresh] = useState<ReadonlySet<string> | null>(null);
  // The views this client is offered right now (flag-gated as the rail is): an action never leads to a page that is switched off.
  const available = useMemo(() => new Set<string>(shellNav("job", surface.link).map((item) => item.view)), [surface]);

  useEffect(() => {
    if (notices.state !== "ready" || fresh !== null) return;
    setFresh(new Set(notices.feed.notices.filter((notice) => notice.unread).map((notice) => notice.noticeKey)));
    const through = newestAt(notices.feed.notices);
    if (notices.feed.unread > 0 && through) void markSeen(through);
  }, [notices, fresh, markSeen]);

  if (notices.state === "loading") return <p className="nz-pd-meta" role="status">Loading your updates…</p>;
  if (notices.state === "failed") return <div className="nzp-files-notice warn" role="alert">Your updates could not be loaded, so none are shown rather than a list that might be wrong.</div>;
  const list = notices.feed.notices;
  if (list.length === 0) return <p className="nz-pd-meta">Nothing new. Updates from {org.short} — reports, decisions on your data, deadlines and notices — appear here.</p>;

  return (
    <ul className={`nzp-notices${compact ? " compact" : ""}`} aria-label="Updates">
      {list.map((notice: PortalNotice) => {
        const text = noticeText(notice, org.short), action = actionHref(notice, surface.link, available), isNew = fresh?.has(notice.noticeKey) ?? notice.unread;
        return (
          <li key={notice.noticeKey} className={`nzp-notice${isNew ? " new" : ""}${notice.detail.kind === "broadcast" && notice.detail.style === "warning" ? " warn" : ""}`}>
            <div className="nzp-notice-top"><span className="nzp-conv-tag">{notice.subjectLabel}</span>{isNew ? <span className="nzp-notice-new">New</span> : null}<span className="nz-hint">{formatDate(notice.at)}</span></div>
            <b>{text.title}</b>
            {text.body ? <p>{text.body}</p> : null}
            {action ? <a className="nz-btn sm" href={action.href} {...(action.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}>{action.label}</a> : null}
          </li>
        );
      })}
    </ul>
  );
}
