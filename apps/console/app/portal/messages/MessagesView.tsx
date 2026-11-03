"use client";

import React, { useState } from "react";
import { portalFeatureEnabled } from "../../lib/portalFlags";
import { usePortalSurface } from "../portalSurface";
import { PortalConversations } from "./PortalConversations";
import { PortalMessages } from "./PortalMessages";
import { PortalUpdatesFeed } from "./PortalUpdatesFeed";
import { bellLabel } from "./noticesModel";
import { useNotices } from "./useNotices";

/**
 * The Messages page: behind `portal-conversations`, for the signed-in client only, the two lanes - Conversations (threads with the adviser) and
 * Updates (notices: reports, decisions on their data, deadlines, broadcasts; read-only). Off - or in the staff preview, which is a read-only mirror with
 * no conversation route - it is exactly the report-comments thread it has been. (The report page's comments are one conversation with the
 * Reports-tagged thread either way.)
 */
export function MessagesView({ jobId }: { jobId: string }) {
  const surface = usePortalSurface();
  if (!(portalFeatureEnabled("portal-conversations") && !surface.readOnly)) return <PortalMessages jobId={jobId} />;
  return <TwoLanes jobId={jobId} />;
}

function TwoLanes({ jobId }: { jobId: string }) {
  const [lane, setLane] = useState<"conversations" | "updates">(typeof window !== "undefined" && new URLSearchParams(window.location.search).get("lane") === "updates" ? "updates" : "conversations");
  const { notices } = useNotices(true);
  const unread = bellLabel(notices.state === "ready" ? notices.feed.unread : 0);
  return (
    <div className="nzp-metrics">
      <div className="nzp-lanes" role="tablist" aria-label="Messages">
        <button type="button" role="tab" aria-selected={lane === "conversations"} className={`nzp-chip${lane === "conversations" ? " on" : ""}`} onClick={() => setLane("conversations")}>Conversations</button>
        <button type="button" role="tab" aria-selected={lane === "updates"} className={`nzp-chip${lane === "updates" ? " on" : ""}`} onClick={() => setLane("updates")}>Updates{unread ? ` (${unread})` : ""}</button>
      </div>
      {lane === "conversations" ? <PortalConversations jobId={jobId} /> : <PortalUpdatesFeed />}
    </div>
  );
}
