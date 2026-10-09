"use client";

import { reportScopeSummary, type reportScopeChoices, type ReportScope } from "@nzi/contracts";

type Choices = ReturnType<typeof reportScopeChoices>;

/**
 * S-2, to the Report Studio mockup's toolbar: the view a validated version will issue — "Whole client", or "By site" with the
 * snapshot's own sites as chips. The summary says what the choice covers and what it leaves out; "every site" stays a site
 * view (it excludes organisation-level emissions), distinct from the whole client (ruled).
 */
export function ReportScopeSelector({ choices, scope, onChange, disabled }: { choices: Choices; scope: ReportScope; onChange: (scope: ReportScope) => void; disabled?: boolean }) {
  const chosen = scope.kind === "sites" ? new Set(scope.siteIds) : new Set<string>();
  const toggle = (siteId: string) => {
    const next = new Set(chosen);
    if (next.has(siteId)) next.delete(siteId); else next.add(siteId);
    onChange({ kind: "sites", siteIds: [...next].sort() });
  };
  return <div className="nz-scope-select">
    <span className="nz-eyebrow">Scope</span>
    <div className="nz-filters" role="group" aria-label="Report scope">
      <button type="button" aria-pressed={scope.kind === "whole"} className={scope.kind === "whole" ? "on" : undefined} disabled={disabled} onClick={() => onChange({ kind: "whole" })}>Whole client</button>
      <button type="button" aria-pressed={scope.kind === "sites"} className={scope.kind === "sites" ? "on" : undefined} disabled={disabled || choices.sites.length === 0}
        onClick={() => onChange({ kind: "sites", siteIds: choices.sites.map((site) => site.siteId) })}>By site</button>
    </div>
    {scope.kind === "sites" ? <div className="nz-scope-sites" role="group" aria-label="Sites in this report">
      {choices.sites.map((site) => <button type="button" key={site.siteId} className="nz-scope-chip" aria-pressed={chosen.has(site.siteId)} disabled={disabled} onClick={() => toggle(site.siteId)}>
        <i aria-hidden="true" />{site.label} <small className="num">{site.tco2e.toLocaleString("en-GB", { maximumFractionDigits: 1 })} t</small>
      </button>)}
    </div> : null}
    <p className="nz-scope-summary" role="status">{scope.kind === "sites" && chosen.size === 0 ? "Choose at least one site." : reportScopeSummary(choices, scope)}</p>
    {choices.sites.length === 0 ? <p className="sub">This snapshot's rows carry no site, so it can only be issued for the whole client.</p> : null}
  </div>;
}
