"use client";
// The client portal's views, each framed in the shell (BUILD-portal-shell-lookandfeel R2) — the existing components, unchanged.
// Client components because the shell's loader hands each view its job, and a server page cannot pass that function across.
import { PortalDashboard } from "../jobs/[jobId]/PortalDashboard";
import { PortalActionTrackerPanel } from "../jobs/[jobId]/PortalActionTracker";
import { PortalShellClient } from "./PortalShellClient";

/** Dashboard — the landing (no job: the default job) and `/portal/jobs/{id}/dashboard`. */
export function ShellDashboard({ jobId, actions }: { jobId?: string; actions: boolean }) {
  return <PortalShellClient view="dashboard" jobId={jobId}>
    {(current) => current ? <><PortalDashboard jobId={current} />{actions ? <PortalActionTrackerPanel jobId={current} /> : null}</> : null}
  </PortalShellClient>;
}
