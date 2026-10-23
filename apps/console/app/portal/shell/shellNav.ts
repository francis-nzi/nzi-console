// The portal shell's navigation (BUILD-portal-shell-lookandfeel R1–R3): MOCKUP-client-portal.html's rail groups — Workspace,
// Communication, Support — each item a portal path, reached through the surface's link mapper so the same rail serves the client
// portal and the staff preview. Pure, so what the rail offers is tested without a browser.
import { portalFeatureEnabled, type PortalFeature } from "../../lib/portalFlags";

export type ShellView = "dashboard" | "metrics" | "data" | "actions" | "srs" | "reports" | "messages" | "files" | "insights";
export type ShellGroup = "workspace" | "communication" | "support";

/** What the rail needs of a job: the portfolio's own fields (`/api/portal/jobs`, or the preview's list of the client's jobs). */
export type ShellJob = { id: string; number: string; title: string; reportingYear: number | null; hasPublishedReport: boolean };

export type ShellNavItem = { view: ShellView; label: string; group: ShellGroup; href: string };

type ItemSpec = {
  view: ShellView; label: string; group: ShellGroup;
  /** The portal path, given the job in context — or null when the view needs a job and there is none. */
  path: (jobId: string | null) => string | null;
  /** The client's own flag for the view: off for clients, absent from the rail. */
  flag?: PortalFeature;
};

const perJob = (suffix: string) => (jobId: string | null) => jobId ? `/portal/jobs/${encodeURIComponent(jobId)}${suffix}` : null;

/**
 * The mockup's items, in its order. Only views that are wired into the shell are listed — a view arrives here in the increment
 * that wires it, so the rail never offers a page that would drop the client out of the shell.
 */
export const SHELL_ITEMS: readonly ItemSpec[] = [
  { view: "dashboard", label: "Dashboard", group: "workspace", path: perJob("/dashboard"), flag: "portal-analytics" },
  // R8: the job's published figures, filterable and re-formattable — from the same assured read as the dashboard.
  { view: "metrics", label: "Metrics", group: "workspace", path: perJob("/metrics"), flag: "portal-analytics" },
  { view: "data", label: "Data", group: "workspace", path: perJob("/data"), flag: "portal-data" },
  // The mockup's "Strategy": the client's reduction plan, and the job's action tracker under it. Francis calls it Actions (R2).
  { view: "actions", label: "Actions", group: "workspace", path: perJob("/actions"), flag: "portal-plan" },
  { view: "srs", label: "SRS Readiness", group: "workspace", path: () => "/portal/srs", flag: "portal-readiness" },
  { view: "reports", label: "Reports", group: "workspace", path: () => "/portal/reports", flag: "portal-reports" },
  // R7: the existing report thread, as the mockup's Conversations — an early version. Per job (each published report's thread).
  { view: "messages", label: "Messages", group: "communication", path: perJob("/messages") },
  // R4: the mockup's Files as a labelled design preview — there is no file store yet.
  { view: "files", label: "Files", group: "communication", path: () => "/portal/files" },
  // Support: insights from the job's assured figures, and where to get help.
  { view: "insights", label: "Insights & Help", group: "support", path: perJob("/insights") },
];

export const SHELL_GROUP_LABELS: Record<ShellGroup, string> = { workspace: "Workspace", communication: "Communication", support: "Support" };

/** The rail's items for this job: flag-gated as the client's own pages are, and reachable on this surface (`link` not null). */
export function shellNav(jobId: string | null, link: (path: string) => string | null, enabled: (flag: PortalFeature) => boolean = portalFeatureEnabled): ShellNavItem[] {
  return SHELL_ITEMS.flatMap((item) => {
    if (item.flag && !enabled(item.flag)) return [];
    const path = item.path(jobId);
    const href = path ? link(path) : null;
    return href ? [{ view: item.view, label: item.label, group: item.group, href }] : [];
  });
}

/** The job the shell opens on: the newest job with a published report (the portfolio is newest first), else the newest job. */
export function defaultShellJob<T extends ShellJob>(jobs: readonly T[]): T | null {
  return jobs.find((job) => job.hasPublishedReport) ?? jobs[0] ?? null;
}

/** Where the job switcher goes: the same per-job view for the chosen job, else that job's dashboard. */
export function switchJobPath(view: ShellView, jobId: string): string {
  const suffix = view === "data" ? "/data" : view === "actions" ? "/actions" : view === "metrics" ? "/metrics" : view === "messages" ? "/messages" : view === "insights" ? "/insights" : "/dashboard";
  return `/portal/jobs/${encodeURIComponent(jobId)}${suffix}`;
}

export function shellJobLabel(job: ShellJob): string {
  return `${job.number}${job.reportingYear ? ` · FY${job.reportingYear}` : ""}`;
}
