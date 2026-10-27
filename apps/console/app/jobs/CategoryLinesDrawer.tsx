"use client";
// Data entry D3 (R5): a category's lines across the reporting grain — baseline + current + up to four prior years — in a drawer from
// the Review & QA trend. Each line is matched across the years by its GL code (else its description), the identity a carried-forward
// line keeps; PG&S is the case it was built for, and every category reads the same way. A year with nothing behind it is "—",
// never zero.
import { useEffect, useState } from "react";
import { Drawer } from "@nzi/ui";
import type { CategoryLineYears, CategoryLineYearValue } from "@nzi/isolated-backend";
import { formatQuantity } from "../lib/formatNumber";

const tonnes = (value: number | null) => value === null ? "—" : value.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function CategoryLinesDrawer({ jobId, category, onClose }: { jobId: string; category: { scopeCode: string; label: string } | null; onClose: () => void }) {
  const [state, setState] = useState<{ kind: "loading" } | { kind: "failed"; message: string } | { kind: "ready"; data: CategoryLineYears }>({ kind: "loading" });
  useEffect(() => {
    if (!category) return;
    let live = true;
    setState({ kind: "loading" });
    void fetch(`/api/isolated/jobs/${jobId}/line-years?category=${encodeURIComponent(category.scopeCode)}`, { cache: "no-store" })
      .then(async (response) => { const body = await response.json(); if (!response.ok) throw new Error(body?.message ?? "The lines could not be read."); return body as CategoryLineYears; })
      .then((data) => { if (live) setState({ kind: "ready", data }); })
      .catch((error: unknown) => { if (live) setState({ kind: "failed", message: error instanceof Error ? error.message : "The lines could not be read." }); });
    return () => { live = false; };
  }, [jobId, category]);

  const cell = (value: CategoryLineYearValue | null) => value === null ? <span className="muted">—</span>
    : <><b>{tonnes(value.tco2e)}</b>{value.quantity !== null ? <div className="nz-hint">{formatQuantity(value.quantity)} {value.unit ?? ""}</div> : value.unit === null ? <div className="nz-hint">mixed units</div> : null}</>;

  return <Drawer open={category !== null} onClose={onClose} ariaLabel={category ? `${category.label} — lines across the years` : "Lines across the years"} className="nz-assurance-drawer nz-lines-drawer">
    <div className="nz-assurance-drawer-h">
      <div className="top"><span className="ctx">Review &amp; QA · line by line</span><button type="button" className="close" onClick={onClose} aria-label="Close lines across the years">✕</button></div>
      <div className="ttl"><h3>{category?.label ?? "Lines"}</h3></div>
    </div>
    <p className="nz-assurance-drawer-note">Each line beside its earlier years, matched by GL code — or by description where it has none. Baseline, current and up to four prior years. tCO₂e, with the line&rsquo;s own figure beneath. A prior year is that year&rsquo;s job as it stands; the trend&rsquo;s totals are its reviewed snapshot.</p>
    {state.kind === "loading" ? <div className="nz-register-loading" role="status"><i /><span><b>Reading the lines</b><small>Each year&rsquo;s job…</small></span></div>
      : state.kind === "failed" ? <div className="nz-banner warn" role="alert">{state.message}</div>
      : state.data.lines.length === 0 ? <p className="nz-table-empty">No lines in this category in any of these years.</p>
      : <div className="nz-lines-scroll"><table className="nz-tbl nz-lines-tbl">
          <thead><tr><th>Line</th>{state.data.years.map((year) => <th key={year.year} className={`num${year.kind === "baseline" ? " bl" : year.kind === "current" ? " cur" : ""}`}>
            {year.year}{year.kind === "baseline" ? <span className="nz-bl-pill">BL</span> : null}{year.kind === "current" ? <span className="nz-cur-pill">current</span> : null}
            {year.jobNumber ? <div className="nz-hint">{year.jobNumber}</div> : <div className="nz-hint">no job</div>}
          </th>)}</tr></thead>
          <tbody>{state.data.lines.map((line) => <tr key={line.key}>
            <td>{line.label}{line.glCode ? <div className="nz-hint">GL {line.glCode}</div> : null}</td>
            {line.values.map((value, index) => <td key={state.data.years[index]!.year} className={`num${state.data.years[index]!.kind === "current" ? " cur" : ""}`}>{cell(value)}</td>)}
          </tr>)}</tbody>
        </table></div>}
  </Drawer>;
}
