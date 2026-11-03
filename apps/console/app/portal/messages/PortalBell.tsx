"use client";

import React, { useEffect, useRef, useState } from "react";
import { bellLabel } from "./noticesModel";
import { PortalUpdatesFeed } from "./PortalUpdatesFeed";
import { useNotices } from "./useNotices";

/**
 * The top-bar bell (RULING-portal-messages, M2): the Updates feed from any portal page, with the unread count. Opening it shows the same feed the
 * Messages page's Updates lane shows and marks it seen. It only counts - it never writes anything until it is opened.
 */
export function PortalBell() {
  const { notices } = useNotices(true);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);
  const unread = notices.state === "ready" ? notices.feed.unread : 0;
  const label = bellLabel(unread);

  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => { if (root.current && !root.current.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", escape); };
  }, [open]);

  return (
    <div className="nzp-bell" ref={root}>
      <button type="button" className="nzp-bell-btn" aria-haspopup="dialog" aria-expanded={open} aria-label={unread > 0 ? `Updates, ${unread} unread` : "Updates"} onClick={() => setOpen((value) => !value)}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 8 3 8H3s3-1 3-8" /><path d="M10 21a2 2 0 0 0 4 0" /></svg>
        {label ? <span className="nzp-bell-count" aria-hidden="true">{label}</span> : null}
      </button>
      {open ? <div className="nzp-bell-panel" role="dialog" aria-label="Updates"><PortalUpdatesFeed compact /></div> : null}
    </div>
  );
}
