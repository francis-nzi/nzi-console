"use client";

// DA3 (NZC-059/060) — the Data Assurance surface for the Review & QA stage.
// DA3a: the aggregate Outputs tables are the QA surface — a five-year trend
// read against the baseline (BL pill always shown, "% vs BL" its own column
// with the NZC-060 neutral tone when driven by an unresolved flag), plus By
// scope / By site / Audit / Intensity tabs. DA3b: the right overlay drawer
// (does not dock — the tables keep full width) with the gaps list,
// resolve-with-reason (`assurance.gap.resolve`, optimistic + expectedVersion),
// and a row-detail view (select a row → its evidence). Behind `data-assurance`.
// DA3c: independent row approval in the row-detail view (the existing
// scope.review.approve/reject commands, unforked — same
// /scope-rows/{id}/review endpoint the legacy Data entry panel uses) and the
// governed sign-off gate, blocked while any gap is open or any enabled row is
// unapproved. The gate composes read-only signals this surface already has;
// the freeze itself reuses report.snapshot.create unforked — that command now
// also blocks server-side on open gaps (GAPS_OPEN), same transaction as the
// existing QA_INCOMPLETE check.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { postBrowserCommand, postBrowserCommandWithReason } from "@nzi/api-client";
import type { ReingestAttestationPlan, ReingestAttestationResult } from "@nzi/isolated-backend";
import { Drawer, GatedButton, Tabs, TabPanel, type TabDescriptor } from "@nzi/ui";
import {
  percentVsBaseline,
  percentVsBaselineTone,
  type AssuranceAuditRow,
  type AssuranceGap,
  type AssuranceScreen,
  type AssuranceTrend,
  type AssuranceTrendYear,
  type ReviewedCrpSnapshotReadModel,
} from "@nzi/contracts";
import { formatQuantity, formatTonnes } from "../lib/formatNumber";
import { useStaffMe } from "../lib/useEditAccess";
import { filterAuditRows, filterGaps, worklistCounts, type GapFilter, type Worklist } from "./assuranceWorklist";
import { CategoryLinesDrawer } from "./CategoryLinesDrawer";
import { isSelfApproved, readIndependentApprovalRequired, snapshotActAccess } from "./snapshotApproval";

type Tab = "trend" | "scope" | "site" | "audit" | "intensity";
type Screen = "loading" | "failed" | "ready";

const TAB_ITEMS: readonly TabDescriptor[] = [
  { id: "trend", label: "5-year trend" }, { id: "scope", label: "By scope" },
  { id: "site", label: "By site" }, { id: "audit", label: "Audit table" }, { id: "intensity", label: "Intensity" },
];

const GAP_LABEL: Record<AssuranceGap["flag"], string> = {
  yoy_movement: "YoY", completeness: "missing", zero_blank: "zero", unmapped: "unmapped", out_of_boundary: "out of boundary",
};
const fmt = (value: number | null): string =>
  value == null ? "—" : value.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (fraction: number | null): string =>
  fraction == null ? "—" : `${fraction < 0 ? "▼" : "▲"} ${Math.abs(fraction * 100).toLocaleString("en-GB", { maximumFractionDigits: 0 })}%`;

export function CrpAssuranceStage({ jobId, onGoToRow }: { jobId: string; onGoToRow?: (rowId: string) => void }) {
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
  // SPEC §2: after a decision (approve, reject, resolve, sign-off) the surface re-reads in place — it stays mounted, so the
  // drawer and the selected row stay put — and the page's server data (the Step 3 "pending · approved" counter, the register,
  // the category view) is refreshed with it, so every count moves without a reload. A failed re-read keeps the last good data
  // and says so, rather than blanking the surface.
  const router = useRouter();
  const refresh = useCallback(async () => {
    router.refresh();
    try {
      const response = await fetch(`/api/isolated/jobs/${jobId}/assurance`, { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message ?? "The assurance surface could not be refreshed.");
      setData(body as AssuranceScreen);
      setDegraded(null);
    } catch (error) {
      setDegraded(error instanceof Error ? error.message : "The assurance surface could not be refreshed.");
    }
  }, [jobId, router]);

  if (state === "loading") {
    return <section className="nz-panel nz-config-panel" aria-busy><div className="nz-register-loading" role="status"><i /><span><b>Loading data assurance</b><small>Five-year trend and the integrity gap engine…</small></span></div></section>;
  }
  // Failed read is never painted as a zeroed report (five explicit states).
  if (state === "failed" || !data) {
    return <section className="nz-panel nz-config-panel"><div className="nz-banner warn" role="alert"><div><b>Data assurance is unavailable</b><div>{degraded}</div></div></div><button className="nz-btn" onClick={() => void load()}>Retry</button></section>;
  }

  return <>
    {degraded ? <div className="nz-banner warn" role="alert"><div>{degraded} The figures below are from the last successful read.</div></div> : null}
    <AssuranceSurface jobId={jobId} data={data} tab={tab} onTab={setTab} onReload={() => void refresh()} onGoToRow={onGoToRow} />
  </>;
}

function AssuranceSurface({ jobId, data, tab, onTab, onReload, onGoToRow }: { jobId: string; data: AssuranceScreen; tab: Tab; onTab: (t: Tab) => void; onReload: () => void; onGoToRow?: (rowId: string) => void }) {
  const { trend, gaps, auditRows } = data;
  const [worklist, setWorklist] = useState<Worklist>("todo");
  const counts = worklistCounts(auditRows, gaps.gaps);
  const shownAuditRows = filterAuditRows(auditRows, gaps.gaps, worklist);
  const [drawerOpen, setDrawerOpen] = useState(true);
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);
  // D3 (R5): the category whose lines are open across the years (one drawer at a time: the assurance drawer closes for it).
  const [linesFor, setLinesFor] = useState<{ scopeCode: string; label: string } | null>(null);
  const openLines = (category: { scopeCode: string; label: string }) => { setDrawerOpen(false); setLinesFor(category); };
  const openRowDetail = (rowId: string) => { setSelectedRowId(rowId); setDrawerOpen(true); };
  // The reopen toggle is conditionally rendered, so Drawer can't restore focus
  // to it — do it here once it re-mounts after a close (WCAG 2.4.3).
  const reopenRef = useRef<HTMLButtonElement>(null);
  const closedByUser = useRef(false);
  useEffect(() => { if (!drawerOpen && closedByUser.current) { reopenRef.current?.focus(); closedByUser.current = false; } }, [drawerOpen]);
  const current = trend.years.find((year) => year.kind === "current");
  const baseline = trend.years.find((year) => year.kind === "baseline");
  const openGaps = gaps.openCount;
  const pendingReview = counts.awaitingReview;
  const canSignOff = auditRows.length > 0 && openGaps === 0 && pendingReview === 0;

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
        {(["yoy_movement", "zero_blank", "completeness", "unmapped", "out_of_boundary"] as const).map((flag) => {
          const n = gaps.gaps.filter((gap) => gap.flag === flag && !gap.resolved).length;
          return n ? <span key={flag} className={`nz-gap-chip ${flag}`}>{n} {GAP_LABEL[flag]}</span> : null;
        })}
      </span>}
    </div>

    <Tabs items={TAB_ITEMS} value={tab} onChange={(id) => onTab(id as Tab)} ariaLabel="Data assurance views" idBase="assurance" className="nz-assurance-tabs" />

    <TabPanel id="trend" idBase="assurance" active={tab === "trend"} className="nz-assurance-scroll">
      <table className="nz-tbl nz-assurance-trend">
        <thead><tr>
          <th>Scope</th><th>Category</th>
          {trend.years.map((year) => (
            <th key={year.year} className={`num${year.year === trend.baselineYear ? " bl" : year.kind === "current" ? " cur" : ""}`}>
              {year.year}
              {year.year === trend.baselineYear ? <span className="nz-bl-pill">BL</span> : null}
              {year.kind === "current" ? <span className="nz-cur-pill">current</span> : null}
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
                  <td>{category.label} <button type="button" className="lnk nz-lines-open" onClick={() => openLines(category)} aria-label={`${category.label}: lines across the years`}>Lines ›</button></td>
                  {trend.years.map((year) => (
                    <td key={year.year} className={`num${year.year === trend.baselineYear ? " bl" : year.kind === "current" ? " cur" : ""}`}>{fmt(valueFor(year, category.scopeCode))}</td>
                  ))}
                  <td className={`num nz-pct ${tone}`}>{pct(change)}</td>
                  <td>{rowGaps.map((gap) => <span key={gap.key} className={`nz-gap-chip ${gap.flag}`} title={gap.detail}>{GAP_LABEL[gap.flag]}</span>)}</td>
                </tr>;
              })}
              <tr className="sub">
                <td /><td>Scope {scope} subtotal</td>
                {trend.years.map((year) => <td key={year.year} className={`num${year.year === trend.baselineYear ? " bl" : year.kind === "current" ? " cur" : ""}`}>{year.source === "none" ? "—" : fmt(year.byScope[scope])}</td>)}
                <td className="num nz-pct">{pct(percentVsBaseline(current && current.source !== "none" ? current.byScope[scope] : null, baseline && baseline.source !== "none" ? baseline.byScope[scope] : null))}</td>
                <td />
              </tr>
            </FragmentRows>;
          })}
          <tr className="total">
            <td /><td>All scopes total</td>
            {trend.years.map((year) => <td key={year.year} className={`num${year.year === trend.baselineYear ? " bl" : year.kind === "current" ? " cur" : ""}`}>{fmt(year.total)}</td>)}
            <td className="num nz-pct">{pct(percentVsBaseline(current?.total ?? null, baseline?.total ?? null))}</td>
            <td />
          </tr>
        </tbody>
      </table>
    </TabPanel>

    <TabPanel id="scope" idBase="assurance" active={tab === "scope"} className="nz-assurance-scroll">
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
    </TabPanel>

    <TabPanel id="site" idBase="assurance" active={tab === "site"} className="nz-assurance-scroll">
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
    </TabPanel>

    <TabPanel id="audit" idBase="assurance" active={tab === "audit"} className="nz-assurance-scroll">
      <p className="sub">Row-level lineage — every enabled canonical row with its factor, activity, quality tier, confidence and review state. A row is <b>done</b> once it is approved and none of its own gaps is open.</p>
      <div className="nz-assurance-worklist" role="group" aria-label="Working list">
        <span className="nz-seg">
          {([["todo", `To do (${counts.todo})`], ["done", `Done (${counts.done})`], ["all", `All (${auditRows.length})`]] as const).map(([id, label]) => (
            <button key={id} type="button" aria-pressed={worklist === id} className={worklist === id ? "on" : undefined} onClick={() => setWorklist(id)}>{label}</button>
          ))}
        </span>
        <span className="muted" role="status">{counts.awaitingReview} awaiting review · {counts.approved} approved · {counts.openGaps} gap{counts.openGaps === 1 ? "" : "s"} open</span>
      </div>
      <table className="nz-tbl">
        <thead><tr><th>Category</th><th>Activity / factor</th><th className="num">Qty</th><th>Quality</th><th>Conf.</th><th>Site</th><th>Review</th></tr></thead>
        <tbody>
          {shownAuditRows.map((row) => (
            <tr key={row.rowId} className={`nz-audit-row${row.factorLabel ? "" : " nz-flagged"}`} tabIndex={0} onClick={() => openRowDetail(row.rowId)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openRowDetail(row.rowId); } }}>
              <td>{row.category}</td>
              <td>{row.factorLabel ?? <span className="muted">no factor selected</span>}<div className="muted">{row.sourceLabel}</div></td>
              <td className="num">{row.quantity == null ? "—" : `${formatQuantity(row.quantity)}${row.unit ? ` ${row.unit}` : ""}`}</td>
              <td>{row.qualityTier ?? "—"}</td>
              <td>{row.dataConfidence ?? "—"}</td>
              <td>{row.siteLabel}</td>
              <td><span className={`nz-st ${row.reviewStatus === "approved" ? "done" : row.reviewStatus === "rejected" ? "nof" : "est"}`}>{row.reviewStatus}</span></td>
            </tr>
          ))}
          {auditRows.length === 0 && <tr><td colSpan={7} className="nz-table-empty">No enabled rows yet.</td></tr>}
          {auditRows.length > 0 && shownAuditRows.length === 0 && <tr><td colSpan={7} className="nz-table-empty">{worklist === "todo" ? "Nothing left to do — every row is approved with its gaps resolved." : "No rows are done yet."}</td></tr>}
        </tbody>
      </table>
    </TabPanel>

    <TabPanel id="intensity" idBase="assurance" active={tab === "intensity"} className="nz-assurance-scroll">
      <p className="sub">Normalised metric across the trend — the same totals divided by the job&rsquo;s intensity Value.</p>
      <table className="nz-tbl">
        <thead><tr><th>Metric</th>{trend.years.map((year) => <th key={year.year} className={`num${year.year === trend.baselineYear ? " bl" : year.kind === "current" ? " cur" : ""}`}>{year.year}</th>)}</tr></thead>
        <tbody>
          <tr>
            <td>{current?.intensityUnit ?? "Emissions intensity"}</td>
            {trend.years.map((year) => <td key={year.year} className={`num${year.year === trend.baselineYear ? " bl" : year.kind === "current" ? " cur" : ""}`}>{year.intensity == null ? "—" : year.intensity.toLocaleString("en-GB", { maximumFractionDigits: 2 })}</td>)}
          </tr>
          {trend.years.every((year) => year.intensity == null) && <tr><td colSpan={trend.years.length + 1} className="nz-table-empty">No intensity metric or Value set for this job.</td></tr>}
        </tbody>
      </table>
    </TabPanel>

    <div className="nz-assurance-actions">
      <button className="nz-btn" onClick={() => exportTrendCsv(trend)}>⭳ Export trend CSV</button>
      {!drawerOpen && <button ref={reopenRef} type="button" className="nz-assurance-reopen" onClick={() => setDrawerOpen(true)}>🛡 Data assurance {gaps.openCount > 0 && <span className="n">{gaps.openCount}</span>}</button>}
    </div>

    <ReingestAttestPanel jobId={jobId} readKey={data} onAttested={onReload} />

    <SignOffPanel jobId={jobId} canSignOff={canSignOff} openGaps={openGaps} pendingReview={pendingReview} onSignedOff={onReload} />

    <SnapshotApprovalPanel jobId={jobId} readKey={data} onApproved={onReload} />

    <AssuranceDrawer
      open={drawerOpen}
      jobId={jobId}
      gaps={gaps.gaps}
      auditRows={auditRows}
      selectedRowId={selectedRowId}
      onSelectRow={setSelectedRowId}
      onClose={() => { closedByUser.current = true; setDrawerOpen(false); setSelectedRowId(null); }}
      onResolved={onReload}
      onEditRow={onGoToRow}
    />
    <CategoryLinesDrawer jobId={jobId} category={linesFor} onClose={() => setLinesFor(null)} />
  </section>;
}

type DrawerSegment = "gaps" | "row";

function AssuranceDrawer({ open, jobId, gaps, auditRows, selectedRowId, onSelectRow, onClose, onResolved, onEditRow }: {
  open: boolean;
  jobId: string;
  gaps: AssuranceGap[];
  auditRows: AssuranceAuditRow[];
  selectedRowId: string | null;
  onSelectRow: (rowId: string | null) => void;
  onClose: () => void;
  onResolved: () => void;
  onEditRow?: (rowId: string) => void;
}) {
  const [segment, setSegment] = useState<DrawerSegment>(selectedRowId ? "row" : "gaps");
  useEffect(() => { if (selectedRowId) setSegment("row"); }, [selectedRowId]);
  const selectedRow = selectedRowId ? auditRows.find((row) => row.rowId === selectedRowId) ?? null : null;
  const openCount = gaps.filter((gap) => !gap.resolved).length;
  // SPEC §2: a resolved gap leaves the open list; it stays reachable under "Resolved".
  const [gapFilter, setGapFilter] = useState<GapFilter>("open");
  const shownGaps = filterGaps(gaps, gapFilter);

  return <Drawer open={open} onClose={onClose} ariaLabel="Data assurance detail" className="nz-assurance-drawer">
    <div className="nz-assurance-drawer-h">
      <div className="top"><span className="ctx">Detail · this stage</span><button type="button" className="close" onClick={onClose} aria-label="Close data assurance detail">✕</button></div>
      <div className="ttl"><h3>{segment === "row" ? "Row detail" : "Data assurance"}</h3>{segment === "gaps" && <span className="count">{openCount} open</span>}</div>
    </div>
    <Tabs
      items={[{ id: "gaps", label: `Gaps (${gaps.length})` }, { id: "row", label: "Row detail", disabled: !selectedRow }]}
      value={segment}
      onChange={(id) => { const seg = id as DrawerSegment; setSegment(seg); if (seg === "gaps") onSelectRow(null); }}
      ariaLabel="Drawer view"
      idBase="assurance-drawer"
      className="nz-assurance-drawer-seg"
    />

    <TabPanel id="row" idBase="assurance-drawer" active={segment === "row" && !!selectedRow}>
      {selectedRow && <RowDetail jobId={jobId} row={selectedRow} onEditRow={onEditRow} onReviewed={onResolved} />}
    </TabPanel>

    <TabPanel id="gaps" idBase="assurance-drawer" active={segment === "gaps"}>
      {gaps.length > 0 && <div className="nz-assurance-worklist" role="group" aria-label="Gaps shown">
        <span className="nz-seg">
          {([["open", `Open (${openCount})`], ["resolved", `Resolved (${gaps.length - openCount})`], ["all", `All (${gaps.length})`]] as const).map(([id, label]) => (
            <button key={id} type="button" aria-pressed={gapFilter === id} className={gapFilter === id ? "on" : undefined} onClick={() => setGapFilter(id)}>{label}</button>
          ))}
        </span>
      </div>}
      <ol className="nz-assurance-gaps">
        {shownGaps.map((gap) => <GapCard key={gap.key} jobId={jobId} gap={gap} onSelectRow={onSelectRow} onResolved={onResolved} />)}
        {gaps.length === 0 && <li className="nz-assurance-gap-empty">No integrity gaps — the dataset is complete, consistent and fully costed.</li>}
        {gaps.length > 0 && shownGaps.length === 0 && <li className="nz-assurance-gap-empty">{gapFilter === "open" ? "No open gaps — every gap is resolved with a reason." : "No resolved gaps yet."}</li>}
      </ol>
      <p className="nz-assurance-drawer-note">This is the workspace&rsquo;s shared detail drawer — selecting any row shows its evidence here. By default it lists the assurance gaps. Each is <b>fixed</b> (edit the row) or <b>resolved with a reason</b>, recorded on the row&rsquo;s provenance so sign-off is defensible.</p>
    </TabPanel>
  </Drawer>;
}

function RowDetail({ jobId, row, onEditRow, onReviewed }: { jobId: string; row: AssuranceAuditRow; onEditRow?: (rowId: string) => void; onReviewed: () => void }) {
  return <div className="nz-assurance-row-detail">
    <div className="nz-kv"><span className="k">Category</span><span className="v">{row.category}</span></div>
    <div className="nz-kv"><span className="k">Activity</span><span className="v">{row.sourceLabel}</span></div>
    <div className="nz-kv"><span className="k">Factor</span><span className="v">{row.factorLabel ?? "No factor selected"}</span></div>
    <div className="nz-kv"><span className="k">Quantity</span><span className="v">{row.quantity == null ? "—" : `${formatQuantity(row.quantity)}${row.unit ? ` ${row.unit}` : ""}`}</span></div>
    <div className="nz-kv"><span className="k">Quality tier</span><span className="v">{row.qualityTier ?? "—"}</span></div>
    <div className="nz-kv"><span className="k">Data confidence</span><span className="v">{row.dataConfidence ?? "—"}</span></div>
    <div className="nz-kv"><span className="k">Site</span><span className="v">{row.siteLabel}</span></div>
    <div className="nz-kv"><span className="k">Review</span><span className="v">{row.reviewStatus}{row.reviewStatus === "rejected" && row.reviewerNote ? ` — ${row.reviewerNote}` : ""}</span></div>
    {onEditRow && <button className="nz-btn" style={{ marginTop: 10 }} onClick={() => onEditRow(row.rowId)}>Edit in Data entry →</button>}
    <RowReview row={row} jobId={jobId} onReviewed={onReviewed} />
  </div>;
}

/** DA3c — independent review in-stage: the same scope.review.approve/reject
 *  commands the legacy Data entry row panel calls, surfaced here so a reviewer
 *  need not leave the assurance surface to clear the sign-off gate. */
function RowReview({ jobId, row, onReviewed }: { jobId: string; row: AssuranceAuditRow; onReviewed: () => void }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function decide(decision: "approved" | "rejected") {
    if (busy || (decision === "rejected" && !note.trim())) return;
    setBusy(true); setError(null);
    const result = await postBrowserCommand<{ decision: string; version: number }>(
      `/api/isolated/jobs/${jobId}/scope-rows/${row.rowId}/review`,
      { decision, expectedReviewVersion: row.version, reviewerNote: note.trim() || undefined },
      crypto.randomUUID(),
    );
    setBusy(false);
    if (result.state !== "success") { setError(result.state === "validation_failed" ? result.issues[0]?.message ?? "Could not record the review." : result.message); return; }
    setNote("");
    onReviewed();
  }

  if (row.reviewStatus === "approved") {
    return <div className="nz-banner ok" style={{ marginTop: 12 }}>Approved{row.reviewerNote ? ` — ${row.reviewerNote}` : ""}.</div>;
  }
  return <div className="nz-assurance-row-review">
    <div className="nz-sect" style={{ marginTop: 12 }}>Independent review</div>
    <textarea className="nz-notes" style={{ width: "100%" }} value={note} onChange={(event) => setNote(event.target.value)} placeholder="Reviewer note (required for rejection)" rows={2} />
    <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 6, flexWrap: "wrap" }}>
      <GatedButton className="nz-btn" blocked={busy || !note.trim()} blockedReason={!busy && !note.trim() ? "A reviewer note is required to reject" : undefined} onClick={() => void decide("rejected")}>Reject</GatedButton>
      <GatedButton className="nz-btn pri" blocked={busy || !row.qualityTier} blockedReason={!busy && !row.qualityTier ? "Set a quality tier on the row before approving" : undefined} onClick={() => void decide("approved")}>Approve row</GatedButton>
    </div>
    {error && <div className="nz-banner warn" role="alert">{error}</div>}
  </div>;
}

/** DA3c — the governed sign-off gate: composes "all gaps resolved" (openGaps)
 *  and "all enabled rows approved" (pendingReview), both already read by this
 *  surface. The freeze is the existing report.snapshot.create/reviewed-snapshots
 *  endpoint, unforked — it now also enforces the gap half of this gate itself. */
/**
 * RULING-reingest-bulk-attest (D7): one reviewer's attestation over a re-ingest run's rows — shown only when the job has a
 * completed re-ingest with something left to attest. It previews first (the act's own plan, read-only) and says exactly what the
 * act will and will not do: the rows it approves, the record-of-account gaps it resolves, what it skips and what it leaves for an
 * individual Resolve. A reason is required. Re-previewed whenever the surface re-reads, so it never offers a stale plan; the act
 * itself refuses anything that moved since (CHANGED_SINCE_PREVIEW).
 *
 * RULING-v7-book-runner R3: the rows carry v7's input and their figure is the console's calculation. Each emission delta against
 * v7 the run flags (> 5%, or a 0 → non-zero move) is listed, and the act stays blocked until the reviewer has ticked every one as
 * investigated — what they tick is sent, and the act refuses anything but exactly the flagged set.
 */
function ReingestAttestPanel({ jobId, readKey, onAttested }: { jobId: string; readKey: unknown; onAttested: () => void }) {
  const [plan, setPlan] = useState<ReingestAttestationPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState<string[]>([]);
  // A new preview is a new set of flags: nothing carries over from the last one.
  useEffect(() => { setAcknowledged([]); }, [plan]);
  const base = `/api/isolated/jobs/${jobId}/reingest-attestation`;

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const response = await fetch(`${base}/preview`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() }, body: "{}" });
        const body = await response.json();
        if (!live) return;
        if (!response.ok) { setPlan(null); setError(body?.issues?.[0]?.message ?? body?.message ?? "The attestation preview could not be read."); return; }
        setPlan(body as ReingestAttestationPlan); setError(null);
      } catch { if (live) setError("The attestation preview could not be read."); }
    })();
    return () => { live = false; };
  }, [base, readKey]);

  async function attest() {
    if (!plan?.runId || busy || !reason.trim()) return;
    setBusy(true); setError(null);
    const result = await postBrowserCommandWithReason<ReingestAttestationResult>(base,
      { runId: plan.runId, rows: plan.attest.map((row) => ({ rowId: row.rowId, expectedReviewVersion: row.version })), gapKeys: plan.gaps.map((gap) => gap.gapKey), acknowledgedDeltas: acknowledged },
      crypto.randomUUID(), reason.trim());
    setBusy(false);
    if (result.state !== "success") { setError(result.state === "validation_failed" ? result.issues[0]?.message ?? result.message : result.message); onAttested(); return; }
    setDone(`Attested — ${result.data.approved} row${result.data.approved === 1 ? "" : "s"} approved, ${result.data.gapsResolved} record-of-account gap${result.data.gapsResolved === 1 ? "" : "s"} resolved.`);
    setReason("");
    onAttested();
  }

  if (done && (!plan || (plan.attest.length === 0 && plan.gaps.length === 0))) return <div className="nz-assurance-signoff"><div className="nz-banner ok" role="status">{done}</div></div>;
  if (!plan) return error ? <div className="nz-assurance-signoff"><div className="nz-banner warn" role="alert">{error}</div></div> : null;
  if (!plan.runId || (plan.attest.length === 0 && plan.gaps.length === 0 && plan.blocked.length === 0)) return null;
  const zeros = plan.gaps.filter((gap) => gap.flag === "zero_blank").length, totals = plan.gaps.length - zeros;
  const flagged = plan.deltas?.flagged ?? [];
  const unacknowledged = flagged.filter((key) => !acknowledged.includes(key)).length;
  const blockedReason = plan.reviewerRefusal ?? (plan.blocked.length ? `${plan.blocked.length} row${plan.blocked.length === 1 ? "" : "s"} cannot be attested — see below`
    : unacknowledged ? `${unacknowledged} flagged emission delta${unacknowledged === 1 ? "" : "s"} still to investigate` : !reason.trim() ? "A reason is required" : undefined);
  const deltaOf = (key: string) => key === "job" ? plan.deltas!.job : plan.deltas!.rows.find((row) => row.v7RowId === key)!;
  const percent = (relative: number | null) => relative === null ? "v7 recorded 0" : `${relative > 0 ? "+" : ""}${(relative * 100).toFixed(1)}%`;
  return <div className="nz-assurance-signoff nz-attest" aria-label="Attest re-ingested rows">
    <div className="nz-sect">Attest re-ingested rows</div>
    <p style={{ fontSize: 13, margin: "4px 0 8px" }}>
      &ldquo;I attest that these <b>{plan.attest.length}</b> row{plan.attest.length === 1 ? "" : "s"} carry NZ Insights Pro v7&rsquo;s input exactly, verified by re-ingest D7.2, with each emission by the console&rsquo;s own calculation.&rdquo;
      {" "}Each is recorded as your own approval. Nothing is edited.
    </p>
    {flagged.length ? <fieldset className="nz-banner warn" style={{ display: "block", margin: "0 0 8px" }} aria-label="Emission deltas against v7">
      <legend style={{ fontWeight: 600 }}>Emission deltas against v7 — investigate each before attesting</legend>
      <p style={{ fontSize: 12, margin: "2px 0 6px" }}>The console&rsquo;s figure differs from v7&rsquo;s reported one by more than 5%. A mis-mapped factor shows here, as does v7&rsquo;s own arithmetic; the console&rsquo;s figure stands once you have confirmed which.</p>
      {flagged.map((key) => {
        const delta = deltaOf(key);
        return <label key={key} style={{ display: "flex", gap: 8, alignItems: "baseline", fontSize: 12 }}>
          <input type="checkbox" checked={acknowledged.includes(key)}
            onChange={(event) => setAcknowledged((current) => event.target.checked ? [...current, key] : current.filter((item) => item !== key))} />
          <span><b>{key === "job" ? "The job's total" : plan.deltaLabels[key] ?? key}</b> · console {formatTonnes(delta.calcTco2e)} t · v7 {formatTonnes(delta.v7Tco2e)} t · {percent(delta.relative)}</span>
        </label>;
      })}
    </fieldset> : null}
    <ul className="muted" style={{ fontSize: 12, margin: "0 0 8px", paddingLeft: 18 }}>
      <li><b>{plan.attest.length}</b> pending row{plan.attest.length === 1 ? "" : "s"} approved{plan.skippedApproved ? <> · {plan.skippedApproved} already approved, left as they are</> : null}</li>
      <li><b>{plan.gaps.length}</b> record-of-account gap{plan.gaps.length === 1 ? "" : "s"} resolved{plan.gaps.length ? <> ({zeros ? `${zeros} where v7 recorded zero` : ""}{zeros && totals ? ", " : ""}{totals ? `${totals} v7 reported total` : ""})</> : null}{plan.skippedResolvedGaps ? <> · {plan.skippedResolvedGaps} already resolved, kept</> : null}</li>
      {plan.excludedRejected.length ? <li>{plan.excludedRejected.length} rejected row{plan.excludedRejected.length === 1 ? "" : "s"} excluded — review {plan.excludedRejected.length === 1 ? "it" : "them"} individually: {plan.excludedRejected.map((row) => row.label).join(", ")}</li> : null}
      {plan.otherOpenGaps.length ? <li>{plan.otherOpenGaps.length} other open gap{plan.otherOpenGaps.length === 1 ? "" : "s"} not touched — each needs its own Resolve</li> : null}
    </ul>
    {plan.blocked.length ? <div className="nz-banner warn" role="alert"><div><b>Cannot attest while these rows fail a check:</b>
      <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>{plan.blocked.map((row) => <li key={row.rowId}>{row.label} — {row.reasons.join("; ")}</li>)}</ul></div></div> : null}
    <textarea className="nz-notes" style={{ width: "100%" }} value={reason} onChange={(event) => setReason(event.target.value)} rows={2}
      aria-label="Attestation reason" placeholder="Reason (required) — e.g. v7's inputs carried; flagged deltas investigated" />
    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginTop: 6 }}>
      <GatedButton className="nz-btn pri" blocked={busy || !!blockedReason} blockedReason={!busy ? blockedReason : undefined} reasonClassName="muted nz-gated-reason"
        aria-busy={busy || undefined} onClick={() => void attest()}>{busy ? "Attesting…" : `Attest ${plan.attest.length} row${plan.attest.length === 1 ? "" : "s"}`}</GatedButton>
    </div>
    {error ? <div className="nz-banner warn" role="alert" style={{ marginTop: 8 }}>{error}</div> : null}
    {done ? <div className="nz-banner ok" role="status" style={{ marginTop: 8 }}>{done}</div> : null}
  </div>;
}

function SignOffPanel({ jobId, canSignOff, openGaps, pendingReview, onSignedOff }: { jobId: string; canSignOff: boolean; openGaps: number; pendingReview: number; onSignedOff: () => void }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ kind: "ok" | "warn"; text: string } | null>(null);

  async function signOff() {
    if (busy || !canSignOff) return;
    setBusy(true); setResult(null);
    const outcome = await postBrowserCommand<{ snapshotId: string; version: number; reused: boolean }>(
      `/api/isolated/jobs/${jobId}/reviewed-snapshots`,
      {},
      crypto.randomUUID(),
    );
    setBusy(false);
    if (outcome.state === "success") {
      setResult({ kind: "ok", text: outcome.data.reused ? `Reviewed snapshot v${outcome.data.version} is already current.` : `Signed off — immutable reviewed snapshot v${outcome.data.version} created.` });
      onSignedOff();
    } else {
      setResult({ kind: "warn", text: outcome.state === "validation_failed" ? outcome.issues[0]?.message ?? "Sign-off is blocked." : outcome.message });
    }
  }

  const blockers: string[] = [];
  if (openGaps > 0) blockers.push(`${openGaps} gap${openGaps === 1 ? "" : "s"} open`);
  if (pendingReview > 0) blockers.push(`${pendingReview} row${pendingReview === 1 ? "" : "s"} awaiting review`);

  return <div className="nz-assurance-signoff">
    <div className="nz-sect">Governed sign-off</div>
    <p className="muted" style={{ fontSize: 12 }}>
      Freezes an immutable, content-addressed snapshot for reporting — only once every integrity gap is resolved and every enabled row is independently approved.
    </p>
    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
      <GatedButton
        className="nz-btn pri"
        blocked={!canSignOff || busy}
        blockedReason={!busy && !canSignOff && blockers.length > 0 ? `Blocked: ${blockers.join(" · ")}` : undefined}
        reasonClassName="muted nz-gated-reason"
        aria-busy={busy || undefined}
        onClick={() => void signOff()}
      >{busy ? "Signing off…" : "Sign off & freeze snapshot"}</GatedButton>
    </div>
    {result && <div className={`nz-banner ${result.kind}`} role={result.kind === "warn" ? "alert" : "status"} style={{ marginTop: 8 }}>{result.text}</div>}
  </div>;
}

/**
 * RULING-NZC022-relax-self-approval §5: the latest reviewed snapshot's approval, next to the sign-off that froze it — the
 * same report.snapshot.approve command the release control calls. The button is offered only to someone the command will
 * accept: anyone but the preparer, and the preparer too while independent approval is relaxed and they may release
 * reports. Anyone else sees that it awaits approval, and why. Re-read whenever the surface re-reads, so a fresh sign-off
 * shows here at once.
 */
function SnapshotApprovalPanel({ jobId, readKey, onApproved }: { jobId: string; readKey: unknown; onApproved: () => void }) {
  const me = useStaffMe();
  const [snapshot, setSnapshot] = useState<ReviewedCrpSnapshotReadModel | null | undefined>(undefined);
  const [independentRequired, setIndependentRequired] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [reads, setReads] = useState(0);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const response = await fetch(`/api/isolated/jobs/${jobId}/reviewed-snapshots`, { cache: "no-store" });
        const body = await response.json();
        if (!live) return;
        if (!response.ok) { setError(body?.message ?? "The reviewed snapshot could not be read."); return; }
        setSnapshot(Array.isArray(body.snapshots) ? body.snapshots[0] ?? null : null);
        setIndependentRequired(readIndependentApprovalRequired(body));
        setError(null);
      } catch { if (live) setError("The reviewed snapshot could not be read."); }
    })();
    return () => { live = false; };
  }, [jobId, readKey, reads]);

  async function approve() {
    if (!snapshot || busy) return;
    setBusy(true); setError(null);
    const result = await postBrowserCommand<{ approvedAt: string; selfApproved?: true }>(
      `/api/isolated/reviewed-snapshots/${encodeURIComponent(snapshot.id)}/approve`, {}, crypto.randomUUID());
    setBusy(false);
    if (result.state !== "success") { setError(result.state === "validation_failed" ? result.issues[0]?.message ?? "The snapshot could not be approved." : result.message); return; }
    setDone(`Reviewed snapshot v${snapshot.version} approved${result.data.selfApproved ? " — recorded as your self-approval" : ""}. It can now be validated and published.`);
    setReads((n) => n + 1);
    onApproved();
  }

  // Not read yet, or nothing frozen: the sign-off above is the step before this one.
  if (snapshot === undefined) return error ? <div className="nz-assurance-signoff"><div className="nz-banner warn" role="alert">{error}</div></div> : null;
  if (snapshot === null) return null;
  if (snapshot.approvedBy) {
    const on = snapshot.approvedAt ? ` · ${snapshot.approvedAt.slice(0, 10).split("-").reverse().join("/")}` : "";
    return <div className="nz-assurance-signoff">
      <div className="nz-sect">Snapshot approval</div>
      <div className="nz-banner ok" role="status">{done ?? `Reviewed snapshot v${snapshot.version} approved${on}${isSelfApproved(snapshot) ? " · self-approved" : ""}.`}</div>
    </div>;
  }
  const access = snapshotActAccess(me, snapshot, "snapshot.review", independentRequired);
  return <div className="nz-assurance-signoff" aria-label="Approve reviewed snapshot">
    <div className="nz-sect">Snapshot approval</div>
    <p className="muted" style={{ fontSize: 12 }}>
      Reviewed snapshot v{snapshot.version} is frozen and awaiting approval. A report is validated and published only from an approved snapshot.
      {independentRequired ? " Its preparer cannot approve it." : " Independent approval is relaxed: a preparer who may release reports can approve their own snapshot, and it is recorded as a self-approval."}
    </p>
    {access.state === "allowed"
      ? <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <button type="button" className="nz-btn pri" disabled={busy} aria-busy={busy || undefined} onClick={() => void approve()}>{busy ? "Approving…" : "Approve reviewed snapshot"}</button>
        </div>
      : <div className="muted nz-gated-reason" role="note">{access.reason}</div>}
    {error ? <div className="nz-banner warn" role="alert" style={{ marginTop: 8 }}>{error}</div> : null}
  </div>;
}

function GapCard({ jobId, gap, onSelectRow, onResolved }: { jobId: string; gap: AssuranceGap; onSelectRow: (rowId: string | null) => void; onResolved: () => void }) {
  const [resolving, setResolving] = useState(false);
  const [reason, setReason] = useState(gap.resolution?.reason ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (busy || !reason.trim()) return;
    setBusy(true); setError(null);
    const result = await postBrowserCommand<{ version: number }>(
      "/api/isolated/assurance/gaps/resolve",
      { jobId, gapKey: gap.key, flagType: gap.flag, scopeRowId: gap.scopeRowId, reason: reason.trim(), expectedVersion: gap.resolution?.version ?? 0 },
      crypto.randomUUID(),
    );
    setBusy(false);
    if (result.state !== "success") { setError(result.state === "validation_failed" ? result.issues[0]?.message ?? "Could not resolve." : result.message); return; }
    setResolving(false);
    onResolved();
  }

  return <li className={`nz-assurance-gap ${gap.flag}`}>
    <div className="top"><span className="where">{gap.label}</span><span className={`nz-gap-chip ${gap.flag}`}>{gap.flag.replaceAll("_", " ")}</span></div>
    <div className="why">{gap.detail}</div>
    <div className="acts">
      {gap.scopeRowId && <button className="lnk pri" onClick={() => onSelectRow(gap.scopeRowId)}>Go to row</button>}
      <button className="lnk" onClick={() => setResolving((current) => !current)}>{gap.resolved ? "Edit resolution…" : "Resolve…"}</button>
    </div>
    {resolving && <div className="reason">
      <textarea value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Reason (e.g. moved to on-site renewable — genuinely zero)" rows={2} />
      <div className="reason-acts"><button className="nz-btn pri" disabled={busy || !reason.trim()} onClick={() => void submit()}>{busy ? "Saving…" : "Save"}</button><button className="nz-btn" onClick={() => setResolving(false)}>Cancel</button></div>
      {error && <div className="nz-banner warn" role="alert">{error}</div>}
    </div>}
    {gap.resolved && !resolving && <div className="rtag">✓ Resolved — {gap.resolution!.reason}</div>}
  </li>;
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
