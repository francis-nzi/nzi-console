"use client";

import React from "react";
import { WorkspaceRail } from "@nzi/ui";
import { NAV } from "./nav";
import { chromeUserFor } from "./staffChrome";
import { useStaffMe } from "./useEditAccess";

/**
 * The console's left rail with the signed-in member of staff in its chip. Every page puts this where it used to put the rail with a constant
 * user: the name, initials and role come from /api/auth/me (the authenticated principal), so each staff user sees themselves.
 */
export function StaffRail({ activeId }: { activeId?: string }) {
  const me = useStaffMe(true);
  return <WorkspaceRail sections={NAV} activeId={activeId} user={chromeUserFor(me)} />;
}
