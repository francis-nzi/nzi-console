// Client portal — the Dashboard view (BUILD-client-portal-dashboard; MOCKUP-client-portal.html is the layout spec). What the view
// derives, kept pure so every figure, delta, task and gate is tested without a browser. Nothing here decides what the client may
// see — `dashboardPlan` does that, unchanged — and nothing here reads money (NZC-120): only tCO₂e, an intensity ratio, years and
// dates reach it.
import type { ReportManifest } from "@nzi/charts";
import type { PortalAssuredDashboard, PortalLiveBroadcast } from "@nzi/contracts";
import { isPortalJobList } from "./portalPortfolioValidation";

type Dashboard = Extract<PortalAssuredDashboard, { published: true }>;

/**
 * The mockup's two chart sections, as a view of the report's own manifest — the same chart specs and requirements, regrouped:
 * "Carbon emissions" (the scope split beside the reduction pathway) and "Emissions performance" (the annual comparison beside the
 * largest activities). Intensity has its own page, and the site split stays in the figures table below; the composed report and
 * its manifest are untouched. Pass the result through `manifestHonouringPlan` so a left-out section's chart is withheld as before.
 */
export const DASHBOARD_SECTIONS = [
  { id: "carbon-emissions", title: "Carbon emissions", description: "Your current emissions and route to net zero — the same evidence-backed charts as your report.", chartIds: ["emissions_scope_donut", "reduction_pathway"] },
  { id: "emissions-performance", title: "Emissions performance", description: "Annual comparison and your largest activities.", chartIds: ["scope_year_on_year_bar", "emissions_by_activity"] },
] as const;

export function portalDashboardManifest(base: ReportManifest): ReportManifest {
  const wanted = new Set<string>(DASHBOARD_SECTIONS.flatMap((section) => section.chartIds));
  return {
    ...base,
    charts: base.charts.filter((chart) => wanted.has(chart.id)),
    // The charts keep their own requirements (`reportSection`, `requiredWhen`), so a left-out section or a single year is an
    // absence the chart set states, exactly as in the report.
    sections: DASHBOARD_SECTIONS.map((section) => ({ id: section.id, title: section.title, description: section.description, chartIds: [...section.chartIds], layout: "two-column" as const })),
  };
}

/**
 * A change, said by direction only — never coloured good or bad (dataviz: no judgement without context). `null` when there is
 * nothing honest to compare against.
 */
export type Change = { direction: "up" | "down" | "flat"; percent: number };
const change = (now: number, then: number): Change | null => {
  if (!(then > 0) || !Number.isFinite(now)) return null;
  const percent = ((now - then) / then) * 100;
  const rounded = Math.round(percent * 10) / 10;
  return { direction: rounded > 0 ? "up" : rounded < 0 ? "down" : "flat", percent: Math.abs(rounded) };
};

/** The published report's own annual comparison (its frozen `annualComparison`) — what its annual chart draws. */
export type ReportComparison = ReadonlyArray<{ year: number; values: ReadonlyArray<{ value: number }> }>;

/**
 * This year against the year before: the reporting chain's reviewed snapshot for that year when there is one, else the prior
 * year the published report itself compares against — so the tile never says "nothing to compare" beside a chart that draws it.
 */
export function yearOnYear(dashboard: Dashboard, comparison: ReportComparison = []): (Change & { year: number }) | null {
  const year = dashboard.reportingYear - 1;
  const fromTrend = dashboard.trend.find((entry) => entry.year === year && entry.total != null)?.total ?? null;
  const reported = comparison.find((entry) => entry.year === year);
  const fromReport = reported && reported.values.length ? reported.values.reduce((sum, value) => sum + value.value, 0) : null;
  const prior = fromTrend ?? fromReport;
  const delta = prior != null ? change(dashboard.total, prior) : null;
  return delta ? { ...delta, year } : null;
}

/** This year against the baseline — the target's when one is set, else the trend's baseline year. `null`: no baseline yet. */
export function versusBaseline(dashboard: Dashboard): (Change & { year: number }) | null {
  const fromTarget = dashboard.target ? { year: dashboard.target.baselineYear, total: dashboard.target.baselineTco2e } : null;
  const fromTrend = dashboard.trend.find((entry) => entry.kind === "baseline" && entry.total != null);
  const baseline = fromTarget ?? (fromTrend ? { year: fromTrend.year, total: fromTrend.total! } : null);
  if (!baseline || baseline.year === dashboard.reportingYear) return null;
  const delta = change(dashboard.total, baseline.total);
  return delta ? { ...delta, year: baseline.year } : null;
}

/** The factor sets the figures were calculated with, as the report names them — the chart and assurance source line. */
export function sourceLine(measurements: ReadonlyArray<{ factorSet?: string | null }>): string {
  return [...new Set(measurements.map((row) => row.factorSet?.trim() ?? "").filter(Boolean))].sort((a, b) => a.localeCompare(b)).join(" · ");
}

/** The jobs this client may see, as the portfolio list gives them (`/api/portal/jobs`). */
export type PortalJobSummary = { id: string; number: string; reportingYear: number | null; hasPublishedReport: boolean; approved: boolean; hasUnreadNziResponse: boolean };

/** The year selector: one entry per reporting year with a published report — newest first, the latest job where a year has two. */
export function reportingYearOptions(jobs: readonly PortalJobSummary[]): Array<{ year: number; jobId: string }> {
  const byYear = new Map<number, string>();
  for (const job of jobs) if (job.hasPublishedReport && job.reportingYear != null && !byYear.has(job.reportingYear)) byYear.set(job.reportingYear, job.id);
  return [...byYear].sort(([a], [b]) => b - a).map(([year, jobId]) => ({ year, jobId }));
}

/** The data-entry window and the categories granted in it (`/api/portal/jobs/[jobId]/data-entry-access`), and what was sent. */
export type DataEntryState = {
  access: { state: "scheduled" | "open"; startsAt: string; expiresAt: string } | null;
  buckets: ReadonlyArray<{ bucketGrantId: string; sourceLabel: string }>;
  submittedBucketIds: ReadonlySet<string>;
};

/** A real outstanding task, from a flow that already knows it — never a store of its own. */
export type DashboardTask = { id: string; kind: "submit-data" | "approve-report" | "read-reply"; title: string; detail: string; href: string; action: string };

/**
 * "What NZI needs from you": every task an existing flow already knows about, and nothing else.
 *  - submit-data: each category granted in an open data-entry window with nothing yet submitted, due as the window closes;
 *  - approve-report: the published report awaiting the client's sign-off (the portfolio's own `approved`);
 *  - read-reply: an unread reply from the adviser on this job (the portfolio's own flag).
 * Uploads ("utility bills, N of M sites") have no source in the portal yet — raised in the PR, not invented here.
 */
export function dashboardTasks(input: { jobId: string; job: PortalJobSummary | null; reportingYear: number; dataEntry: DataEntryState | null; formatDate: (iso: string) => string }): DashboardTask[] {
  const tasks: DashboardTask[] = [];
  const { jobId, job, reportingYear, dataEntry } = input;
  const jobHref = `/portal/jobs/${encodeURIComponent(jobId)}`;
  if (dataEntry?.access?.state === "open") {
    for (const bucket of dataEntry.buckets) {
      if (dataEntry.submittedBucketIds.has(bucket.bucketGrantId)) continue;
      tasks.push({ id: `submit-${bucket.bucketGrantId}`, kind: "submit-data", title: `Submit ${bucket.sourceLabel.trim() || "your"} data`,
        detail: `Due ${input.formatDate(dataEntry.access.expiresAt)} · FY${reportingYear}`, href: jobHref, action: "Open" });
    }
  }
  if (job?.hasPublishedReport && !job.approved) {
    tasks.push({ id: `approve-${job.id}`, kind: "approve-report", title: `Approve the ${job.number} report`, detail: "Awaiting your sign-off", href: jobHref, action: "Review" });
  }
  if (job?.hasUnreadNziResponse) {
    tasks.push({ id: `reply-${job.id}`, kind: "read-reply", title: "Read your adviser's reply", detail: `On ${job.number}`, href: jobHref, action: "Read" });
  }
  return tasks;
}

/** The sources around the report — each loaded on its own, so one failing never hides the figures or another card. */
export type Loaded<T> = { kind: "loading" } | { kind: "failed" } | { kind: "ready"; value: T };
export type DashboardSurroundings = {
  years: Loaded<Array<{ year: number; jobId: string }>>;
  tasks: Loaded<DashboardTask[]>;
  broadcasts: Loaded<PortalLiveBroadcast[]>;
};

/** One route's answer: its parsed body when it answered 2xx, else nothing to read. */
export type Fetched = { ok: true; body: unknown } | { ok: false };
const bodyOf = (fetched: Fetched): Record<string, unknown> | null =>
  fetched.ok && fetched.body && typeof fetched.body === "object" ? fetched.body as Record<string, unknown> : null;

/**
 * The four routes' answers, read as each route returns them — `/api/portal/jobs` → `{ jobs }`, `…/data-entry-access` →
 * `{ access, buckets }`, `…/data-entry-records` → `{ records }`, `/api/portal/broadcasts` → `{ broadcasts }`. Anything that does
 * not verify is a failed source, said as such; never an empty list.
 */
export function surroundingsFrom(input: { jobId: string; reportingYear: number; jobs: Fetched; access: Fetched; records: Fetched; broadcasts: Fetched; formatDate: (iso: string) => string }): DashboardSurroundings {
  const jobsBody = bodyOf(input.jobs)?.jobs;
  const jobList = isPortalJobList(jobsBody) ? jobsBody as PortalJobSummary[] : null;
  let dataEntry: DataEntryState | null | "failed" = "failed";
  const access = bodyOf(input.access);
  if (access && "access" in access) {
    const entryWindow = access.access as DataEntryState["access"];
    const buckets = Array.isArray(access.buckets)
      ? (access.buckets as Array<{ bucketGrantId?: unknown; sourceLabel?: unknown }>).filter((bucket): bucket is { bucketGrantId: string; sourceLabel: string } => typeof bucket?.bucketGrantId === "string" && typeof bucket.sourceLabel === "string")
      : null;
    // What was sent is known only from the records; without them nothing is assumed outstanding.
    const records = bodyOf(input.records)?.records;
    const sent = Array.isArray(records) && records.every((record) => record && typeof record.bucketGrantId === "string" && typeof record.status === "string")
      ? new Set((records as Array<{ bucketGrantId: string; status: string }>).filter((record) => record.status === "submitted").map((record) => record.bucketGrantId))
      : null;
    if (entryWindow === null) dataEntry = null;
    else if (entryWindow && (entryWindow.state === "open" || entryWindow.state === "scheduled") && typeof entryWindow.expiresAt === "string" && buckets && sent) dataEntry = { access: entryWindow, buckets, submittedBucketIds: sent };
  }
  const job = jobList?.find((entry) => entry.id === input.jobId) ?? null;
  const broadcasts = input.broadcasts.ok ? input.broadcasts.body : null;
  return {
    years: jobList ? { kind: "ready", value: reportingYearOptions(jobList) } : { kind: "failed" },
    tasks: jobList && dataEntry !== "failed"
      ? { kind: "ready", value: dashboardTasks({ jobId: input.jobId, job, reportingYear: input.reportingYear, dataEntry, formatDate: input.formatDate }) }
      : { kind: "failed" },
    broadcasts: isPortalLiveBroadcastList(broadcasts) ? { kind: "ready", value: broadcasts.broadcasts } : { kind: "failed" },
  };
}

/** The live broadcasts, as `/api/portal/broadcasts` returns them — verified before anything is drawn. */
export function isPortalLiveBroadcastList(value: unknown): value is { broadcasts: PortalLiveBroadcast[] } {
  if (!value || typeof value !== "object" || !Array.isArray((value as { broadcasts?: unknown }).broadcasts)) return false;
  return (value as { broadcasts: unknown[] }).broadcasts.every((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const broadcast = entry as Partial<PortalLiveBroadcast>;
    const link = broadcast.link;
    return typeof broadcast.broadcastId === "string" && typeof broadcast.title === "string" && typeof broadcast.body === "string"
      && typeof broadcast.startsAt === "string" && (link === null || (!!link && typeof link.url === "string" && typeof link.label === "string"));
  });
}
