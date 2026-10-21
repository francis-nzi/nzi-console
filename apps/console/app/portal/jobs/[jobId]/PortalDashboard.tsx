"use client";
import { useOrganisationName } from "../../../lib/OrganisationNameProvider";

// Client portal Phase 2 · A1 — the client's headline emissions view. Every
// figure is sourced from the content-addressed PUBLISHED report snapshot (§0):
// the numbers + tables from /api/portal/jobs/[id]/dashboard (the shared assured
// baseline contract A2 also reads), the charts from the same published snapshot
// via @nzi/charts' `resolveCrpCoreCharts` (identical marks to the report/PDF).
// Charts carry text/provenance chrome; the tables below make every figure
// reachable without pixels (Narrator).
//
// F-4c (RULING-reporting-F4b-flip-and-dashboard): the dashboard honours the report it is drawn from — a section that report
// leaves out (targets, intensity, sites) has its tiles, charts and table withheld here too, driven by the same plan, and the
// omission is said. If the plan cannot be read, those pieces are withheld (fail closed). See `dashboardPlan`.
//
// BUILD-client-portal-dashboard (21 Oct 2026): the view laid out as MOCKUP-client-portal.html's Dashboard, in the portal's own
// components and light tokens — a header band with the year, the four headline figures, the evidence line, "what we need from
// you", the charts in two sections, the latest broadcasts, and every figure as a table. Same data, same gates: `dashboardPlan`
// decides what is shown; `dashboardView` derives the rest. No money anywhere (NZC-120); the client's copy of the report only.
import { useCallback, useEffect, useState } from "react";
import { crpProfessionalManifest, ManifestChartSet, resolveCrpCoreCharts, type AnyChartData } from "@nzi/charts";
import { crpScopeCategoryLabel, type PortalAssuredDashboard, type ClientFacingPublishedCrpReport, type PortalLiveBroadcast } from "@nzi/contracts";
import { redirectIfPortalSessionEnded } from "../../portalSessionClient";
import { isPortalAssuredDashboard } from "./portalAnalyticsValidation";
import { isPublishedCrpReport } from "./publishedReportValidation";
import { formatDate } from "../../../lib/formatDate";
import type { OrganisationCopy } from "../../../lib/organisationName";
import { chartsHonouringPlan, dashboardVisibilityOf, manifestHonouringPlan, type DashboardPlanSource, type DashboardVisibility } from "../../dashboardPlan";
import { portalReportViewOf } from "../../portalReportView";
import {
  portalDashboardManifest, sourceLine, surroundingsFrom, versusBaseline, yearOnYear,
  type Change, type DashboardSurroundings, type ReportComparison, type DashboardTask, type Fetched,
} from "../../dashboardView";

const fmt = (value: number) => value.toLocaleString("en-GB", { maximumFractionDigits: 1 });
const whole = (value: number) => value.toLocaleString("en-GB", { maximumFractionDigits: 0 });
const pct = (value: number) => `${(value * 100).toLocaleString("en-GB", { maximumFractionDigits: 0 })}%`;
const SCOPE_NAME: Record<"1" | "2" | "3", string> = { "1": "Scope 1 — direct", "2": "Scope 2 — purchased energy", "3": "Scope 3 — value chain" };

/** What the report says about itself, for the header and the evidence line — from the client's copy only. */
export type ReportIdentity = { client: string; jobNumber: string; asAt: string; sources: string; comparison: ReportComparison };

export type ReadyState = { kind: "ready"; dashboard: Extract<PortalAssuredDashboard, { published: true }>; charts: AnyChartData[]; snapshotId: string; visibility: DashboardVisibility; identity: ReportIdentity | null };
type State =
  | { kind: "loading" }
  | { kind: "failed"; message: string }
  | { kind: "empty" }
  | ReadyState;

export type { DashboardSurroundings };

/**
 * F-4c: the plan of the report this dashboard is drawn from — the same version, read through F-4a's grant-checked composition
 * route. Anything but a verified answer fails closed (see `dashboardVisibilityOf`).
 */
async function planSourceFor(jobId: string, reportVersionId: string): Promise<DashboardPlanSource> {
  try {
    const response = await fetch(`/api/portal/jobs/${jobId}/published-report/composition?reportVersionId=${encodeURIComponent(reportVersionId)}`, { cache: "no-store" });
    if (!response.ok) return { state: "failed" };
    const view = portalReportViewOf(await response.json(), { reportVersionId, jobId });
    return view.state === "failed" ? { state: "failed" } : view;
  } catch { return { state: "failed" }; }
}

/** The portfolio, the data-entry window and what was sent in it, and the live broadcasts — read-only, each failing on its own. */
async function surroundingsFor(jobId: string, reportingYear: number): Promise<DashboardSurroundings> {
  const json = async (url: string): Promise<unknown> => {
    const response = await fetch(url, { cache: "no-store" });
    if (await redirectIfPortalSessionEnded(response)) throw new Error("session ended");
    if (!response.ok) throw new Error(url);
    return response.json();
  };
  const [jobs, access, records, broadcasts] = await Promise.allSettled([
    json("/api/portal/jobs"), json(`/api/portal/jobs/${jobId}/data-entry-access`), json(`/api/portal/jobs/${jobId}/data-entry-records`), json("/api/portal/broadcasts"),
  ]);
  const read = (settled: PromiseSettledResult<unknown>): Fetched => settled.status === "fulfilled" ? { ok: true, body: settled.value } : { ok: false };
  return surroundingsFrom({ jobId, reportingYear, jobs: read(jobs), access: read(access), records: read(records), broadcasts: read(broadcasts), formatDate });
}

const LOADING_SURROUNDINGS: DashboardSurroundings = { years: { kind: "loading" }, tasks: { kind: "loading" }, broadcasts: { kind: "loading" } };

export function PortalDashboard({ jobId }: { jobId: string }) {
  const org = useOrganisationName();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [surroundings, setSurroundings] = useState<DashboardSurroundings>(LOADING_SURROUNDINGS);

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const [dashRes, reportRes] = await Promise.all([
        fetch(`/api/portal/jobs/${jobId}/dashboard`, { cache: "no-store" }),
        fetch(`/api/portal/jobs/${jobId}/published-report`, { cache: "no-store" }),
      ]);
      if (await redirectIfPortalSessionEnded(dashRes) || await redirectIfPortalSessionEnded(reportRes)) return;
      if (!dashRes.ok) { setState({ kind: "failed", message: "Your emissions dashboard could not be loaded." }); return; }
      const dashboard: unknown = await dashRes.json();
      if (!isPortalAssuredDashboard(dashboard)) { setState({ kind: "failed", message: "The assured figures could not be verified." }); return; }
      if (!dashboard.published) { setState({ kind: "empty" }); return; }

      // Charts from the same published snapshot — identical to the report/PDF.
      let charts: AnyChartData[] = [];
      let snapshotId = dashboard.reportVersionId;
      let identity: ReportIdentity | null = null;
      if (reportRes.ok) {
        const reportBody: unknown = await reportRes.json();
        if (reportBody && typeof reportBody === "object" && isPublishedCrpReport((reportBody as { report?: unknown }).report, jobId)) {
          const s = ((reportBody as { report: ClientFacingPublishedCrpReport }).report).snapshot;
          snapshotId = s.id;
          identity = { client: s.client, jobNumber: s.jobNumber, asAt: s.createdAt, sources: sourceLine(s.measurements), comparison: s.annualComparison ?? [] };
          charts = resolveCrpCoreCharts({
            id: s.id, jobId: s.jobId, jobNumber: s.jobNumber, client: s.client, reportingYear: s.reportingYear,
            generatedAt: s.createdAt, dataHash: s.dataHash, target: s.target, intensityTarget: s.intensityTarget,
            annualComparison: s.annualComparison,
            measurements: s.measurements.map((row) => ({
              rowId: row.rowId, scope: row.scope, scopeCode: row.scopeCode, sourceLabel: row.sourceLabel,
              siteId: row.siteId, siteLabel: row.siteLabel, purchasedGoodsCategoryId: row.purchasedGoodsCategoryId,
              purchasedGoodsCategoryLabel: row.purchasedGoodsCategoryLabel, tco2e: row.tco2e, factorSet: row.factorSet,
            })),
          });
        }
      }
      const visibility = dashboardVisibilityOf(await planSourceFor(jobId, dashboard.reportVersionId));
      setState({ kind: "ready", dashboard, charts, snapshotId, visibility, identity });
      setSurroundings(LOADING_SURROUNDINGS);
      setSurroundings(await surroundingsFor(jobId, dashboard.reportingYear).catch((): DashboardSurroundings => ({ years: { kind: "failed" }, tasks: { kind: "failed" }, broadcasts: { kind: "failed" } })));
    } catch (cause) {
      setState({ kind: "failed", message: cause instanceof Error ? cause.message : "Your emissions dashboard could not be loaded." });
    }
  }, [jobId]);

  useEffect(() => { void load(); }, [load]);

  if (state.kind === "loading") return <div className="nz-portal-state loading" role="status"><i>↻</i><div><b>Loading your emissions dashboard</b><span>Reading your latest assured report…</span></div></div>;
  if (state.kind === "failed") return <div className="nz-portal-state failed" role="alert"><i>!</i><div><b>Your emissions dashboard is temporarily unavailable</b><span>{state.message} No figures have been inferred.</span><button className="nz-btn" onClick={() => void load()}>Try again</button></div></div>;
  if (state.kind === "empty") return (
    <div className="nz-portal-state empty">
      <i>✓</i>
      <div>
        <b>Your first assured report will appear here</b>
        <span>Once {org.your("team")} publishes a verified report for this job, your emissions totals, scope split and trend will show on this page — always from the assured figures, never a work-in-progress draft.</span>
      </div>
    </div>
  );

  return <PortalDashboardView jobId={jobId} state={state} surroundings={surroundings} org={org} />;
}

/** A change, by direction only: an arrow and the words, in the text colour — never good/bad colour (dataviz). */
function ChangeLine({ change, against }: { change: Change; against: string }) {
  const arrow = change.direction === "up" ? "▲" : change.direction === "down" ? "▼" : "■";
  const said = change.direction === "flat" ? `No change ${against}` : `${change.direction === "up" ? "Up" : "Down"} ${change.percent.toLocaleString("en-GB")}% ${against}`;
  return <span className="nz-pd-change" aria-label={said}><i aria-hidden="true">{arrow}</i> {change.direction === "flat" ? "no change" : `${change.percent.toLocaleString("en-GB")}%`} {against}</span>;
}

/** The view itself, from what was loaded — pure, so it renders the same in a test as in the browser. */
export function PortalDashboardView({ jobId, state, surroundings, org }: { jobId: string; state: ReadyState; surroundings: DashboardSurroundings; org: OrganisationCopy }) {
  const { dashboard, snapshotId, visibility, identity } = state;
  // F-4c: only what the report it is drawn from shows — a section the report leaves out is not drawn here either.
  const charts = chartsHonouringPlan(state.charts, visibility);
  const manifest = manifestHonouringPlan(portalDashboardManifest(crpProfessionalManifest), visibility);
  const scopes: Array<"1" | "2" | "3"> = ["1", "2", "3"];
  const yoy = yearOnYear(dashboard, identity?.comparison);
  const baseline = versusBaseline(dashboard);
  const years = surroundings.years.kind === "ready" ? surroundings.years.value : [];
  const latestYear = years[0]?.year;
  const reportHref = `/portal/jobs/${encodeURIComponent(jobId)}`;
  const client = identity?.client ?? "Your organisation";
  const initials = client.split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word[0]!.toUpperCase()).join("") || "—";
  const asAt = identity ? formatDate(identity.asAt) : formatDate(dashboard.publishedAt);

  return (
    <div className="nz-portal-dash nz-pd">
      {/* 1 · The header band: whose account, which year, which evidence — and the way to the report itself. */}
      <header className="nz-pd-top">
        <div className="nz-pd-id">
          <span className="nz-pd-avatar" aria-hidden="true">{initials}</span>
          <div>
            <span className="nz-eyebrow">Carbon account</span>
            <h1 className="nz-pd-client">{client}</h1>
            <p className="nz-pd-meta">Reporting year {dashboard.reportingYear} · Reviewed snapshot · as at {asAt}</p>
          </div>
        </div>
        <div className="nz-pd-top-actions">
          {years.length > 1 ? (
            <label className="nz-pd-year">
              <span>Year</span>
              <select className="nz-sel" value={years.find((entry) => entry.jobId === jobId)?.year ?? dashboard.reportingYear}
                onChange={(event) => { const next = years.find((entry) => entry.year === Number(event.target.value)); if (next && next.jobId !== jobId) window.location.assign(`/portal/jobs/${encodeURIComponent(next.jobId)}/dashboard`); }}>
                {years.map((entry) => <option key={entry.year} value={entry.year}>{entry.year}</option>)}
              </select>
            </label>
          ) : null}
          <a className="nz-btn" href="/portal/intensity">Emissions intensity</a>
          <a className="nz-btn pri" href={reportHref}>{latestYear === undefined || latestYear === dashboard.reportingYear ? "Open latest report" : `Open the ${dashboard.reportingYear} report`}</a>
        </div>
      </header>

      {/* 2 · The four headline figures. A tile whose report section is left out is withheld, and says so. */}
      <section className="nz-pd-metrics" aria-label="Headline figures">
        <div className="nz-pd-metric">
          <span className="l">Current emissions ({dashboard.reportingYear})</span>
          <b className="v">{whole(dashboard.total)}<small> tCO₂e</small></b>
          {yoy ? <ChangeLine change={yoy} against={`vs ${yoy.year}`} /> : <span className="s">No {dashboard.reportingYear - 1} report to compare</span>}
        </div>
        <div className="nz-pd-metric">
          <span className="l">Vs baseline</span>
          {baseline ? <><b className="v">{baseline.direction === "flat" ? "0" : `${baseline.direction === "down" ? "−" : "+"}${baseline.percent.toLocaleString("en-GB")}`}<small>%</small></b><span className="s">Against your {baseline.year} baseline</span></>
            : <><b className="v">—</b><span className="s">Baseline not yet set</span></>}
        </div>
        <div className="nz-pd-metric">
          <span className="l">Intensity</span>
          {visibility.intensity
            ? dashboard.intensity != null
              ? <><b className="v">{fmt(dashboard.intensity)}{dashboard.intensityUnit ? <small> {dashboard.intensityUnit}</small> : null}</b><span className="s">No earlier intensity to compare yet</span></>
              : <><b className="v">—</b><span className="s">Not reported this year</span></>
            : <><b className="v">—</b><span className="s">Left out of your report</span></>}
        </div>
        <div className="nz-pd-metric">
          <span className="l">Net zero target</span>
          {dashboard.target && visibility.targets ? (
            <><b className="v">{dashboard.target.netZeroYear}</b><span className="s">{Math.max(0, dashboard.target.netZeroYear - dashboard.reportingYear)} years to go · interim −{dashboard.target.interimReductionPercent}% by {dashboard.target.interimYear}</span></>
          ) : <><b className="v">—</b><span className="s">{visibility.targets ? "No target set yet" : "Left out of your report"}</span></>}
        </div>
      </section>

      {/* 3 · The evidence line: which snapshot, with what data, and that the publication gate passed. Read-only. */}
      <div className="nz-pd-assure" role="note">
        <span className="al"><b>Reviewed snapshot</b> · evidence state <b>Assured</b></span>
        <span className="src">{identity ? `${identity.jobNumber}${identity.sources ? ` · ${identity.sources}` : ""} · as at ${asAt}` : `Report version ${dashboard.reportVersionId} · as at ${asAt}`} · evidence {dashboard.dataHash.slice(0, 15)}…</span>
        <span className="tags"><span className="nz-pd-pill">Portal</span><span className="nz-pd-pill passed"><i aria-hidden="true">✓</i> Publication gate passed</span></span>
      </div>

      {visibility.omitted.length ? (
        <p className="nz-portal-dash-omitted" role="note">Left out of your report at {org.your("adviser")}&rsquo;s choice, so not shown here either: {visibility.omitted.join(", ")}.</p>
      ) : null}
      {visibility.unverified ? (
        <p className="nz-portal-dash-omitted" role="note">Your targets, intensity and site figures are not shown here because the sections of your report could not be checked just now. They are in your report itself.</p>
      ) : null}

      {/* 4 · What we need from you — only tasks an existing flow already knows. */}
      <section className="nz-pd-needs" aria-labelledby="pd-needs-title">
        <div className="nz-pd-sechead"><h3 id="pd-needs-title">What {org.short} needs from you</h3><p>The things that keep your FY{dashboard.reportingYear} report on track.</p></div>
        {surroundings.tasks.kind === "loading" ? <p className="nz-pd-quiet" role="status">Checking for anything outstanding…</p>
          : surroundings.tasks.kind === "failed" ? <p className="nz-pd-quiet" role="alert">Your outstanding tasks could not be checked just now. Nothing has been assumed done.</p>
          : surroundings.tasks.value.length === 0 ? <p className="nz-pd-quiet">Nothing is waiting on you right now.</p>
          : <div className="nz-pd-actions">{surroundings.tasks.value.map((task) => (
              <div key={task.id} className={`nz-pd-action ${task.kind}`}>
                <span className="ic" aria-hidden="true">{task.kind === "submit-data" ? "!" : task.kind === "approve-report" ? "✓" : "✉"}</span>
                <div><b>{task.title}</b><span>{task.detail}</span><a className={`nz-btn${task.kind === "submit-data" ? " pri" : ""}`} href={task.href}>{task.action}</a></div>
              </div>
            ))}</div>}
      </section>

      {/* 5 + 6 · The charts, from the same published snapshot as the report — the mockup's two sections, gated by the plan. */}
      {charts.length ? (
        <div className="nz-portal-dash-charts">
          {/* R5: the resolver draws the annual comparison only from two reporting years, so its absence here is a single year.
              R7: likewise the purchased-goods breakdown only from Scope 3.1 rows, so its absence is a snapshot with none. */}
          <ManifestChartSet manifest={manifest} charts={charts} reviewedSnapshotId={snapshotId} context={{ reportingYears: charts.some((chart) => chart.spec.type === "scope_year_on_year_bar") ? 2 : 1, purchasedGoods: charts.some((chart) => chart.spec.type === "purchased_goods_breakdown") }} />
        </div>
      ) : null}

      {/* 7 · The latest from the adviser: the live portal broadcasts. */}
      <section className="nz-pd-messages" aria-labelledby="pd-messages-title">
        <h3 id="pd-messages-title">Latest from {org.short}</h3>
        {surroundings.broadcasts.kind === "loading" ? <p className="nz-pd-quiet" role="status">Loading the latest updates…</p>
          : surroundings.broadcasts.kind === "failed" ? <p className="nz-pd-quiet" role="alert">The latest updates could not be loaded just now.</p>
          : surroundings.broadcasts.value.length === 0 ? <p className="nz-pd-quiet">No announcements right now.</p>
          : <ul>{surroundings.broadcasts.value.slice(0, 3).map((broadcast) => (
              <li key={broadcast.broadcastId}><b>{broadcast.title}</b><p>{broadcast.body}</p>{broadcast.link ? <a href={broadcast.link.url} rel="noopener noreferrer">{broadcast.link.label}</a> : null}</li>
            ))}</ul>}
      </section>

      {/* Text/table equivalents — every figure reachable without the charts. */}
      <details className="nz-pd-figures">
        <summary>Every figure as a table</summary>
        <section className="nz-portal-dash-tables" aria-label="Assured figures">
          <div>
            <h3>Emissions by scope</h3>
            <table className="nz-tbl">
              <thead><tr><th>Scope</th><th className="num">tCO₂e</th><th className="num">% of total</th></tr></thead>
              <tbody>
                {scopes.map((scope) => (
                  <tr key={scope}><td>{SCOPE_NAME[scope]}</td><td className="num">{fmt(dashboard.byScope[scope])}</td><td className="num">{dashboard.total > 0 ? pct(dashboard.byScope[scope] / dashboard.total) : "—"}</td></tr>
                ))}
                <tr className="total"><td>All scopes</td><td className="num">{fmt(dashboard.total)}</td><td className="num">100%</td></tr>
              </tbody>
            </table>
          </div>

          <div>
            <h3>Emissions by category</h3>
            <table className="nz-tbl">
              <thead><tr><th>Category</th><th className="num">tCO₂e</th><th className="num">% of total</th></tr></thead>
              <tbody>
                {dashboard.byCategory.map((row) => (
                  <tr key={row.scopeCode}><td>{row.label || crpScopeCategoryLabel(row.scopeCode)}</td><td className="num">{fmt(row.tco2e)}</td><td className="num">{dashboard.total > 0 ? pct(row.tco2e / dashboard.total) : "—"}</td></tr>
                ))}
                {dashboard.byCategory.length === 0 ? <tr><td colSpan={3} className="nz-table-empty">No category detail in the published report.</td></tr> : null}
              </tbody>
            </table>
          </div>

          <div>
            <h3>Five-year trend</h3>
            <table className="nz-tbl">
              <thead><tr><th>Year</th><th className="num">Total tCO₂e</th><th className="num">Scope 1</th><th className="num">Scope 2</th><th className="num">Scope 3</th></tr></thead>
              <tbody>
                {dashboard.trend.map((year) => (
                  <tr key={year.year} className={year.kind === "current" ? "cur" : year.kind === "baseline" ? "bl" : undefined}>
                    <td>{year.year}{year.kind === "baseline" ? " · baseline" : year.kind === "current" ? " · this report" : ""}</td>
                    <td className="num">{year.total == null ? "not published" : fmt(year.total)}</td>
                    <td className="num">{year.total == null ? "—" : fmt(year.byScope["1"])}</td>
                    <td className="num">{year.total == null ? "—" : fmt(year.byScope["2"])}</td>
                    <td className="num">{year.total == null ? "—" : fmt(year.byScope["3"])}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {dashboard.bySite.length > 1 && visibility.sites ? (
            <div>
              <h3>Emissions by site</h3>
              <table className="nz-tbl">
                <thead><tr><th>Site</th><th className="num">tCO₂e</th><th className="num">% of total</th></tr></thead>
                <tbody>
                  {dashboard.bySite.map((row) => (
                    <tr key={row.siteId ?? "unallocated"}><td>{row.label}</td><td className="num">{fmt(row.tco2e)}</td><td className="num">{dashboard.total > 0 ? pct(row.tco2e / dashboard.total) : "—"}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </section>
      </details>
    </div>
  );
}
