"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { GatedButton } from "@nzi/ui";
import { patchBrowserCommand, postBrowserCommand, putBrowserCommand, type BrowserCommandResult } from "@nzi/api-client";
import { CLIENT_LOGO_MAX_BYTES, clientLogoContentTypes, clientReportingFrequencies, reportingPeriodForYear, type ClientLogoContentType, type ClientReportingFrequency } from "@nzi/contracts";
import type { ClientScreenReadModel } from "@nzi/isolated-backend";
import { formatDate } from "../../lib/formatDate";
import type { EditAccess } from "../../lib/useEditAccess";

/**
 * The client's identity & profile (client workspace v9): the logo (with monogram
 * fallback), name, status, industry, SIC, reporting frequency, currency and the
 * financial year end — which sets every future reporting year's period and so the
 * 300–400 day eligibility rule. Saved through client.update (client.edit), audited.
 */

export const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const;
export const monthName = (month: number | null | undefined) => month && month >= 1 && month <= 12 ? MONTHS[month - 1]! : null;
export const monogram = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word[0]!.toUpperCase()).join("");
export const clientLogoUrl = (client: Pick<ClientScreenReadModel, "id" | "logoAssetId">) => client.logoAssetId ? `/api/isolated/clients/${encodeURIComponent(client.id)}/logo?v=${encodeURIComponent(client.logoAssetId)}` : null;

const STATUSES = [["active", "Active"], ["onboarding", "Onboarding"], ["at-risk", "At risk"], ["prospect", "Prospect"]] as const;
const FREQUENCY_LABEL: Record<ClientReportingFrequency, string> = { annual: "Annual", quarterly: "Quarterly", monthly: "Monthly" };
const errorText = (result: BrowserCommandResult<unknown>) =>
  result.state === "validation_failed" ? (result.issues[0]?.message ?? result.message) : result.state === "success" ? "" : result.message;

/** The logo, or the monogram when there is none (or it fails to load). */
export function ClientMark({ client, className, size }: { client: Pick<ClientScreenReadModel, "id" | "name" | "logoAssetId">; className: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  const url = clientLogoUrl(client);
  const style = size ? { width: size, height: size } : undefined;
  return url && !failed
    ? <span className={`${className} has-img`} style={style}><img src={url} alt={`${client.name} logo`} onError={() => setFailed(true)} /></span>
    : <span className={className} style={style} aria-hidden="true">{monogram(client.name)}</span>;
}

/** The header badge: the logo or monogram, opening the identity drawer. */
export function ClientLogoBadge({ client, onOpen }: { client: ClientScreenReadModel; onOpen: () => void }) {
  const [failed, setFailed] = useState(false);
  const url = clientLogoUrl(client);
  return <button type="button" className={`nz-client-monogram logo${url && !failed ? " has-img" : ""}`} onClick={onOpen} title="Client logo — identity & profile" aria-label="Client logo — edit identity and profile">
    {url && !failed ? <img src={url} alt="" onError={() => setFailed(true)} /> : monogram(client.name)}
    <span className="logocam" aria-hidden="true">✎</span>
  </button>;
}

/** The Identity & profile card: what the drawer edits, read-only. */
export function ClientProfileCard({ client, onEdit }: { client: ClientScreenReadModel; onEdit: () => void }) {
  const profile = client.profile;
  const fye = monthName(profile.financialYearEndMonth);
  return <section className="nz-panel">
    <div className="nz-card-h"><span className="eyebrow">Company</span><h2>Identity &amp; profile</h2><span className="sp" /><button type="button" className="nz-editlink" onClick={onEdit}>Edit</button></div>
    <div style={{ padding: "6px 16px 12px" }}>
      <Kv label="Industry" value={client.sector || "—"} />
      <Kv label="SIC" value={profile.industrySic || "—"} />
      <Kv label="Website" value={profile.website ? profile.website.replace(/^https?:\/\//, "") : "—"} />
      <Kv label="Reporting frequency" value={FREQUENCY_LABEL[profile.dataReportingFrequency ?? "annual"]} />
      <Kv label="Currency" value={profile.currency ?? "GBP"} />
      <Kv label="Financial year end" value={fye ?? "Not set — reporting years default to the calendar year"} />
    </div>
  </section>;
}
function Kv({ label, value }: { label: string; value: string }) { return <div className="nz-kv"><span className="k">{label}</span><span className="v">{value}</span></div>; }

export function IdentityForm({ client, access, onClose }: { client: ClientScreenReadModel; access: EditAccess; onClose: () => void }) {
  const router = useRouter();
  const profile = client.profile;
  const [name, setName] = useState(client.name);
  const [status, setStatus] = useState(client.status);
  const [sector, setSector] = useState(client.sector);
  const [sic, setSic] = useState(profile.industrySic ?? "");
  const [frequency, setFrequency] = useState<ClientReportingFrequency>(profile.dataReportingFrequency ?? "annual");
  const [currency, setCurrency] = useState(profile.currency ?? "GBP");
  const [fye, setFye] = useState<number | null>(profile.financialYearEndMonth ?? null);
  const [pending, setPending] = useState<"save" | "logo" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [logoNotice, setLogoNotice] = useState<string | null>(null);
  const keys = useRef<Record<string, string>>({});
  const file = useRef<HTMLInputElement>(null);

  const problem = !name.trim() ? "Give the client's name." : !sector.trim() ? "Give the client's industry."
    : !/^[A-Z]{3}$/.test(currency.trim()) ? "Currency must be a three-letter ISO code, e.g. GBP."
    : fye === null ? "Choose the financial year end — it sets each reporting year's period." : null;
  const example = fye !== null ? reportingPeriodForYear(new Date().getUTCFullYear(), fye) : null;
  const fyeChanged = fye !== (profile.financialYearEndMonth ?? null);

  async function save() {
    setPending("save");
    setError(null);
    const input = {
      expectedVersion: client.version, name: name.trim(), status, sector: sector.trim(), location: client.location, owner: client.owner,
      ...profile, industrySic: sic.trim() || null, dataReportingFrequency: frequency, currency: currency.trim(), financialYearEndMonth: fye,
    };
    const key = keys.current.save ??= crypto.randomUUID();
    const result = await patchBrowserCommand<{ version: number }>(`/api/isolated/commands/clients/${encodeURIComponent(client.id)}`, input, key);
    setPending(null);
    if (result.state !== "success") {
      delete keys.current.save;
      setError(result.state === "conflict" ? "The client record changed since this was opened. Close and reopen to see the latest." : errorText(result));
      return;
    }
    delete keys.current.save;
    onClose();
    router.refresh();
  }

  async function upload(selected: File | undefined) {
    if (!selected) return;
    setError(null);
    setLogoNotice(null);
    const contentType = selected.type as ClientLogoContentType;
    if (!(clientLogoContentTypes as readonly string[]).includes(contentType)) { setError("The logo must be a PNG or SVG."); return; }
    if (selected.size > CLIENT_LOGO_MAX_BYTES) { setError(`The logo must be ${CLIENT_LOGO_MAX_BYTES / 1024} KB or smaller.`); return; }
    setPending("logo");
    const dataBase64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).replace(/^data:[^;]+;base64,/, ""));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(selected);
    }).catch(() => null);
    if (dataBase64 === null) { setPending(null); setError("The logo file could not be read."); return; }
    const result = await putBrowserCommand<{ assetId: string }>(`/api/isolated/clients/${encodeURIComponent(client.id)}/logo`, { fileName: selected.name, contentType, dataBase64 }, crypto.randomUUID());
    setPending(null);
    if (file.current) file.current.value = "";
    if (result.state !== "success") { setError(errorText(result)); return; }
    setLogoNotice("Logo uploaded. It now shows on the client record and the portal, and on reports validated from now on.");
    router.refresh();
  }

  async function removeLogo() {
    setPending("logo");
    setError(null);
    const result = await postBrowserCommand<{ assetId: null }>(`/api/isolated/clients/${encodeURIComponent(client.id)}/logo/remove`, {}, crypto.randomUUID());
    setPending(null);
    if (result.state !== "success") { setError(errorText(result)); return; }
    setLogoNotice("Logo removed — the monogram is shown instead. Reports already validated keep the logo they were released with.");
    router.refresh();
  }

  const denied = access.state !== "allowed" ? access.reason : null;
  const blockedReason = denied ?? problem;
  return <>
    <div className="nz-dh"><div className="k">Company</div><h3>Identity &amp; profile</h3><button type="button" className="x" onClick={onClose} aria-label="Close">×</button></div>
    <div className="nz-db">
      <div className="nz-fl"><span>Logo</span>
        <div className="nz-logorow">
          <ClientMark client={client} className="nz-identity-logo" />
          <div>
            <input ref={file} type="file" accept={clientLogoContentTypes.join(",")} hidden onChange={(event) => void upload(event.target.files?.[0])} />
            <GatedButton className="nz-btn" blocked={pending !== null || denied !== null} blockedReason={pending ? "Working…" : undefined} reasonClassName="hint nz-gated-reason" onClick={() => file.current?.click()}>⭱ Upload logo</GatedButton>{" "}
            {client.logoAssetId ? <GatedButton className="nz-btn danger" blocked={pending !== null || denied !== null} blockedReason={pending ? "Working…" : undefined} reasonClassName="hint nz-gated-reason" onClick={() => void removeLogo()}>Remove</GatedButton> : null}
            <span className="nz-hint">PNG or SVG. Appears on the client record, the portal and published reports. Falls back to the monogram if none.</span>
          </div>
        </div>
        {logoNotice ? <span className="nz-hint" role="status">{logoNotice}</span> : null}
      </div>
      <div className="nz-two">
        <label className="nz-fl"><span>Client name<span className="nz-req">*</span></span><input className="nz-inp" value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label className="nz-fl"><span>Status</span><select className="nz-sel" value={status} onChange={(event) => setStatus(event.target.value as typeof status)}>{STATUSES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      </div>
      <div className="nz-two">
        <label className="nz-fl"><span>Industry<span className="nz-req">*</span></span><input className="nz-inp" value={sector} onChange={(event) => setSector(event.target.value)} /></label>
        <label className="nz-fl"><span>SIC</span><input className="nz-inp" value={sic} onChange={(event) => setSic(event.target.value)} /></label>
      </div>
      <div className="nz-three">
        <label className="nz-fl"><span>Reporting freq.</span><select className="nz-sel" value={frequency} onChange={(event) => setFrequency(event.target.value as ClientReportingFrequency)}>{clientReportingFrequencies.map((value) => <option key={value} value={value}>{FREQUENCY_LABEL[value]}</option>)}</select></label>
        <label className="nz-fl"><span>Currency</span><input className="nz-inp" value={currency} maxLength={3} onChange={(event) => setCurrency(event.target.value.toUpperCase())} /></label>
        <label className="nz-fl"><span>Financial year end<span className="nz-req">*</span></span>
          <select className="nz-sel" value={fye ?? ""} onChange={(event) => setFye(event.target.value ? Number(event.target.value) : null)} aria-label="Financial year end">
            {fye === null ? <option value="" disabled>Select month…</option> : null}
            {MONTHS.map((month, index) => <option key={month} value={index + 1}>{month}</option>)}
          </select>
        </label>
      </div>
      <span className="nz-hint">The financial year end sets each reporting year&apos;s period and drives reporting-year eligibility (the 300–400 day rule) — so it must be correct before a job is issued.</span>
      {example ? <span className="nz-hint" role="status">With this year end, FY{String(new Date().getUTCFullYear()).slice(-2)} runs {formatDate(example.from)}–{formatDate(example.to)}.{fyeChanged ? " Jobs already issued keep the period they were issued with; the change is recorded in the audit log." : ""}</span> : null}
      {error ? <div className="nz-banner warn" role="alert" style={{ marginTop: 12 }}>{error}</div> : null}
    </div>
    <div className="nz-df">
      <button type="button" className="nz-btn" onClick={onClose}>Cancel</button><span className="sp" />
      <GatedButton className="nz-btn pri" blocked={pending !== null || blockedReason !== null} blockedReason={pending === "save" ? "Saving…" : blockedReason ?? undefined} reasonClassName="hint nz-gated-reason" onClick={() => void save()}>{pending === "save" ? "Saving…" : "Save profile"}</GatedButton>
    </div>
  </>;
}
