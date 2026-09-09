"use client";

// Client portal Phase 2 · A1 — the client's headline emissions view. Every
// figure is sourced from the content-addressed PUBLISHED report snapshot (§0):
// the numbers + tables from /api/portal/jobs/[id]/dashboard (the shared assured
// baseline contract A2 also reads), the charts from the same published snapshot
// via @nzi/charts' `resolveCrpCoreCharts` (identical marks to the report/PDF).
// Charts carry text/provenance chrome; the tables below make every figure
// reachable without pixels (Narrator).
import { useCallback, useEffect, useState } from "react";
import { crpProfessionalManifest, ManifestChartSet, resolveCrpCoreCharts, type AnyChartData } from "@nzi/charts";
import { crpScopeCategoryLabel, portalTargetProgress, type PortalAssuredDashboard, type PublishedCrpReportReadModel } from "@nzi/contracts";
import { redirectIfPortalSessionEnded } from "../../portalSessionClient";
import { isPortalAssuredDashboard } from "./portalAnalyticsValidation";
import { isPublishedCrpReport } from "./publishedReportValidation";
import { formatDate } from "../../../lib/formatDate";

const fmt = (value: number) => value.toLocaleString("en-GB", { maximumFractionDigits: 1 });
const pct = (value: number) => `${(value * 100).toLocaleString("en-GB", { maximumFractionDigits: 0 })}%`;
const SCOPE_NAME: Record<"1" | "2" | "3", string> = { "1": "Scope 1 — direct", "2": "Scope 2 — purchased energy", "3": "Scope 3 — value chain" };

type State =
  | { kind: "loading" }
  | { kind: "failed"; message: string }
  | { kind: "empty" }
  | { kind: "ready"; dashboard: Extract<PortalAssuredDashboard, { published: true }>; charts: AnyChartData[]; snapshotId: string };

export function PortalDashboard({ jobId }: { jobId: string }) {
  const [state, setState] = useState<State>({ kind: "loading" });

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
      if (reportRes.ok) {
        const reportBody: unknown = await reportRes.json();
        if (reportBody && typeof reportBody === "object" && isPublishedCrpReport((reportBody as { report?: unknown }).report, jobId)) {
          const s = ((reportBody as { report: PublishedCrpReportReadModel }).report).snapshot;
          snapshotId = s.id;
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
      setState({ kind: "ready", dashboard, charts, snapshotId });
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
        <span>Once your NZI team publishes a verified report for this engagement, your emissions totals, scope split and trend will show on this page — always from the assured figures, never a work-in-progress draft.</span>
      </div>
    </div>
  );

  const { dashboard, charts, snapshotId } = state;
  const progress = portalTargetProgress(dashboard);
  const scopes: Array<"1" | "2" | "3"> = ["1", "2", "3"];

  return (
    <div className="nz-portal-dash">
      <div className="nz-portal-dash-head">
        <div>
          <span className="nz-eyebrow">Assured emissions · reporting year {dashboard.reportingYear}</span>
          <h2><b className="num">{fmt(dashboard.total)}</b> tCO₂e</h2>
          <p>From your published report version {dashboard.reportVersionId} · evidence {dashboard.dataHash.slice(0, 15)}… · published {formatDate(dashboard.publishedAt)}</p>
        </div>
        {dashboard.target ? (
          <div className={`nz-portal-dash-target${progress != null && progress >= 1 ? " met" : ""}`}>
            <span>Progress to your {dashboard.target.interimYear} interim target ({dashboard.target.interimReductionPercent}% below {dashboard.target.baselineYear})</span>
            <b>{progress == null ? "—" : pct(Math.max(0, Math.min(1, progress)))}</b>
            <div className="bar" aria-hidden="true"><i style={{ width: `${progress == null ? 0 : Math.max(0, Math.min(100, progress * 100))}%` }} /></div>
          </div>
        ) : null}
      </div>

      {charts.length ? (
        <div className="nz-portal-dash-charts">
          <ManifestChartSet manifest={crpProfessionalManifest} charts={charts} reviewedSnapshotId={snapshotId} />
        </div>
      ) : null}

      {/* Text/table equivalents — every figure reachable without the charts. */}
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

        {dashboard.bySite.length > 1 ? (
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
    </div>
  );
}
