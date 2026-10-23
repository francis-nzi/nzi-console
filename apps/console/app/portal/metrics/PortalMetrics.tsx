"use client";
// The portal Metrics view (BUILD-portal-shell-lookandfeel R8): the job's published emissions as charts the client can re-draw in
// the forms each chart's job allows (`METRIC_FORMS`), filtered by year (the job), scope and site. Every figure is the dashboard's
// own (see `metricsView`), from the client's copy of the published report — read through the surface, so the staff preview reads
// it exactly as the client does. Read-only: there is nothing here to write.
import { useCallback, useEffect, useMemo, useState } from "react";
import { MetricBars, MetricRing, MetricTrend, tokens, type MetricSlice } from "@nzi/charts";
import type { ClientFacingPublishedCrpReport, PortalAssuredDashboard } from "@nzi/contracts";
import { usePortalSurface } from "../portalSurface";
import { isPortalAssuredDashboard } from "../jobs/[jobId]/portalAnalyticsValidation";
import { isPublishedCrpReport } from "../jobs/[jobId]/publishedReportValidation";
import { isPortalJobList, type PortalJob } from "../portalPortfolioValidation";
import {
  ALL_SITES, SCOPE_NAMES, metricFigures, metricFormsFor, metricFormOr, metricSites, metricTrend,
  type MetricChart, type MetricFilters, type MetricForm, type MetricMeasurement,
} from "./metricsView";

type Ready = { kind: "ready"; dashboard: Extract<PortalAssuredDashboard, { published: true }>; rows: MetricMeasurement[]; jobs: PortalJob[] };
type State = { kind: "loading" } | { kind: "failed"; message: string } | { kind: "empty" } | Ready;

const UNIT = "tCO₂e";
const FORM_LABEL: Record<MetricForm, string> = { donut: "Donut", pie: "Pie", bar: "Bar", line: "Line", table: "Table" };
const fmt = (value: number) => value.toLocaleString("en-GB", { maximumFractionDigits: value >= 100 ? 0 : 1 });

export function PortalMetrics({ jobId }: { jobId: string }) {
  const surface = usePortalSurface();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [filters, setFilters] = useState<MetricFilters>({ scope: "all", site: ALL_SITES });
  const [forms, setForms] = useState<Record<MetricChart, MetricForm>>({ scope: metricFormOr("scope", null), category: metricFormOr("category", null), site: metricFormOr("site", null), trend: metricFormOr("trend", null) });

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const base = `${surface.api}/jobs/${encodeURIComponent(jobId)}`;
      const [dashRes, reportRes, jobsRes] = await Promise.all([fetch(`${base}/dashboard`, { cache: "no-store" }), fetch(`${base}/published-report`, { cache: "no-store" }), fetch(`${surface.api}/jobs`, { cache: "no-store" })]);
      if (await surface.sessionEnded(dashRes) || await surface.sessionEnded(reportRes)) return;
      const dashboard: unknown = dashRes.ok ? await dashRes.json() : null;
      if (!isPortalAssuredDashboard(dashboard)) { setState({ kind: "failed", message: "The assured figures could not be verified." }); return; }
      if (!dashboard.published) { setState({ kind: "empty" }); return; }
      const reportBody: unknown = reportRes.ok ? await reportRes.json() : null;
      const report = reportBody && typeof reportBody === "object" ? (reportBody as { report?: unknown }).report : undefined;
      if (!isPublishedCrpReport(report, jobId)) { setState({ kind: "failed", message: "The published report could not be verified." }); return; }
      const jobsBody: unknown = jobsRes.ok ? await jobsRes.json() : null;
      const jobs = jobsBody && typeof jobsBody === "object" ? (jobsBody as { jobs?: unknown }).jobs : undefined;
      const rows = (report as ClientFacingPublishedCrpReport).snapshot.measurements.map((row) => ({ scope: row.scope, scopeCode: row.scopeCode, siteId: row.siteId, siteLabel: row.siteLabel, tco2e: row.tco2e }));
      setState({ kind: "ready", dashboard, rows, jobs: isPortalJobList(jobs) ? jobs : [] });
    } catch { setState({ kind: "failed", message: "Your metrics could not be loaded." }); }
  }, [jobId, surface]);
  useEffect(() => { void load(); }, [load]);

  if (state.kind === "loading") return <div className="nz-portal-state loading" role="status"><i>↻</i><div><b>Loading your metrics</b><span>Reading your latest assured report…</span></div></div>;
  if (state.kind === "failed") return <div className="nz-portal-state failed" role="alert"><i>!</i><div><b>Your metrics are temporarily unavailable</b><span>{state.message} No figures have been inferred.</span><button className="nz-btn" onClick={() => void load()}>Try again</button></div></div>;
  if (state.kind === "empty") return <div className="nz-portal-state empty"><i>✓</i><div><b>Your metrics will appear here</b><span>Once your first assured report for this job is published, its figures can be explored here — always the assured figures, never a draft.</span></div></div>;
  return <MetricsReady state={state} jobId={jobId} filters={filters} setFilters={setFilters} forms={forms} setForms={setForms} />;
}

function MetricsReady({ state, jobId, filters, setFilters, forms, setForms }: {
  state: Ready; jobId: string; filters: MetricFilters; setFilters: (filters: MetricFilters) => void;
  forms: Record<MetricChart, MetricForm>; setForms: (forms: Record<MetricChart, MetricForm>) => void;
}) {
  const { link } = usePortalSurface();
  const sites = useMemo(() => metricSites(state.rows), [state.rows]);
  const figures = useMemo(() => metricFigures(state.rows, filters), [state.rows, filters]);
  const trend = useMemo(() => metricTrend(state.dashboard.trend, filters.scope), [state.dashboard.trend, filters.scope]);
  const years = state.jobs.filter((job) => job.hasPublishedReport && job.reportingYear !== null);
  const setForm = (chart: MetricChart, form: MetricForm) => setForms({ ...forms, [chart]: form });
  const siteLabel = filters.site === ALL_SITES ? null : sites.find((site) => site.key === filters.site)?.label ?? null;
  const scopes = (["1", "2", "3"] as const);

  const scopeSlices: MetricSlice[] = scopes.map((scope) => ({ key: scope, label: SCOPE_NAMES[scope], value: figures.byScope[scope], color: tokens.scope[scope]! }));
  const categoryRows: MetricSlice[] = figures.byCategory.map((row) => ({ key: row.key, label: row.label, value: row.tco2e, color: tokens.scope[row.scope]! }));
  const siteRows: MetricSlice[] = figures.bySite.map((row) => ({ key: row.key, label: row.label, value: row.tco2e, color: tokens.brand.midnight, muted: !row.selected }));
  const trendSeries = trend.series.map((series) => ({ key: series.scope, label: `Scope ${series.scope}`, color: tokens.scope[series.scope]!, values: series.values }));

  return (
    <div className="nzp-metrics">
      <header className="nz-pd-top">
        <div>
          <span className="nz-eyebrow">Your emissions, your way</span>
          <h1 className="nz-pd-client">Metrics</h1>
          <p className="nz-pd-meta">Reporting year {state.dashboard.reportingYear} · from your assured, published report · switch any chart to the form that suits you</p>
        </div>
      </header>

      {/* Filters: one row, above the charts (dataviz: interaction). */}
      <div className="nzp-filters" role="group" aria-label="Filter the figures">
        {years.length > 1 ? (
          <label>Year
            <select className="nz-sel" value={jobId} onChange={(event) => { const href = link(`/portal/jobs/${encodeURIComponent(event.target.value)}/metrics`); if (href) window.location.assign(href); }}>
              {years.map((job) => <option key={job.id} value={job.id}>{job.reportingYear} · {job.number}</option>)}
            </select>
          </label>
        ) : <span className="nzp-filter-fixed">Year <b>{state.dashboard.reportingYear}</b></span>}
        <div className="nzp-seg" role="group" aria-label="Scope">
          {(["all", ...scopes] as const).map((scope) => (
            <button key={scope} type="button" aria-pressed={filters.scope === scope} onClick={() => setFilters({ ...filters, scope })}>{scope === "all" ? "All scopes" : `Scope ${scope}`}</button>
          ))}
        </div>
        {sites.length > 1 ? (
          <label>Site
            <select className="nz-sel" value={filters.site} onChange={(event) => setFilters({ ...filters, site: event.target.value })}>
              <option value={ALL_SITES}>All sites</option>
              {sites.map((site) => <option key={site.key} value={site.key}>{site.label}</option>)}
            </select>
          </label>
        ) : null}
        {filters.scope !== "all" || filters.site !== ALL_SITES ? <button type="button" className="nz-btn sm" onClick={() => setFilters({ scope: "all", site: ALL_SITES })}>Clear filters</button> : null}
      </div>

      <div className="nzp-stat">
        <span>{filters.scope === "all" && !siteLabel ? "Total emissions" : "Your selection"}</span>
        <b>{fmt(figures.total)} <small>{UNIT}</small></b>
        <em>{figures.reportTotal > 0 && figures.total !== figures.reportTotal ? `${Math.round((figures.total / figures.reportTotal) * 100)}% of your ${fmt(figures.reportTotal)} ${UNIT} total` : `Reporting year ${state.dashboard.reportingYear}`}
          {filters.scope !== "all" ? ` · ${SCOPE_NAMES[filters.scope]}` : ""}{siteLabel ? ` · ${siteLabel}` : ""}</em>
      </div>

      <div className="nzp-metric-grid">
        <Panel chart="scope" title="Emissions by scope" note={siteLabel ? `At ${siteLabel}.` : null} form={forms.scope} setForm={setForm}>
          {filters.scope !== "all" ? <p className="nzp-metric-note">Showing {SCOPE_NAMES[filters.scope]} only, so there is no split by scope to draw. Choose “All scopes” to compare them.</p>
            : forms.scope === "table" ? <FigureTable rows={scopeSlices} />
            : forms.scope === "bar" ? <MetricBars rows={scopeSlices} unit={UNIT} title="Emissions by scope" />
            : <MetricRing slices={scopeSlices} pie={forms.scope === "pie"} unit={UNIT} title="Emissions by scope" />}
        </Panel>
        <Panel chart="site" title="Emissions by site" note={siteLabel ? `${siteLabel} is highlighted against your other sites.` : null} form={forms.site} setForm={setForm}>
          {siteRows.length === 0 ? <p className="nzp-metric-note">No emissions in this selection.</p>
            : forms.site === "table" ? <FigureTable rows={siteRows} /> : <MetricBars rows={siteRows} unit={UNIT} title="Emissions by site" />}
        </Panel>
        <Panel chart="category" title="Emissions by category" note="Each bar is coloured by its scope." form={forms.category} setForm={setForm}>
          {categoryRows.length === 0 ? <p className="nzp-metric-note">No emissions in this selection.</p>
            : forms.category === "table" ? <FigureTable rows={categoryRows} /> : <MetricBars rows={categoryRows} unit={UNIT} title="Emissions by category" />}
        </Panel>
        <Panel chart="trend" title="Emissions over time" note={siteLabel ? "Earlier years are reported for your organisation as a whole, so the site filter does not apply here." : null} form={forms.trend} setForm={setForm}>
          {trend.years.length < 2 ? <p className="nzp-metric-note">Only one reporting year is published so far, so there is no trend to draw yet.</p>
            : forms.trend === "table" ? <TrendTable years={trend.years} series={trendSeries} />
            : <MetricTrend years={trend.years} series={trendSeries} form={forms.trend === "bar" ? "bar" : "line"} unit={UNIT} title="Emissions over time" />}
        </Panel>
      </div>
      <p className="nzp-metric-note">Every figure is from your assured, published report for reporting year {state.dashboard.reportingYear} — the same figures as your dashboard and report.</p>
    </div>
  );
}

function Panel({ chart, title, note, form, setForm, children }: { chart: MetricChart; title: string; note: string | null; form: MetricForm; setForm: (chart: MetricChart, form: MetricForm) => void; children: React.ReactNode }) {
  return (
    <section className="nzp-metric-card" aria-labelledby={`metric-${chart}`}>
      <div className="nzp-metric-h">
        <h3 id={`metric-${chart}`}>{title}</h3>
        <div className="nzp-seg sm" role="group" aria-label={`Show ${title.toLowerCase()} as`}>
          {metricFormsFor(chart).map((option) => <button key={option} type="button" aria-pressed={form === option} onClick={() => setForm(chart, option)}>{FORM_LABEL[option]}</button>)}
        </div>
      </div>
      {note ? <p className="nzp-metric-note">{note}</p> : null}
      {children}
    </section>
  );
}

function FigureTable({ rows }: { rows: MetricSlice[] }) {
  const total = rows.reduce((sum, row) => sum + row.value, 0);
  return (
    <table className="nz-tbl">
      <thead><tr><th>Name</th><th className="num">{UNIT}</th><th className="num">Share</th></tr></thead>
      <tbody>
        {rows.map((row) => <tr key={row.key}><td>{row.label}</td><td className="num">{fmt(row.value)}</td><td className="num">{total > 0 ? `${Math.round((row.value / total) * 100)}%` : "—"}</td></tr>)}
        <tr className="total"><td>Total</td><td className="num">{fmt(total)}</td><td className="num">100%</td></tr>
      </tbody>
    </table>
  );
}

function TrendTable({ years, series }: { years: number[]; series: Array<{ key: string; label: string; values: Array<number | null> }> }) {
  return (
    <table className="nz-tbl">
      <thead><tr><th>Year</th>{series.map((entry) => <th key={entry.key} className="num">{entry.label}</th>)}</tr></thead>
      <tbody>{years.map((year, index) => <tr key={year}><td>{year}</td>{series.map((entry) => <td key={entry.key} className="num">{entry.values[index] === null ? "not published" : fmt(entry.values[index]!)}</td>)}</tr>)}</tbody>
    </table>
  );
}
