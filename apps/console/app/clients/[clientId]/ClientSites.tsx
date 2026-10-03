"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { GatedButton } from "@nzi/ui";
import { postBrowserCommand, type BrowserCommandResult } from "@nzi/api-client";
import { isoCountryName, SITE_ADDRESS_MAX_LINES, siteFloorAreaForPeriod, siteIsInReportingBoundary, siteLifecycleStatus, type ClientSiteReadModel } from "@nzi/contracts";
import type { ClientReportingPeriod } from "@nzi/isolated-backend";
import { formatDate } from "../../lib/formatDate";
import { CountrySelect } from "../../lib/CountrySelect";
import type { EditAccess } from "../../lib/useEditAccess";

/**
 * NZC-070 / NZC-071 — the client's operational sites (client workspace v8), backend-fed.
 * Status is derived from today against the dates; each row's boundary statement comes
 * from the resolver; every change goes through the site commands and persists.
 */

type Notice = { kind: "ok" | "warn"; text: string } | null;
type Dates = Pick<ClientSiteReadModel, "inServiceFrom" | "vacatedEffective">;

const area = (value: number) => `${value.toLocaleString("en-GB")} m²`;
const areaToday = (site: ClientSiteReadModel, today: string) => siteFloorAreaForPeriod(site, { from: today, to: today });

/** "in FY24 boundary, out from FY25" — which of the client's reporting periods this site falls in. */
export function boundaryStatement(site: Dates, periods: readonly ClientReportingPeriod[]): string | null {
  if (!periods.length) return null;
  const membership = periods.map((period) => ({ label: period.label, inside: siteIsInReportingBoundary(site, period) }));
  const ins = membership.filter((m) => m.inside);
  if (ins.length === membership.length) return null;
  if (!ins.length) return `not in the ${membership.map((m) => m.label).join(" or ")} boundary`;
  const firstIn = membership.findIndex((m) => m.inside);
  const lastIn = membership.map((m) => m.inside).lastIndexOf(true);
  if (lastIn < membership.length - 1) return `in ${membership[lastIn]!.label} boundary, out from ${membership[lastIn + 1]!.label}`;
  return `in boundary from ${membership[firstIn]!.label}`;
}

function siteLine(site: ClientSiteReadModel, today: string, periods: readonly ClientReportingPeriod[]): string {
  const status = siteLifecycleStatus(site, today);
  const floor = areaToday(site, today);
  const parts: string[] = [];
  if (status.kind === "vacated") {
    if (floor !== null || site.floorAreas.length) parts.push(area(site.floorAreas[site.floorAreas.length - 1]!.floorAreaM2));
    parts.push(`vacated ${formatDate(status.vacatedOn)}`);
  } else {
    parts.push(status.kind === "planned" ? `Starts ${formatDate(status.startsOn)}` : site.inServiceFrom ? `In service from ${formatDate(site.inServiceFrom)}` : "In service from: date unknown");
    parts.push(floor === null ? "no floor area" : area(floor));
    if (status.kind === "in-service" && status.vacatesOn) parts.push(`vacates ${formatDate(status.vacatesOn)}`);
  }
  const boundary = boundaryStatement(site, periods);
  if (boundary) parts.push(boundary);
  return parts.join(" · ");
}

/** The site's address on one line: its lines, postcode and country name. */
const addressLine = (site: ClientSiteReadModel) => [...(site.addressLines ?? []), site.postcode, isoCountryName(site.country)].filter(Boolean).join(", ");

/**
 * CLIENT-04 — where the site is, said quietly: located; or not, and why — geocoding switched off, no postcode and country
 * to locate it from, or the lookup came back empty (with a retry). Never an error: the site is saved either way.
 */
function SiteLocation({ site, geocodingEnabled, access }: { site: ClientSiteReadModel; geocodingEnabled: boolean; access: EditAccess }) {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "working" | "missed">("idle");
  if (site.located) return <span className="nz-site-loc ok">Located</span>;
  if (!geocodingEnabled) return <span className="nz-site-loc">Not located — geocoding is not enabled</span>;
  if (!site.postcode || !site.country) return <span className="nz-site-loc">Not located — add a postcode and country to locate it</span>;
  async function retry() {
    setState("working");
    const result = await postBrowserCommand<{ location?: string }>(`/api/isolated/sites/${encodeURIComponent(site.id)}/locate`, {}, crypto.randomUUID());
    if (result.state === "success" && (result.data.location === "located" || result.data.location === "already")) { router.refresh(); return; }
    setState("missed");
  }
  return <span className="nz-site-loc">{state === "missed" ? "Still couldn’t locate it from its postcode" : "Couldn’t locate it from its postcode"}
    {access.state === "allowed" ? <> · <button type="button" className="nz-editlink" disabled={state === "working"} onClick={() => void retry()}>{state === "working" ? "Locating…" : "Retry"}</button></> : null}</span>;
}

/** The card. The site drawer lives in the workspace's drawer host. */
export function ClientSites({ sites, reportingPeriods, today, access, onEdit, geocodingEnabled = false }: { sites: ClientSiteReadModel[]; reportingPeriods: ClientReportingPeriod[]; today: string; access: EditAccess; onEdit: (site: ClientSiteReadModel | null) => void; geocodingEnabled?: boolean }) {
  const periods = [...reportingPeriods].reverse();
  const blocked = access.state !== "allowed";

  return <section className="nz-panel">
    <div className="nz-card-h">
      <span className="eyebrow">Operations</span><h2>Sites</h2><span className="sp" />
      <GatedButton className="nz-editlink" blocked={blocked} blockedReason={access.state === "allowed" ? undefined : access.reason} reasonClassName="hint nz-gated-reason" onClick={() => onEdit(null)}>＋ Add</GatedButton>
    </div>
    <div className="nz-card-b">
      {sites.length === 0
        ? <p className="sub" style={{ margin: "8px 0" }}>No sites configured for this client yet. Add one here, or from a CRP job&apos;s data entry.</p>
        : sites.map((site) => {
          const status = siteLifecycleStatus(site, today);
          return <div key={site.id} className={`nz-lrow${status.kind === "vacated" ? " off" : ""}`}>
            <div className="ic" aria-hidden="true">⌂</div>
            <div className="main">
              <div className="nm">{site.name}{site.isRegisteredOffice ? <span className="nz-tag reg">Registered</span> : null}{status.kind === "vacated" ? <span className="nz-tag vac">Vacated</span> : null}{status.kind === "planned" ? <span className="nz-tag plan">Planned</span> : null}</div>
              <div className="sub">{siteLine(site, today, periods)}</div>
              {addressLine(site) ? <div className="sub">{addressLine(site)}</div> : null}
              <div className="sub"><SiteLocation site={site} geocodingEnabled={geocodingEnabled} access={access} /></div>
            </div>
            <button type="button" className="nz-editlink" onClick={() => onEdit(site)} aria-label={`Edit site ${site.name}`}>Edit</button>
          </div>;
        })}
    </div>
  </section>;
}

type Step = { name: string; path: string; input: Record<string, unknown> };
const errorText = (result: BrowserCommandResult<unknown>) =>
  result.state === "validation_failed" ? (result.issues[0]?.message ?? result.message) : result.state === "success" ? "" : result.message;

export function SiteForm({ clientId, site, sites, periods, access, onClose, onSaved, onPartial }: {
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
  // CLIENT-11 — the structured address: lines, a postcode or zip, and the country (an ISO code, chosen by name).
  const heldLines = site?.addressLines ?? [];
  const [lines, setLines] = useState<string[]>(() => [...heldLines, ...Array<string>(Math.max(0, 3 - heldLines.length)).fill("")].slice(0, SITE_ADDRESS_MAX_LINES));
  const [postcode, setPostcode] = useState(site?.postcode ?? "");
  const [country, setCountry] = useState<string | null>(site?.country ?? null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keys = useRef<Record<string, string>>({});

  const draftStart = beforeRecords ? null : inServiceFrom || null;
  const draftVacated = lifecycle === "vacated" ? vacatedEffective || null : null;
  const otherOffice = sites.find((item) => item.isRegisteredOffice && item.id !== site?.id);
  const floor = floorArea.trim() === "" ? null : Number(floorArea);

  const problem = (() => {
    if (!name.trim()) return "Give the site a name.";
    if (!beforeRecords && !inServiceFrom) return "Give the in-service date, or tick “Date unknown”.";
    if (lifecycle === "vacated" && registered) return site?.isRegisteredOffice ? "This site is the registered office. Mark another site as the registered office before vacating it." : "A vacated site cannot be the registered office.";
    if (lifecycle === "vacated" && !vacatedEffective) return "Vacating needs its effective date — the first day out of service.";
    if (draftStart && draftVacated && draftVacated <= draftStart) return "The vacated effective date must be after the in-service date.";
    if (floor !== null && !(Number.isFinite(floor) && floor > 0)) return "Floor area must be a number greater than zero.";
    if (floor !== null && floorFrom && draftVacated && floorFrom >= draftVacated) return "A floor area cannot take effect once the site is vacated.";
    return null;
  })();
  const boundary = !(lifecycle === "vacated" && !draftVacated) ? boundaryStatement({ inServiceFrom: draftStart, vacatedEffective: draftVacated }, periods) : null;

  const address = { addressLines: lines.map((line) => line.trim()).filter(Boolean), postcode: postcode.trim() || null, country };
  const addressChanged = !site || JSON.stringify(address.addressLines) !== JSON.stringify(site.addressLines ?? []) || address.postcode !== (site.postcode ?? null) || country !== (site.country ?? null);

  function steps(): Step[] {
    if (!site) return [{ name: "create", path: `/api/isolated/clients/${encodeURIComponent(clientId)}/sites`, input: { name: name.trim(), inServiceFrom: draftStart, isRegisteredOffice: registered, floorAreaM2: floor, ...address } }];
    const base = `/api/isolated/sites/${encodeURIComponent(site.id)}`;
    const out: Step[] = [];
    if (name.trim() !== site.name || draftStart !== site.inServiceFrom || addressChanged) out.push({ name: "edit", path: `${base}/edit`, input: { name: name.trim(), inServiceFrom: draftStart, ...address } });
    if (lifecycle === "in-service" && site.vacatedEffective !== null) out.push({ name: "reinstate", path: `${base}/reinstate`, input: {} });
    if (registered !== site.isRegisteredOffice) out.push({ name: "registered-office", path: `${base}/registered-office`, input: { isRegisteredOffice: registered } });
    if (lifecycle === "vacated" && draftVacated !== site.vacatedEffective) out.push({ name: "vacate", path: `${base}/vacate`, input: { effectiveDate: draftVacated } });
    if (floor !== null) out.push({ name: "floor-area", path: `${base}/floor-area`, input: { floorAreaM2: floor, effectiveFrom: floorFrom || null } });
    return out;
  }

  async function save() {
    const plan = steps();
    if (!plan.length) { onClose(); return; }
    setPending(true);
    setError(null);
    let version = site?.version ?? 0;
    let applied = 0;
    let location: string | undefined;
    for (const step of plan) {
      const input = site ? { ...step.input, expectedVersion: version } : step.input;
      const key = keys.current[step.name] ??= crypto.randomUUID();
      const result = await postBrowserCommand<{ version?: number; location?: string }>(step.path, input, key);
      if (result.state !== "success") {
        setPending(false);
        setError(result.state === "conflict" ? "This site changed since it was opened. It has been refreshed — review and save again." : errorText(result));
        if (result.state === "conflict" || result.state === "validation_failed" || !result.retryable) keys.current = {};
        if (applied > 0 || result.state === "conflict") onPartial();
        return;
      }
      applied += 1;
      if (typeof result.data.version === "number") version = result.data.version;
      if (typeof result.data.location === "string") location = result.data.location;
    }
    keys.current = {};
    setPending(false);
    // CLIENT-04: the save stands whatever the lookup did; say quietly if it could not locate the site.
    const located = location === "located" ? " Located from its postcode." : location === "not-found" || location === "failed" || location === "stale" ? " It couldn’t be located from its postcode — retry from the list." : "";
    onSaved(site ? `${name.trim()} saved.${located}` : `${name.trim()} added.${located}`);
  }

  const blockedReason = access.state !== "allowed" ? access.reason : problem;
  return <>
    <div className="nz-dh"><div className="k">Operations</div><h3>{site ? site.name : "New site"}</h3><button type="button" className="x" onClick={onClose} aria-label="Close">×</button></div>
    <div className="nz-db">
      <label className="nz-fl"><span>Site name<span className="nz-req">*</span></span><input className="nz-inp" value={name} onChange={(event) => setName(event.target.value)} /></label>
      <label className="nz-check"><input type="checkbox" checked={registered} disabled={lifecycle === "vacated"} onChange={(event) => setRegistered(event.target.checked)} /> Registered office</label>
      {registered && otherOffice && !site?.isRegisteredOffice ? <span className="nz-hint">Saving moves the registered office from {otherOffice.name} to this site — a client has one.</span> : null}

      <div className="nz-two" style={{ marginTop: 14 }}>
        <div className="nz-fl"><span>In service from<span className="nz-req">*</span></span>
          <input className="nz-inp" type="date" value={inServiceFrom} disabled={beforeRecords} onChange={(event) => setInServiceFrom(event.target.value)} aria-label="In service from" />
          <label className="nz-check"><input type="checkbox" checked={beforeRecords} onChange={(event) => setBeforeRecords(event.target.checked)} /> Date unknown</label>
        </div>
        {site ? <div className="nz-fl"><span>Status</span>
          <div className="nz-seg" role="radiogroup" aria-label="Site status">
            {(["in-service", "vacated"] as const).map((value) => <label key={value} className={lifecycle === value ? "on" : undefined} title={value === "vacated" ? "Vacating closes the site from a date; earlier reporting years keep it." : undefined}><input type="radio" name="site-status" value={value} checked={lifecycle === value} onChange={() => setLifecycle(value)} />{value === "in-service" ? "In service" : "Vacated"}</label>)}
          </div>
        </div> : null}
      </div>
      {lifecycle === "vacated" ? <label className="nz-fl"><span>Vacated effective date<span className="nz-req">*</span></span><input className="nz-inp" type="date" value={vacatedEffective} min={draftStart ?? undefined} onChange={(event) => setVacatedEffective(event.target.value)} />
        <span className="nz-hint">First day out of service. The site stays in the reporting boundary up to this date, then drops out. YoY and per-m² intensity use the boundary as at each reporting year.</span></label> : null}
      {boundary ? <span className="nz-hint" role="status" style={{ marginBottom: 14 }}>With these dates the site is {boundary}.</span> : null}

      <div className="nz-fl"><span>Floor area (m²)</span>
        {site?.floorAreas.length ? <ul className="nz-floor-history">{site.floorAreas.map((record, index) => <li key={`${record.recordedAt}-${index}`}><span>{record.effectiveFrom ? `From ${formatDate(record.effectiveFrom)}` : "From the site's start"}</span><span className="num">{area(record.floorAreaM2)}</span></li>)}</ul> : null}
        <div className="nz-two">
          <input className="nz-inp num" inputMode="decimal" value={floorArea} placeholder={site?.floorAreas.length ? "New floor area" : "Floor area"} aria-label="Floor area (m²)" onChange={(event) => setFloorArea(event.target.value)} />
          {site ? <input className="nz-inp" type="date" value={floorFrom} aria-label="Floor area effective from" title="Effective from (blank = from the site's start)" onChange={(event) => setFloorFrom(event.target.value)} /> : null}
        </div>
        <span className="nz-hint">Leave blank if unknown.</span>
      </div>

      <div className="nz-fl"><span>Address</span>
        {lines.map((line, index) => <input key={index} className="nz-inp" style={{ marginTop: index ? 6 : 5 }} value={line} aria-label={`Address line ${index + 1}`}
          onChange={(event) => setLines((current) => current.map((value, at) => at === index ? event.target.value : value))} />)}
      </div>
      <div className="nz-two">
        <label className="nz-fl"><span>Postcode / zip</span><input className="nz-inp" value={postcode} autoComplete="off" onChange={(event) => setPostcode(event.target.value)} /></label>
        <CountrySelect label="Country" value={country} onChange={setCountry} />
      </div>
      <span className="nz-hint">The postcode and country locate the site on the map; only those two are sent to the geocoder.</span>

      {error ? <div className="nz-banner warn" role="alert">{error}</div> : null}
    </div>
    <div className="nz-df">
      <button type="button" className="nz-btn" onClick={onClose}>Cancel</button><span className="sp" />
      <GatedButton className="nz-btn pri" blocked={pending || blockedReason !== null} blockedReason={pending ? "Saving…" : blockedReason ?? undefined} reasonClassName="hint nz-gated-reason" onClick={() => void save()}>{pending ? "Saving…" : site ? "Save site" : "Add site"}</GatedButton>
    </div>
  </>;
}
