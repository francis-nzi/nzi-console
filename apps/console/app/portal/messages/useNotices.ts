"use client";

import { useCallback, useEffect, useState } from "react";
import type { PortalNoticeFeed } from "@nzi/contracts";
import { postBrowserCommand } from "@nzi/api-client";
import { isNoticeFeed, NOTICES_CHANGED } from "./noticesModel";

export type NoticesState = { state: "loading" } | { state: "failed" } | { state: "ready"; feed: PortalNoticeFeed };

/**
 * The Updates feed for the signed-in client user: read from /api/portal/notices (verified before it is used - a malformed answer is a failure, never
 * an empty feed), reloaded when the seen state changes anywhere on the page (the bell and the lane read the same feed), and markable as seen
 * through the newest notice the user was shown (the audited portal.notices.seen command).
 */
export function useNotices(enabled = true): { notices: NoticesState; reload: () => Promise<void>; markSeen: (through: string) => Promise<void> } {
  const [notices, setNotices] = useState<NoticesState>({ state: "loading" });
  const reload = useCallback(async () => {
    try {
      const response = await fetch("/api/portal/notices", { cache: "no-store", credentials: "same-origin" });
      const body: unknown = response.ok ? await response.json().catch(() => null) : null;
      setNotices(isNoticeFeed(body) ? { state: "ready", feed: body } : { state: "failed" });
    } catch { setNotices({ state: "failed" }); }
  }, []);
  useEffect(() => {
    if (!enabled) return;
    void reload();
    const again = () => void reload();
    window.addEventListener(NOTICES_CHANGED, again);
    return () => window.removeEventListener(NOTICES_CHANGED, again);
  }, [enabled, reload]);
  const markSeen = useCallback(async (through: string) => {
    const result = await postBrowserCommand("/api/portal/notices/seen", { seenThrough: through }, crypto.randomUUID());
    if (result.state === "success") window.dispatchEvent(new Event(NOTICES_CHANGED));
  }, []);
  return { notices, reload, markSeen };
}
