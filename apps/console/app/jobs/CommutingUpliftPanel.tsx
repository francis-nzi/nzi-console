"use client";
// Employee commuting (3.7) uplift (BRIEF-commuting-uplift-lean). Commuting is a sample - one row per respondent - so a site's figure under-
// states it unless nearly everyone answered. Per site the client enters the employees (E) and the staff who commute wholly by company car
// (C, already Scope 1/2), and may switch uplift on; the not-surveyed eligible staff (E - C - respondents) is the default uplift headcount,
// which the client agrees or adjusts. The scale is (R + U) / R, applied to the site's commuting figure where it locks - the rows keep their
// own. The CRM sees the response rate and the resulting figure beside it, so the extrapolation is approved knowingly.
import { useCallback, useEffect, useRef, useState } from "react";
import { putBrowserCommand } from "@nzi/api-client";
import { upliftFlagText, type SiteUpliftFlag } from "@nzi/contracts";

type Site = {
  siteId: string; name: string; version: number | null; employees: number | null; companyCarUsers: number; respondents: number; eligible: number | null;
  responseRate: number | null; defaultHeadcount: number | null; headcount: number | null; agreedHeadcount: number | null; enabled: boolean; available: boolean;
  unavailableReason: "no-respondents" | "no-employees" | null; applied: boolean; factor: number; flags: SiteUpliftFlag[];
  sampledTco2e?: number; upliftedTco2e?: number;
};
type View = { jobId: string; sites: Site[]; unassignedRows: number };
type Draft = { employees: string; companyCarUsers: string; enabled: boolean; agreed: string };

const percent = (rate: number | null) => (rate === null ? "—" : `${Math.round(rate * 100)}%`);
const tonnes = (value: number) => value.toLocaleString("en-GB", { maximumFractionDigits: 2 });
const whole = (text: string): number | null => (/^\s*\d+\s*$/.test(text) ? Number(text) : null);
const startDraft = (site: Site): Draft => ({ employees: site.employees === null ? "" : String(site.employees), companyCarUsers: String(site.companyCarUsers), enabled: site.enabled, agreed: site.agreedHeadcount === null ? "" : String(site.agreedHeadcount) });

export function CommutingUpliftPanel({ jobId, audience, notice, writeEnabled = true }: {
  jobId: string; audience: "staff" | "portal"; notice: (n: { kind: "ok" | "warn"; text: string }) => void; writeEnabled?: boolean;
}) {
  const url = audience === "portal" ? `/api/portal/jobs/${jobId}/commuting-uplift` : `/api/isolated/jobs/${jobId}/commuting-uplift`;
  const [state, setState] = useState<{ kind: "loading" } | { kind: "failed" } | { kind: "ready"; data: View }>({ kind: "loading" });
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const keys = useRef<Record<string, string>>({});
  const load = useCallback(async () => {
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) throw new Error();
      const data = await response.json() as View;
      setState({ kind: "ready", data });
      setDrafts(Object.fromEntries(data.sites.map((site) => [site.siteId, startDraft(site)])));
    } catch { setState({ kind: "failed" }); }
  }, [url]);
  useEffect(() => { void load(); }, [load]);

  if (state.kind === "loading") return <section className="nz-panel nz-config-panel" data-commuting-uplift><span className="muted">Reading the commuting headcount…</span></section>;
  if (state.kind === "failed") return <section className="nz-panel nz-config-panel" data-commuting-uplift role="alert">The commuting headcount could not be read. No uplift is shown rather than one that might be wrong.</section>;
  const { sites, unassignedRows } = state.data;
  // Nothing to say until the job has commuting rows (or a headcount already held): no panel on a job without commuting.
  if (sites.length === 0 || (audience === "staff" && unassignedRows === 0 && !sites.some((site) => site.respondents > 0 || site.version !== null))) return null;

  async function save(site: Site) {
    const draft = drafts[site.siteId] ?? startDraft(site);
    const employees = whole(draft.employees), companyCarUsers = whole(draft.companyCarUsers || "0");
    const agreedHeadcount = draft.agreed.trim() === "" ? null : whole(draft.agreed);
    if (employees === null || companyCarUsers === null || (draft.agreed.trim() !== "" && agreedHeadcount === null)) { notice({ kind: "warn", text: "Employees, company-car users and the uplift headcount are whole numbers." }); return; }
    setBusy(site.siteId);
    const result = await putBrowserCommand(url, { siteId: site.siteId, employees, companyCarUsers, upliftEnabled: draft.enabled, agreedHeadcount, expectedVersion: site.version }, keys.current[site.siteId] ??= crypto.randomUUID());
    setBusy(null);
    if (result.state === "success") { delete keys.current[site.siteId]; notice({ kind: "ok", text: `${site.name}: headcount saved.` }); await load(); }
    else notice({ kind: "warn", text: result.state === "validation_failed" ? result.issues.map((issue) => issue.message).join(" ") : result.state === "conflict" ? "That site's headcount changed since this was opened. It has been reloaded." : result.message });
    if (result.state === "conflict") await load();
  }

  return <section className="nz-panel nz-config-panel" data-commuting-uplift aria-labelledby={`cu-${jobId}`}>
    <div className="nz-config-head">
      <div><span className="nz-eyebrow">Employee commuting · 3.7</span><b id={`cu-${jobId}`}>Headcount and sample uplift</b>
        <div className="sub">Commuting is a sample of the people who answered. Enter each site&rsquo;s employees and how many commute wholly by company car (already in Scope 1/2). With uplift on, the sample is scaled up to the site&rsquo;s eligible staff — in proportion, and only where it locks. Off by default.</div></div>
    </div>
    {unassignedRows > 0 ? <p className="nz-hint" role="status" data-commuting-unassigned>{unassignedRows} commuting {unassignedRows === 1 ? "row has" : "rows have"} no site, so {unassignedRows === 1 ? "it is" : "they are"} left out of every site&rsquo;s count and never scaled.{audience === "staff" ? " Assign a site to each on its row." : " Your adviser will assign them."}</p> : null}
    <div className="nz-fx-rows">
      {sites.map((site) => {
        const draft = drafts[site.siteId] ?? startDraft(site);
        const set = (patch: Partial<Draft>) => setDrafts({ ...drafts, [site.siteId]: { ...draft, ...patch } });
        const locked = !writeEnabled || busy !== null;
        return <div key={site.siteId} className="nz-fx-row" data-site={site.siteId} data-uplift-applied={site.applied}>
          <div><b>{site.name}</b>
            <div className="nz-hint">{site.respondents} responding · response rate {percent(site.responseRate)}{site.eligible !== null ? ` of ${site.eligible} eligible` : ""}</div></div>
          <label className="nz-fl">Employees
            <input className="nz-inp" inputMode="numeric" disabled={locked} value={draft.employees} onChange={(event) => set({ employees: event.target.value })} /></label>
          <label className="nz-fl">Company-car only
            <input className="nz-inp" inputMode="numeric" disabled={locked} value={draft.companyCarUsers} onChange={(event) => set({ companyCarUsers: event.target.value })} /></label>
          <label className="nz-fl nz-check"><input type="checkbox" checked={draft.enabled} disabled={locked || !site.available} onChange={(event) => set({ enabled: event.target.checked })} /> Scale up this site</label>
          {site.unavailableReason ? <div className="nz-hint" data-uplift-unavailable>{site.unavailableReason === "no-respondents" ? "No commuting rows at this site yet, so there is nothing to scale." : "Enter the site's employees first."}</div> : null}
          {site.available && draft.enabled ? <label className="nz-fl">Staff to add (default {site.defaultHeadcount})
            <input className="nz-inp" inputMode="numeric" disabled={locked} placeholder={String(site.defaultHeadcount ?? 0)} value={draft.agreed} onChange={(event) => set({ agreed: event.target.value })} /></label> : null}
          {site.applied ? <div className="nz-hint" data-uplift-factor>
            Scale ×{site.factor.toFixed(3)} = ({site.respondents} + {site.headcount}) ÷ {site.respondents}
            {audience === "staff" && site.sampledTco2e !== undefined && site.upliftedTco2e !== undefined ? ` · ${tonnes(site.sampledTco2e)} → ${tonnes(site.upliftedTco2e)} tCO₂e` : ""}</div> : null}
          {site.flags.map((flag) => <div key={flag} className="nz-hint nz-fx-missing" role="status" data-uplift-flag={flag}>{upliftFlagText(flag)}</div>)}
          {writeEnabled ? <button type="button" className="nz-btn" disabled={busy !== null || draft.employees.trim() === ""} onClick={() => void save(site)}>{busy === site.siteId ? "Saving…" : "Save"}</button> : null}
        </div>;
      })}
    </div>
  </section>;
}
