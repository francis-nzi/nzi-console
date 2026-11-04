"use client";
import { useEffect, useState } from "react";
import { emissionCategoryTaxonomy } from "@nzi/contracts";
import type { MembershipReport } from "@nzi/isolated-backend";

/**
 * Category membership (NZC-171): which DESNZ families each data-entry category offers, and what the map leaves out. The "Unfiled" group is
 * the factors no rule claims - offered in no list until their family is filed - and is expected to be empty. Distinct states: a read that
 * fails is said to have failed, never shown as an empty map.
 */
type Load = { state: "loading" } | { state: "failed" } | { state: "ready"; report: MembershipReport };
const nameOf = (code: string) => emissionCategoryTaxonomy.find((category) => category.code === code)?.name ?? code;
const path = (levels: readonly (string | null)[]) => levels.filter(Boolean).join(" / ");

export function MembershipPanel() {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  useEffect(() => {
    let live = true;
    fetch("/api/isolated/factor-membership", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
      .then((report: MembershipReport) => { if (live) setLoad({ state: "ready", report }); })
      .catch(() => { if (live) setLoad({ state: "failed" }); });
    return () => { live = false; };
  }, []);

  if (load.state === "loading") return <section className="nz-audit-section" aria-busy="true"><span className="nz-eyebrow">Category membership</span><p className="nz-hint">Loading the membership map.</p></section>;
  if (load.state === "failed") return <section className="nz-audit-section"><span className="nz-eyebrow">Category membership</span><p className="nz-hint" role="alert">The membership map could not be read. Nothing is assumed about it.</p></section>;
  const { report } = load;
  const active = report.rules.filter((rule) => rule.status === "active" && rule.categoryCode !== null);
  const byCategory = emissionCategoryTaxonomy.map((category) => ({ category, rules: active.filter((rule) => rule.categoryCode === category.code) }));
  return <section className="nz-audit-section" data-testid="membership-panel">
    <div className="nz-audit-heading"><div><span className="nz-eyebrow">Category membership</span><h2>Which factors each category offers</h2></div></div>
    <div className={`nz-banner ${report.unfiled.length === 0 ? "ok" : "warn"}`} data-testid="unfiled-group"><div>
      <b>{report.unfiled.length === 0 ? "Unfiled: none." : `Unfiled: ${report.unfiled.length} factor${report.unfiled.length === 1 ? "" : "s"} no rule claims.`}</b>
      <span> {report.unfiled.length === 0 ? "Every physical factor belongs to a family the map files." : "They are offered in no category until their family is filed."}</span></div></div>
    {report.unfiled.length > 0 ? <ul className="nz-hint" data-testid="unfiled-list">{report.unfiled.slice(0, 50).map((factor) => <li key={factor.factorId}>{factor.label} <small>({path(factor.sourceLevels) || "no source levels"} · {factor.factorId})</small></li>)}</ul> : null}
    {report.heldBack.length > 0 ? <p className="nz-hint" data-testid="held-back">Held back until their category exists: {report.heldBack.length} factor{report.heldBack.length === 1 ? "" : "s"} ({[...new Set(report.heldBack.map((factor) => factor.sourceLevels[0]))].join(", ")}).</p> : null}
    <table className="nz-tbl"><thead><tr><th>Category</th><th>DESNZ families it offers</th></tr></thead><tbody>
      {byCategory.map(({ category, rules }) => <tr key={category.code}><td>{category.code} · {nameOf(category.code)}</td>
        <td>{rules.length === 0 ? <span className="nz-hint">No family of its own - offers the whole scope, with a notice.</span> : rules.map((rule) => path([rule.sourceL1, rule.sourceL2, rule.sourceL3])).join("; ")}</td></tr>)}
    </tbody></table>
  </section>;
}
