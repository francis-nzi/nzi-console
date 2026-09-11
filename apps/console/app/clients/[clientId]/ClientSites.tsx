"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Drawer, GatedButton } from "@nzi/ui";
import { postBrowserCommand, type BrowserCommandResult } from "@nzi/api-client";
import { siteFloorAreaForPeriod, siteIsInReportingBoundary, siteLifecycleStatus, type ClientSiteReadModel, type SiteLifecycleStatus } from "@nzi/contracts";
import type { ClientReportingPeriod } from "@nzi/isolated-backend";
import { formatDate } from "../../lib/formatDate";
import type { EditAccess } from "../../lib/useEditAccess";

/**
 * NZC-070 / NZC-071 — the client's operational sites, backend-fed. Status is derived
 * from today against the dates; the boundary column is computed per row from the
 * resolver; every change goes through the site commands and persists.
 */

type Notice = { kind: "ok" | "warn"; text: string } | null;

export function statusText(status: SiteLifecycleStatus): string {
  if (status.kind === "planned") return `Planned · starts ${formatDate(status.startsOn)}`;
  if (status.kind === "vacated") return `Vacated ${formatDate(status.vacatedOn)}`;
  return status.vacatesOn ? `In service (vacates ${formatDate(status.vacatesOn)})` : "In service";
}

const serviceRange = (site: Pick<ClientSiteReadModel, "inServiceFrom" | "vacatedEffective">) =>
  `${site.inServiceFrom ? formatDate(site.inServiceFrom) : "Before records"} → ${site.vacatedEffective ? formatDate(site.vacatedEffective) : "present"}`;

const areaToday = (site: ClientSiteReadModel, today: string) => siteFloorAreaForPeriod(site, { from: today, to: today });

export function ClientSites({ clientId, sites, reportingPeriods, today, access }: { clientId: string; sites: ClientSiteReadModel[]; reportingPeriods: ClientReportingPeriod[]; today: string; access: EditAccess }) {
  const router = useRouter();
  const [editing, setEditing] = useState<{ site: ClientSiteReadModel | null } | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const periods = [...reportingPeriods].reverse();
  const blocked = access.state !== "allowed";

  return <section className="nz-panel">
    <div className="nz-panel-head">
      <div><div className="eyebrow">Client boundary</div><h2>Operational sites</h2></div>
      <GatedButton className="nz-btn pri" blocked={blocked} blockedReason={access.state === "allowed" ? undefined : access.reason} reasonClassName="hint nz-gated-reason" onClick={() => { setNotice(null); setEditing({ site: null }); }}>Add site</GatedButton>
    </div>
    {notice ? <div className={`nz-banner ${notice.kind}`} role="status" style={{ margin: "12px 16px 0" }}>{notice.text}</div> : null}
    {sites.length === 0
      ? <p className="sub" style={{ padding: 16, margin: 0 }}>No sites configured for this client yet. Add one here, or from a CRP job&apos;s data entry.</p>
      : <ul className="nz-site-list">{sites.map((site) => {
        const status = siteLifecycleStatus(site, today);
        const area = areaToday(site, today);
        return <li key={site.id} className={status.kind === "vacated" ? "vacated" : undefined}>
          <button type="button" className="nz-site-open" onClick={() => { setNotice(null); setEditing({ site }); }} aria-label={`Open site ${site.name}`}>
            <span className="nz-site-name"><b>{site.name}</b>{site.isRegisteredOffice ? <span className="nz-st done">Registered office</span> : null}</span>
            <span className="nz-site-meta">{serviceRange(site)} · <span className={`nz-site-status ${status.kind}`}>{statusText(status)}</span></span>
            <span className="nz-site-meta">
              {periods.map((period) => { const inside = siteIsInReportingBoundary(site, period); return <span key={period.jobId} className={`nz-boundary-chip ${inside ? "in" : "out"}`} title={`${period.jobNumber} · ${formatDate(period.from)} to ${formatDate(period.to)}`}>{period.label} {inside ? "in" : "out"}</span>; })}
              <span className="muted">{area === null ? "No floor area" : `${area.toLocaleString("en-GB")} m²`}</span>
            </span>
          </button>
        </li>;
      })}</ul>}
    <p className="nz-site-legend">{periods.length
      ? "Boundary: a site is in a reporting period when it was in service on any day of it (NZC-070)."
      : "Boundary chips appear once the client has a CRP reporting period."}</p>
    <Drawer open={editing !== null} onClose={() => setEditing(null)} ariaLabel={editing?.site ? `Edit site ${editing.site.name}` : "Add a site"} className="nz-site-drawer">
      {editing ? <SiteForm key={editing.site?.id ?? "new"} clientId={clientId} site={editing.site} sites={sites} periods={periods} access={access}
        onClose={() => setEditing(null)}
        onSaved={(text) => { setEditing(null); setNotice({ kind: "ok", text }); router.refresh(); }}
        onPartial={() => router.refresh()} /> : null}
    </Drawer>
  </section>;
}

type Step = { name: string; path: string; input: Record<string, unknown> };
const errorText = (result: BrowserCommandResult<unknown>) =>
  result.state === "validation_failed" ? (result.issues[0]?.message ?? result.message) : result.state === "success" ? "" : result.message;

function SiteForm({ clientId, site, sites, periods, access, onClose, onSaved, onPartial }: {
  clientId: string; site: ClientSiteReadModel | null; sites: ClientSiteReadModel[]; periods: ClientReportingPeriod[]; access: EditAccess;
  onClose: () => void; onSaved: (text: string) => void; onPartial: () => void;
}) {
  const [name, setName] = useState(site?.name ?? "");
  const [beforeRecords, setBeforeRecords] = useState(site ? site.inServiceFrom === null : false);
  const [inServiceFrom, setInServiceFrom] = useState(site?.inServiceFrom ?? "");
  const [registered, setRegistered] = useState(site?.isRegisteredOffice ?? false);
  const [lifecycle, setLifecycle] = useState<"in-service" | "vacated">(site?.vacatedEffective ? "vacated" : "in-service");
  const [vacatedEffective, setVacatedEffective] = useState(site?.vacatedEffective ?? "");
  const [floorArea, setFloorArea] = useState("");
  const [floorFrom, setFloorFrom] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keys = useRef<Record<string, string>>({});

  const draftStart = beforeRecords ? null : inServiceFrom || null;
  const draftVacated = lifecycle === "vacated" ? vacatedEffective || null : null;
  const otherOffice = sites.find((item) => item.isRegisteredOffice && item.id !== site?.id);
  const area = floorArea.trim() === "" ? null : Number(floorArea);

  const problem = (() => {
    if (!name.trim()) return "Give the site a name.";
    if (!beforeRecords && !inServiceFrom) return "Give the in-service date, or tick “in service from before records”.";
    if (lifecycle === "vacated" && registered) return site?.isRegisteredOffice ? "This site is the registered office. Mark another site as the registered office before vacating it." : "A vacated site cannot be the registered office.";
    if (lifecycle === "vacated" && !vacatedEffective) return "Vacating needs its effective date — the first day out of service.";
    if (draftStart && draftVacated && draftVacated <= draftStart) return "The vacated effective date must be after the in-service date.";
    if (area !== null && !(Number.isFinite(area) && area > 0)) return "Floor area must be a number greater than zero.";
    if (area !== null && floorFrom && draftVacated && floorFrom >= draftVacated) return "A floor area cannot take effect once the site is vacated.";
    return null;
  })();

  const boundaryNote = periods.length && !(lifecycle === "vacated" && !draftVacated)
    ? periods.map((period) => `${period.label} ${siteIsInReportingBoundary({ inServiceFrom: draftStart, vacatedEffective: draftVacated }, period) ? "in" : "out"}`).join(" · ")
    : null;

  function steps(): Step[] {
    if (!site) return [{ name: "create", path: `/api/isolated/clients/${encodeURIComponent(clientId)}/sites`, input: { name: name.trim(), inServiceFrom: draftStart, isRegisteredOffice: registered, floorAreaM2: area } }];
    const base = `/api/isolated/sites/${encodeURIComponent(site.id)}`;
    const out: Step[] = [];
    if (name.trim() !== site.name || draftStart !== site.inServiceFrom) out.push({ name: "edit", path: `${base}/edit`, input: { name: name.trim(), inServiceFrom: draftStart } });
    if (lifecycle === "in-service" && site.vacatedEffective !== null) out.push({ name: "reinstate", path: `${base}/reinstate`, input: {} });
    if (registered !== site.isRegisteredOffice) out.push({ name: "registered-office", path: `${base}/registered-office`, input: { isRegisteredOffice: registered } });
    if (lifecycle === "vacated" && draftVacated !== site.vacatedEffective) out.push({ name: "vacate", path: `${base}/vacate`, input: { effectiveDate: draftVacated } });
    if (area !== null) out.push({ name: "floor-area", path: `${base}/floor-area`, input: { floorAreaM2: area, effectiveFrom: floorFrom || null } });
    return out;
  }

  async function save() {
    const plan = steps();
    if (!plan.length) { onClose(); return; }
    setPending(true);
    setError(null);
    let version = site?.version ?? 0;
    let applied = 0;
    for (const step of plan) {
      const input = site ? { ...step.input, expectedVersion: version } : step.input;
      const key = keys.current[step.name] ??= crypto.randomUUID();
      const result = await postBrowserCommand<{ version?: number }>(step.path, input, key);
      if (result.state !== "success") {
        setPending(false);
        setError(result.state === "conflict" ? "This site changed since it was opened. It has been refreshed — review and save again." : errorText(result));
        if (result.state === "conflict" || result.state === "validation_failed" || !result.retryable) keys.current = {};
        if (applied > 0 || result.state === "conflict") onPartial();
        return;
      }
      applied += 1;
      if (typeof result.data.version === "number") version = result.data.version;
    }
    keys.current = {};
    setPending(false);
    onSaved(site ? `${name.trim()} saved.` : `${name.trim()} added.`);
  }

  const blockedReason = access.state !== "allowed" ? access.reason : problem;
  return <div className="nz-site-drawer-body">
    <div className="nz-site-drawer-h"><div><div className="eyebrow">Site boundary</div><h3>{site ? site.name : "New site"}</h3></div><button type="button" className="close" onClick={onClose} aria-label="Close site drawer">✕</button></div>
    <label className="nz-fl">Site name<input className="nz-inp" value={name} onChange={(event) => setName(event.target.value)} /></label>

    <div className="nz-fl"><span>In service from</span>
      <input className="nz-inp" type="date" value={inServiceFrom} disabled={beforeRecords} onChange={(event) => setInServiceFrom(event.target.value)} aria-label="In service from" />
      <label className="nz-check"><input type="checkbox" checked={beforeRecords} onChange={(event) => setBeforeRecords(event.target.checked)} /> In service from before records</label>
    </div>

    <label className="nz-check nz-fl"><input type="checkbox" checked={registered} disabled={lifecycle === "vacated"} onChange={(event) => setRegistered(event.target.checked)} /> Registered office</label>
    {registered && otherOffice && !site?.isRegisteredOffice ? <p className="nz-figure-note">Saving moves the registered office from {otherOffice.name} to this site — a client has one.</p> : null}

    {site ? <fieldset className="nz-fl nz-seg-field"><legend>Status</legend>
      <div className="nz-seg" role="radiogroup" aria-label="Site status">
        {(["in-service", "vacated"] as const).map((value) => <label key={value} className={lifecycle === value ? "on" : undefined}><input type="radio" name="site-status" value={value} checked={lifecycle === value} onChange={() => setLifecycle(value)} />{value === "in-service" ? "In service" : "Vacated"}</label>)}
      </div>
    </fieldset> : null}
    {lifecycle === "vacated" ? <label className="nz-fl">Vacated effective date — the first day out of service<input className="nz-inp" type="date" value={vacatedEffective} min={draftStart ?? undefined} onChange={(event) => setVacatedEffective(event.target.value)} /></label> : null}
    {boundaryNote ? <div className="nz-banner ok" role="status">Reporting boundary with these dates: {boundaryNote}. A site stays in the boundary for any reporting period it was in service during.</div> : null}

    <div className="nz-sect">Floor area (per-m² intensity)</div>
    {site?.floorAreas.length ? <ul className="nz-floor-history">{site.floorAreas.map((record, index) => <li key={`${record.recordedAt}-${index}`}><span>{record.effectiveFrom ? `From ${formatDate(record.effectiveFrom)}` : "From the site's start"}</span><span className="num">{record.floorAreaM2.toLocaleString("en-GB")} m²</span></li>)}</ul> : <p className="nz-figure-note">No floor area recorded. Per-m² intensity is unavailable until every in-boundary site has one.</p>}
    <div className="nz-inp2">
      <label className="nz-fl" style={{ flex: 1 }}>{site ? "Record a new floor area (m²)" : "Floor area (m²)"}<input className="nz-inp" inputMode="decimal" value={floorArea} onChange={(event) => setFloorArea(event.target.value)} /></label>
      {site ? <label className="nz-fl" style={{ flex: 1 }}>Effective from<input className="nz-inp" type="date" value={floorFrom} onChange={(event) => setFloorFrom(event.target.value)} /></label> : null}
    </div>

    {error ? <div className="nz-banner warn" role="alert">{error}</div> : null}
    <div className="nz-site-drawer-actions">
      <GatedButton className="nz-btn pri" blocked={pending || blockedReason !== null} blockedReason={pending ? "Saving…" : blockedReason ?? undefined} reasonClassName="hint nz-gated-reason" onClick={() => void save()}>{pending ? "Saving…" : site ? "Save site" : "Add site"}</GatedButton>
      <button type="button" className="nz-btn" onClick={onClose}>Cancel</button>
    </div>
  </div>;
}
