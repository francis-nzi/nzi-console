"use client";

import React from "react";
import { portalFeatureEnabled } from "../../lib/portalFlags";
import { usePortalSurface } from "../portalSurface";
import { PortalConversations } from "./PortalConversations";
import { PortalMessages } from "./PortalMessages";

/**
 * The Messages page: the Conversations lane behind `portal-conversations`, for the signed-in client only. Off - or in the staff preview, which is a
 * read-only mirror with no conversation route - it is exactly the report-comments thread it has been. (The two are one conversation either way: a
 * report comment is mirrored into its Reports-tagged thread.)
 */
export function MessagesView({ jobId }: { jobId: string }) {
  const surface = usePortalSurface();
  return portalFeatureEnabled("portal-conversations") && !surface.readOnly ? <PortalConversations jobId={jobId} /> : <PortalMessages jobId={jobId} />;
}
