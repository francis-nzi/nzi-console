"use client";

// DA3a (NZC-059) — the Data Assurance read surface for the Review & QA stage.
// The aggregate Outputs tables become the QA surface: a five-year trend read
// against the baseline (BL pill always shown, "% vs BL" its own column with the
// NZC-060 neutral tone when driven by an unresolved flag), plus By scope / By
// site / Audit / Intensity tabs. Behind `data-assurance`. Read-only — the gap
// drawer + resolve/fix (DA3b) and row approvals + sign-off (DA3c) come next.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  percentVsBaseline,
  percentVsBaselineTone,
  type AssuranceGap,
  type AssuranceScreen,
  type AssuranceTrend,
  type AssuranceTrendYear,
} from "@nzi/contracts";

type Tab = "trend" | "scope" | "site" | "audit" | "intensity";
type Screen = "loading" | "failed" | "ready";

const GAP_LABEL: Record<AssuranceGap["flag"], string> = {
  yoy_movement: "YoY", completeness: "missing", zero_blank: "zero", unmapped: "unmapped",
};
const fmt = (value: number | null): string =>
  value == null ? "—" : value.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (fraction: number | null): string =>
  fraction == null ? "—" : `${fraction < 0 ? "▼" : "▲"} ${Math.abs(fraction * 100).toLocaleString("en-GB", { maximumFractionDigits: 0 })}%`;

export function CrpAssuranceStage({ jobId }: { jobId: string }) {
  const [data, setData] = useState<AssuranceScreen | null>(null);
  const [state, setState] = useState<Screen>("loading");
  const [degraded, setDegraded] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("trend");

  const load = useCallback(async () => {
    setState("loading"); setDegraded(null);
    try {
      const response = await fetch(`/api/isolated/jobs/${jobId}/assurance`, { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message ?? "The assurance surface is unavailable.");
      setData(body as AssuranceScreen);
      setState("ready");
    } catch (error) {
      setDegraded(error instanceof Error ? error.message : "The assurance surface is unavailable.");
      setState("failed");
    }
  }, [jobId]);
  useEffect(() => { void load(); }, [load]);

  if (state === "loading") {
    return <section className="nz-panel nz-config-panel" aria-busy><div className="nz-register-loading" role="status"><i /><span><b>Loading data assurance</b><small>Five-year trend and the integrity gap engine…</small></span></div></section>;
  }
  // Failed read is never painted as a zeroed report (five explicit states).
  if (state === "failed" || !data) {
    return <section className="nz-panel nz-config-panel"><div className="nz-banner warn" role="alert"><div><b>Data assurance is unavailable</b><div>{degraded}</div></div></div><button className="nz-btn" onClick={() => void load()}>Retry</button></section>;
  }

  return <AssuranceSurface data={data} tab={tab} onTab={setTab} />;
}

function AssuranceSurface({ data, tab, onTab }: { data: AssuranceScreen; tab: Tab; onTab: (t: Tab) => void }) {
  const { trend, gaps, auditRows } = data;
  const current = trend.years.find((year) => year.kind === "current");
  const baseline = trend.years.find((year) => year.kind === "baseline");
  const openGaps = gaps.openCount;

  const gapsByScopeCode = useMemo(() => {
    const map = new Map<string, AssuranceGap[]>();
    for (const gap of gaps.gaps) {
      const key = gap.scopeCode ?? "—";
      map.set(key, [...(map.get(key) ?? []), gap]);
    }
    return map;
  }, [gaps]);

  // Union of every category seen across the trend, in scope then label order.
  const categories = useMemo(() => {
    const seen = new Map<string, { scope: "1" | "2" | "3"; scopeCode: string; label: string }>();
    for (const year of trend.years) {
      for (const category of year.byCategory) {
        if (!seen.has(category.scopeCode)) {
          seen.set(category.scopeCode, { scope: (category.scopeCode.split(".")[0] as "1" | "2" | "3"), scopeCode: category.scopeCode, label: category.label });
        }
      }
    }
    return [...seen.values()].sort((a, b) => a.scope.localeCompare(b.scope) || a.label.localeCompare(b.label));
  }, [trend]);

  const valueFor = (year: AssuranceTrendYear, scopeCode: string): number | null =>
    year.source === "none" ? null : year.byCategory.find((category) => category.scopeCode === scopeCode)?.tco2e ?? 0;

  return <section className="nz-panel nz-assurance">
    <header className="nz-assurance-head">
      <div>
        <span className="nz-eyebrow">Review &amp; QA · Data assurance</span>
        <div className="nz-assurance-meta">
          {trend.baselineYear != null
            ? <>Baseline year {trend.baselineYear} <span className="nz-bl-pill">BL</span></>
            : <>No baseline year set — configure a reduction target to enable % vs BL</>}
          {" · "}Reporting {trend.currentYear}
        </div>
      </div>
      <dl className="nz-assurance-summary">
        <div><dt>Total tCO₂e</dt><dd>{fmt(current?.total ?? null)}</dd></div>
        <div><dt>Scope 1</dt><dd className="s1">{fmt(current?.byScope["1"] ?? null)}</dd></div>
        <div><dt>Scope 2</dt><dd className="s2">{fmt(current?.byScope["2"] ?? null)}</dd></div>
        <div><dt>Scope 3</dt><dd className="s3">{fmt(current?.byScope["3"] ?? null)}</dd></div>
      </dl>
    </header>

    <div className={`nz-assurance-banner ${openGaps === 0 ? "ok" : "warn"}`} role="status">
      {openGaps === 0
        ? <><b>Data integrity check passed</b><span>Complete, consistent and fully costed across the trend.{gaps.resolvedCount ? ` ${gaps.resolvedCount} resolved with a reason.` : ""}</span></>
        : <><b>{openGaps} gap{openGaps === 1 ? "" : "s"} to resolve</b><span>Complete, consistent and fully costed across the trend before this stage can be signed off.</span></>}
      {gaps.gaps.length > 0 && <span className="nz-assurance-chips">
        {(["yoy_movement", "zero_blank", "completeness", "unmapped"] as const).map((flag) => {
          const n = gaps.gaps.filter((gap) => gap.flag === flag && !gap.resolved).length;
          return n ? <span key={flag} className={`nz-gap-chip ${flag}`}>{n} {GAP_LABEL[flag]}</span> : null;
        })}
      </span>}
    </div>

    <div className="nz-assurance-tabs" role="tablist">
      {([["trend", "5-year trend"], ["scope", "By scope"], ["site", "By site"], ["audit", "Audit table"], ["intensity", "Intensity"]] as const).map(([id, label]) => (
        <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "on" : ""} onClick={() => onTab(id)}>{label}</button>
      ))}
    </div>

    {tab === "trend" && <div className="nz-assurance-scroll">
      <table className="nz-tbl nz-assurance-trend">
        <thead><tr>
          <th>Scope</th><th>Category</th>
          {trend.years.map((year) => (
            <th key={year.year} className={`num${year.kind === "baseline" ? " bl" : year.kind === "current" ? " cur" : ""}`}>
              {year.year}{year.kind === "baseline" ? <span className="nz-bl-pill">BL</span> : year.kind === "current" ? <span className="nz-cur-pill">current</span> : null}
            </th>
          ))}
          <th className="num">% vs BL</th><th>Integrity</th>
        </tr></thead>
        <tbody>
          {(["1", "2", "3"] as const).map((scope) => {
            const scopeCategories = categories.filter((category) => category.scope === scope);
            if (scopeCategories.length === 0) return null;
            return <FragmentRows key={scope}>
              {scopeCategories.map((category) => {
                const currentValue = current ? valueFor(current, category.scopeCode) : null;
                const baselineValue = baseline ? valueFor(baseline, category.scopeCode) : null;
                const change = percentVsBaseline(currentValue, baselineValue);
                const tone = percentVsBaselineTone({ scopeCode: category.scopeCode, percent: change, gaps: gaps.gaps });
                const rowGaps = (gapsByScopeCode.get(category.scopeCode) ?? []).filter((gap) => !gap.resolved);
                return <tr key={category.scopeCode} className={rowGaps.length ? "nz-flagged" : ""}>
                  <td>Scope {scope}</td>
                  <td>{category.label}</td>
                  {trend.years.map((year) => (
                    <td key={year.year} className={`num${year.kind === "baseline" ? " bl" : year.kind === "current" ? " cur" : ""}`}>{fmt(valueFor(year, category.scopeCode))}</td>
                  ))}
                  <td className={`num nz-pct ${tone}`}>{pct(change)}</td>
                  <td>{rowGaps.map((gap) => <span key={gap.key} className={`nz-gap-chip ${gap.flag}`} title={gap.detail}>{GAP_LABEL[gap.flag]}</span>)}</td>
                </tr>;
              })}
              <tr className="sub">
                <td /><td>Scope {scope} subtotal</td>
                {trend.years.map((year) => <td key={year.year} className={`num${year.kind === "baseline" ? " bl" : year.kind === "current" ? " cur" : ""}`}>{year.source === "none" ? "—" : fmt(year.byScope[scope])}</td>)}
                <td className="num nz-pct">{pct(percentVsBaseline(current && current.source !== "none" ? current.byScope[scope] : null, baseline && baseline.source !== "none" ? baseline.byScope[scope] : null))}</td>
                <td />
              </tr>
            </FragmentRows>;
          })}
          <tr className="total">
            <td /><td>All scopes total</td>
            {trend.years.map((year) => <td key={year.year} className={`num${year.kind === "baseline" ? " bl" : year.kind === "current" ? " cur" : ""}`}>{fmt(year.total)}</td>)}
            <td className="num nz-pct">{pct(percentVsBaseline(current?.total ?? null, baseline?.total ?? null))}</td>
            <td />
          </tr>
        </tbody>
      </table>
    </div>}

    {tab === "scope" && <div className="nz-assurance-scroll">
      <p className="sub">Category amalgamation for the current year, with the baseline for comparison.</p>
      <table className="nz-tbl">
        <thead><tr><th>Scope</th><th>Category</th><th className="num">Baseline{trend.baselineYear ? ` (${trend.baselineYear})` : ""}</th><th className="num cur">{trend.currentYear}</th></tr></thead>
        <tbody>
          {(["1", "2", "3"] as const).map((scope) => {
            const scopeCategories = categories.filter((category) => category.scope === scope);
            if (scopeCategories.length === 0) return null;
            return <FragmentRows key={scope}>
              {scopeCategories.map((category) => (
                <tr key={category.scopeCode}><td>Scope {scope}</td><td>{category.label}</td>
                  <td className="num">{fmt(baseline ? valueFor(baseline, category.scopeCode) : null)}</td>
                  <td className="num cur">{fmt(current ? valueFor(current, category.scopeCode) : null)}</td></tr>
              ))}
              <tr className="sub"><td /><td>Scope {scope}</td>
                <td className="num">{baseline && baseline.source !== "none" ? fmt(baseline.byScope[scope]) : "—"}</td>
                <td className="num cur">{current && current.source !== "none" ? fmt(current.byScope[scope]) : "—"}</td></tr>
            </FragmentRows>;
          })}
          <tr className="total"><td /><td>Total</td><td className="num">{fmt(baseline?.total ?? null)}</td><td className="num cur">{fmt(current?.total ?? null)}</td></tr>
        </tbody>
      </table>
    </div>}

    {tab === "site" && <div className="nz-assurance-scroll">
      <p className="sub">Emissions by site for the current year. <b>Unallocated</b> rows are a completeness signal — every activity should resolve to a place.</p>
      <table className="nz-tbl">
        <thead><tr><th>Site</th><th className="num cur">{trend.currentYear} tCO₂e</th><th className="num">% of total</th></tr></thead>
        <tbody>
          {(current?.bySite ?? []).map((site) => {
            const share = current?.total ? site.tco2e / current.total : 0;
            const unplaced = site.siteId === null && site.tco2e > 0;
            return <tr key={site.siteId ?? "unallocated"} className={unplaced ? "nz-flagged" : ""}>
              <td>{site.label}{unplaced && <span className="nz-gap-chip completeness" style={{ marginLeft: 6 }}>{fmt(site.tco2e)} unplaced</span>}</td>
              <td className="num cur">{fmt(site.tco2e)}</td>
              <td className="num">{(share * 100).toLocaleString("en-GB", { maximumFractionDigits: 1 })}%</td>
            </tr>;
          })}
          <tr className="total"><td>Total</td><td className="num cur">{fmt(current?.total ?? null)}</td><td className="num">100%</td></tr>
        </tbody>
      </table>
    </div>}

    {tab === "audit" && <div className="nz-assurance-scroll">
      <p className="sub">Row-level lineage — every enabled canonical row with its factor, activity, quality tier, confidence and review state.</p>
      <table className="nz-tbl">
        <thead><tr><th>Category</th><th>Activity / factor</th><th className="num">Qty</th><th>Quality</th><th>Conf.</th><th>Site</th><th>Review</th></tr></thead>
        <tbody>
          {auditRows.map((row) => (
            <tr key={row.rowId} className={row.factorLabel ? "" : "nz-flagged"}>
              <td>{row.category}</td>
              <td>{row.factorLabel ?? <span className="muted">no factor selected</span>}<div className="muted">{row.sourceLabel}</div></td>
              <td className="num">{row.quantity == null ? "—" : `${row.quantity.toLocaleString("en-GB")}${row.unit ? ` ${row.unit}` : ""}`}</td>
              <td>{row.qualityTier ?? "—"}</td>
              <td>{row.dataConfidence ?? "—"}</td>
              <td>{row.siteLabel}</td>
              <td><span className={`nz-st ${row.reviewStatus === "approved" ? "done" : row.reviewStatus === "rejected" ? "nof" : "est"}`}>{row.reviewStatus}</span></td>
            </tr>
          ))}
          {auditRows.length === 0 && <tr><td colSpan={7} className="nz-table-empty">No enabled rows yet.</td></tr>}
        </tbody>
      </table>
    </div>}

    {tab === "intensity" && <div className="nz-assurance-scroll">
      <p className="sub">Normalised metric across the trend — the same totals against the job&rsquo;s reporting denominator.</p>
      <table className="nz-tbl">
        <thead><tr><th>Metric</th>{trend.years.map((year) => <th key={year.year} className={`num${year.kind === "baseline" ? " bl" : year.kind === "current" ? " cur" : ""}`}>{year.year}</th>)}</tr></thead>
        <tbody>
          <tr>
            <td>{current?.intensityUnit ?? "Emissions intensity"}</td>
            {trend.years.map((year) => <td key={year.year} className={`num${year.kind === "baseline" ? " bl" : year.kind === "current" ? " cur" : ""}`}>{year.intensity == null ? "—" : year.intensity.toLocaleString("en-GB", { maximumFractionDigits: 2 })}</td>)}
          </tr>
          {trend.years.every((year) => year.intensity == null) && <tr><td colSpan={trend.years.length + 1} className="nz-table-empty">No intensity target / reporting denominator set for this job.</td></tr>}
        </tbody>
      </table>
    </div>}

    <div className="nz-assurance-actions">
      <button className="nz-btn" onClick={() => exportTrendCsv(trend)}>⭳ Export trend CSV</button>
    </div>
  </section>;
}

function FragmentRows({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

function exportTrendCsv(trend: AssuranceTrend): void {
  const years = trend.years.map((year) => year.year);
  const header = ["Scope", "Category", ...years.map(String), "% vs BL"];
  const current = trend.years.find((year) => year.kind === "current");
  const baseline = trend.years.find((year) => year.kind === "baseline");
  const seen = new Map<string, string>();
  for (const year of trend.years) for (const category of year.byCategory) seen.set(category.scopeCode, category.label);
  const lines = [header.join(",")];
  for (const [scopeCode, label] of seen) {
    const scope = scopeCode.split(".")[0];
    const cells = trend.years.map((year) => (year.source === "none" ? "" : String(year.byCategory.find((c) => c.scopeCode === scopeCode)?.tco2e ?? 0)));
    const cur = current?.byCategory.find((c) => c.scopeCode === scopeCode)?.tco2e ?? null;
    const base = baseline?.byCategory.find((c) => c.scopeCode === scopeCode)?.tco2e ?? null;
    const change = percentVsBaseline(cur, base);
    lines.push([`Scope ${scope}`, `"${label.replace(/"/g, '""')}"`, ...cells, change == null ? "" : (change * 100).toFixed(1)].join(","));
  }
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `assurance-trend-${trend.jobId}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}
