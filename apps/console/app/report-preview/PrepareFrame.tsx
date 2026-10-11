import type { ReactNode } from "react";
import { AppShell, TopBar, WorkspaceRail, type Crumb } from "@nzi/ui";
import { NAV, USER } from "../lib/nav";
import { crumbTrail } from "../lib/crumbTrail";

/**
 * Track A addendum #2: report preparation sits in the console's own chrome — the left rail (Reports current), the breadcrumb
 * and the workspace search — like `/reports`, not a standalone page that reads as a different product. The canvas stays the
 * inner container, so the sheet still reads as a report surface, framed by the app. Every `/report-preview` state renders
 * through this: the picker, the snapshot preview and the empty states.
 *
 * No "use client": the picker renders it on the server; the job-aware states render it from the client once the job is read.
 */
export function PrepareFrame({ crumbs, children }: { crumbs: Crumb[]; children: ReactNode }) {
  return <AppShell rail={<WorkspaceRail sections={NAV} activeId="reports" user={USER} />}>
    <TopBar crumbs={crumbTrail(crumbs)} />
    <div className="nz-preview-canvas">{children}</div>
  </AppShell>;
}
