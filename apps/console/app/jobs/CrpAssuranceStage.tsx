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

import { useCallback, useEffect, useMemo, useState } from "react";
import { postBrowserCommand } from "@nzi/api-client";
import {
  percentVsBaseline,
  percentVsBaselineTone,
  type AssuranceAuditRow,
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

  if (state === "loading") {
    return <section className="nz-panel nz-config-panel" aria-busy><div className="nz-register-loading" role="status"><i /><span><b>Loading data assurance</b><small>Five-year trend and the integrity gap engine…</small></span></div></section>;
  }
  // Failed read is never painted as a zeroed report (five explicit states).
  if (state === "failed" || !data) {
    return <section className="nz-panel nz-config-panel"><div className="nz-banner warn" role="alert"><div><b>Data assurance is unavailable</b><div>{degraded}</div></div></div><button className="nz-btn" onClick={() => void load()}>Retry</button></section>;
  }

  return <AssuranceSurface jobId={jobId} data={data} tab={tab} onTab={setTab} onReload={load} onGoToRow={onGoToRow} />;
}

function AssuranceSurface({ jobId, data, tab, onTab, onReload, onGoToRow }: { jobId: string; data: AssuranceScreen; tab: Tab; onTab: (t: Tab) => void; onReload: () => void; onGoToRow?: (rowId: string) => void }) {
  const { trend, gaps, auditRows } = data;
  const [drawerOpen, setDrawerOpen] = useState(true);
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);
  const openRowDetail = (rowId: string) => { setSelectedRowId(rowId); setDrawerOpen(true); };
  const current = trend.years.find((year) => year.kind === "current");
  const baseline = trend.years.find((year) => year.kind === "baseline");
  const openGaps = gaps.openCount;
  const pendingReview = auditRows.filter((row) => row.reviewStatus !== "approved").length;
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
            <tr key={row.rowId} className={`nz-audit-row${row.factorLabel ? "" : " nz-flagged"}`} tabIndex={0} onClick={() => openRowDetail(row.rowId)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openRowDetail(row.rowId); } }}>
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
      {!drawerOpen && <button className="nz-assurance-reopen" onClick={() => setDrawerOpen(true)}>🛡 Data assurance {gaps.openCount > 0 && <span className="n">{gaps.openCount}</span>}</button>}
    </div>

    <SignOffPanel jobId={jobId} canSignOff={canSignOff} openGaps={openGaps} pendingReview={pendingReview} onSignedOff={onReload} />

    {drawerOpen && <AssuranceDrawer
      jobId={jobId}
      gaps={gaps.gaps}
      auditRows={auditRows}
      selectedRowId={selectedRowId}
      onSelectRow={setSelectedRowId}
      onClose={() => { setDrawerOpen(false); setSelectedRowId(null); }}
      onResolved={onReload}
      onEditRow={onGoToRow}
    />}
  </section>;
}

type DrawerSegment = "gaps" | "row";

function AssuranceDrawer({ jobId, gaps, auditRows, selectedRowId, onSelectRow, onClose, onResolved, onEditRow }: {
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

  return <aside className="nz-assurance-drawer" role="complementary" aria-label="Data assurance">
    <div className="nz-assurance-drawer-h">
      <div className="top"><span className="ctx">Detail · this stage</span><button className="close" onClick={onClose} aria-label="Close">✕</button></div>
      <div className="ttl"><h3>{segment === "row" ? "Row detail" : "Data assurance"}</h3>{segment === "gaps" && <span className="count">{openCount} open</span>}</div>
    </div>
    <div className="nz-assurance-drawer-seg">
      <button className={segment === "gaps" ? "on" : ""} onClick={() => { setSegment("gaps"); onSelectRow(null); }}>Gaps ({gaps.length})</button>
      <button className={segment === "row" ? "on" : ""} disabled={!selectedRow} onClick={() => setSegment("row")}>Row detail</button>
    </div>

    {segment === "row" && selectedRow && <RowDetail jobId={jobId} row={selectedRow} onEditRow={onEditRow} onReviewed={onResolved} />}

    {segment === "gaps" && <>
      <ol className="nz-assurance-gaps">
        {gaps.map((gap) => <GapCard key={gap.key} jobId={jobId} gap={gap} onSelectRow={onSelectRow} onResolved={onResolved} />)}
        {gaps.length === 0 && <li className="nz-assurance-gap-empty">No integrity gaps — the dataset is complete, consistent and fully costed.</li>}
      </ol>
      <p className="nz-assurance-drawer-note">This is the workspace&rsquo;s shared detail drawer — selecting any row shows its evidence here. By default it lists the assurance gaps. Each is <b>fixed</b> (edit the row) or <b>resolved with a reason</b>, recorded on the row&rsquo;s provenance so sign-off is defensible.</p>
    </>}
  </aside>;
}

function RowDetail({ jobId, row, onEditRow, onReviewed }: { jobId: string; row: AssuranceAuditRow; onEditRow?: (rowId: string) => void; onReviewed: () => void }) {
  return <div className="nz-assurance-row-detail">
    <div className="nz-kv"><span className="k">Category</span><span className="v">{row.category}</span></div>
    <div className="nz-kv"><span className="k">Activity</span><span className="v">{row.sourceLabel}</span></div>
    <div className="nz-kv"><span className="k">Factor</span><span className="v">{row.factorLabel ?? "No factor selected"}</span></div>
    <div className="nz-kv"><span className="k">Quantity</span><span className="v">{row.quantity == null ? "—" : `${row.quantity.toLocaleString("en-GB")}${row.unit ? ` ${row.unit}` : ""}`}</span></div>
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
    <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 6 }}>
      <button className="nz-btn" disabled={busy || !note.trim()} onClick={() => void decide("rejected")}>Reject</button>
      <button className="nz-btn pri" disabled={busy || !row.qualityTier} onClick={() => void decide("approved")}>Approve row</button>
    </div>
    {error && <div className="nz-banner warn" role="alert">{error}</div>}
  </div>;
}

/** DA3c — the governed sign-off gate: composes "all gaps resolved" (openGaps)
 *  and "all enabled rows approved" (pendingReview), both already read by this
 *  surface. The freeze is the existing report.snapshot.create/reviewed-snapshots
 *  endpoint, unforked — it now also enforces the gap half of this gate itself. */
function SignOffPanel({ jobId, canSignOff, openGaps, pendingReview, onSignedOff }: { jobId: string; canSignOff: boolean; openGaps: number; pendingReview: number; onSignedOff: () => void }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ kind: "ok" | "warn"; text: string } | null>(null);

  async function signOff() {
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
      <button className="nz-btn pri" disabled={busy || !canSignOff} onClick={() => void signOff()}>{busy ? "Signing off…" : "Sign off & freeze snapshot"}</button>
      {!canSignOff && blockers.length > 0 && <span className="muted" style={{ fontSize: 12 }}>Blocked: {blockers.join(" · ")}</span>}
    </div>
    {result && <div className={`nz-banner ${result.kind}`} role={result.kind === "warn" ? "alert" : "status"} style={{ marginTop: 8 }}>{result.text}</div>}
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
    <div className="top"><span className="where">{gap.label}</span><span className={`nz-gap-chip ${gap.flag}`}>{gap.flag.replace("_", " ")}</span></div>
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
