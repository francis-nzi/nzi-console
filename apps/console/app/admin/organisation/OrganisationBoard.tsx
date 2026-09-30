"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { patchBrowserCommand, postBrowserCommand, postBrowserCommandWithReason, putBrowserCommandWithReason, type BrowserCommandResult } from "@nzi/api-client";
import {
  CLIENT_LOGO_MAX_BYTES, clientLogoContentTypes, intensityDividers, intensityIconKeys, intensityUnit, normaliseProfile, organisationFooter, type ClientLogoContentType, type IntensityDivider, type OrganisationProfileFields,
} from "@nzi/contracts";
import type { IntensityDefault, OrganisationBankView, OrganisationHistoryEntry, OrganisationProfileView } from "@nzi/isolated-backend";
import { AuditLine, CapabilityChip, FieldRow, SelectField, TextAreaField, TextField } from "@nzi/ui";
import { formatDateTime } from "../../lib/formatDate";

/**
 * The Organisation screen (admin Phase D, D1): the company profile as one form; the logo, the bank details and the
 * intensity defaults as their own cards, each with its own command. Bank details arrive masked and are shown only when
 * asked for; changing them always says why. Every change is recorded — field names, never values.
 */
type Editing = { allowed: true } | { allowed: false; reason: string };
type Draft = Record<keyof OrganisationProfileFields, string>;
const count = new Intl.NumberFormat("en-GB");
const toDraft = (fields: OrganisationProfileFields): Draft => Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, value ?? ""])) as Draft;
const toFields = (draft: Draft): OrganisationProfileFields => Object.fromEntries(Object.entries(draft).map(([key, value]) => [key, value.trim() ? value : null])) as OrganisationProfileFields;
const failure = (result: Exclude<BrowserCommandResult<unknown>, { state: "success" }>, what: string) =>
  result.state === "validation_failed" ? { issues: Object.fromEntries(result.issues.map((issue) => [issue.field, issue.message])), message: result.issues.map((issue) => issue.message)[0] ?? "Check the highlighted fields." }
  : { issues: {}, message: result.state === "conflict" ? `The ${what} changed since the page loaded. Refresh to see the latest, then make your change again.` : result.message };

export function OrganisationBoard({ profile, bank, defaults, clientsWithout, roster, editing }: {
  profile: OrganisationProfileView; bank: OrganisationBankView; defaults: IntensityDefault[]; clientsWithout: number;
  roster: Array<{ userId: string; displayName: string }>; editing: Editing;
}) {
  const router = useRouter();
  const [notice, setNotice] = useState<string | null>(null);
  // Every save — profile, logo, bank, defaults — refreshes the history, not only a profile save.
  const [saves, setSaves] = useState(0);
  const done = (message: string) => { setNotice(message); setSaves((value) => value + 1); router.refresh(); };
  return <>
    <div className="nz-a-page-head">
      <div>
        <div className="nz-a-eyebrow">Foundation</div>
        <h1>Organisation</h1>
        <p>The company profile behind quotes, invoices, certificates and report footers. Bank details are restricted to admin.settings and are never exposed on a public endpoint.</p>
      </div>
      <div className="nz-a-head-actions"><CapabilityChip capability="admin.settings" /></div>
    </div>
    <AuditLine version={profile.version}>{`${profile.provenance === "v7" ? "Imported · v7 · " : ""}Last changed ${formatDateTime(profile.updatedAt)} by ${profile.updatedBy} · every change is recorded in the audit log`}</AuditLine>
    {editing.allowed ? null : <div className="nz-a-hint-strip"><span aria-hidden="true">i</span><div><b>{editing.reason}</b></div></div>}
    {notice ? <div className="nz-a-notice" role="status">{notice}</div> : null}
    {/* Keyed by version: after a save the form starts again from what was stored (normalised), not from what was typed. */}
    <ProfileForm key={profile.version} profile={profile} roster={roster} editing={editing} onSaved={done} />
    <LogoCard profile={profile} editing={editing} onSaved={done} />
    <BankCard key={bank.version} bank={bank} editing={editing} onSaved={done} />
    <DefaultsCard defaults={defaults} clientsWithout={clientsWithout} editing={editing} onSaved={done} />
    <HistoryCard refresh={saves} />
  </>;
}

function ProfileForm({ profile, roster, editing, onSaved }: { profile: OrganisationProfileView; roster: Array<{ userId: string; displayName: string }>; editing: Editing; onSaved: (message: string) => void }) {
  const [draft, setDraft] = useState<Draft>(toDraft(profile.fields));
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const key = useRef(crypto.randomUUID());
  const readOnly = !editing.allowed;
  const field = (name: keyof OrganisationProfileFields, label: string, extra: { placeholder?: string; hint?: string; maxLength?: number; mono?: boolean } = {}) =>
    <TextField label={label} value={draft[name]} error={issues[name]} readOnly={readOnly} {...extra} onChange={(value) => setDraft({ ...draft, [name]: value })} />;
  // What will print once saved: the same normalising the command applies.
  const derived = organisationFooter({ ...normaliseProfile(toFields(draft)), footerOverride: null });
  const signatoryOptions = roster.map((member) => ({ value: member.userId, label: member.displayName }));
  if (profile.signatory && !roster.some((member) => member.userId === profile.signatory!.userId)) signatoryOptions.push({ value: profile.signatory.userId, label: `${profile.signatory.name} (not active)` });

  async function save() {
    if (saving || readOnly) return;
    setIssues({}); setProblem(null); setSaving(true);
    const result = await patchBrowserCommand("/api/isolated/organisation", { ...toFields(draft), expectedVersion: profile.version }, key.current);
    setSaving(false);
    if (result.state !== "success") { const failed = failure(result, "profile"); setIssues(failed.issues); setProblem(failed.message); return; }
    key.current = crypto.randomUUID();
    onSaved("Saved the organisation profile.");
  }

  return <div className="nz-a-section">
    <h3>Company profile</h3>
    {problem ? <div className="nz-a-error" role="alert">{problem}</div> : null}
    <FieldRow>{field("legalName", "Legal name", { maxLength: 200 })}{field("displayName", "Display name", { maxLength: 120, hint: "The name on screens, reports and the portal." })}</FieldRow>
    <FieldRow>{field("registrationNumber", "Company registration number", { mono: true })}{field("vatNumber", "VAT number", { mono: true, placeholder: "e.g. GB123456789" })}</FieldRow>
    <FieldRow>{field("websiteUrl", "Website", { placeholder: "https://" })}{field("contactEmail", "Contact email")}{field("contactPhone", "Contact phone")}</FieldRow>
    <h4 className="nz-a-subhead">Registered address</h4>
    {field("addressLine1", "Address line 1")}
    {field("addressLine2", "Address line 2")}
    <FieldRow>{field("addressCity", "Town or city")}{field("addressRegion", "County or region")}</FieldRow>
    <FieldRow>{field("addressPostcode", "Postcode", { mono: true })}{field("addressCountry", "Country")}</FieldRow>
    <h4 className="nz-a-subhead">Footer</h4>
    <div className="nz-a-hint">Derived from the profile: <b>{derived || "—"}</b></div>
    <TextAreaField label="Footer override" hint="Leave empty to use the derived footer — it then follows any change to the profile." value={draft.footerOverride} rows={2}
      error={issues.footerOverride} disabled={readOnly} onChange={(value) => setDraft({ ...draft, footerOverride: value })} />
    <h4 className="nz-a-subhead">Certificates</h4>
    <FieldRow>
      <SelectField label="Signatory" value={draft.signatoryUserId} placeholder="None" options={signatoryOptions} error={issues.signatoryUserId} disabled={readOnly}
        hint="A member of staff; their name is read from their staff record." onChange={(value) => setDraft({ ...draft, signatoryUserId: value })} />
      {field("signatoryTitle", "Signatory title", { maxLength: 120 })}
    </FieldRow>
    {readOnly ? null : <div><button type="button" className="nz-a-btn pri" disabled={saving} onClick={save}>{saving ? "Saving…" : "Save profile"}</button></div>}
  </div>;
}

function LogoCard({ profile, editing, onSaved }: { profile: OrganisationProfileView; editing: Editing; onSaved: (message: string) => void }) {
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  async function upload(selected: File | undefined) {
    if (!selected) return;
    setProblem(null);
    const contentType = selected.type as ClientLogoContentType;
    if (!(clientLogoContentTypes as readonly string[]).includes(contentType)) { setProblem("The logo must be a PNG or SVG."); return; }
    if (selected.size > CLIENT_LOGO_MAX_BYTES) { setProblem(`The logo must be ${CLIENT_LOGO_MAX_BYTES / 1024} KB or smaller.`); return; }
    setBusy(true);
    const dataBase64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).replace(/^data:[^;]+;base64,/, ""));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(selected);
    }).catch(() => null);
    if (dataBase64 === null) { setBusy(false); setProblem("The logo file could not be read."); return; }
    const result = await postBrowserCommand("/api/isolated/organisation/logo", { fileName: selected.name, contentType, dataBase64 }, crypto.randomUUID());
    setBusy(false);
    if (result.state !== "success") { setProblem(failure(result, "logo").message); return; }
    onSaved("Uploaded the organisation logo.");
  }
  async function remove() {
    setBusy(true); setProblem(null);
    const result = await postBrowserCommand("/api/isolated/organisation/logo/remove", {}, crypto.randomUUID());
    setBusy(false);
    if (result.state !== "success") { setProblem(failure(result, "logo").message); return; }
    onSaved("Removed the organisation logo. The file is kept in the audit trail.");
  }
  return <div className="nz-a-section">
    <h3>Logo</h3>
    {problem ? <div className="nz-a-error" role="alert">{problem}</div> : null}
    <div className="nz-a-logo-row">
      {profile.logo
        ? <img className="nz-a-logo" src={`/api/isolated/organisation/logo?asset=${encodeURIComponent(profile.logo.assetId)}`} alt={`${profile.fields.displayName ?? profile.organisationName} logo`} />
        : <span className="nz-a-logo nz-a-logo-empty" aria-label="No logo">{(profile.fields.displayName ?? profile.organisationName).slice(0, 1)}</span>}
      <div className="nz-a-hint">{profile.logo ? `${profile.logo.fileName} · ${profile.logo.byteSize < 1024 ? "under 1" : count.format(Math.round(profile.logo.byteSize / 1024))} KB · ${profile.logo.contentType === "image/png" ? "PNG" : "SVG"}` : "No logo yet — reports and the portal show the monogram."}<br />PNG or SVG, up to {CLIENT_LOGO_MAX_BYTES / 1024} KB; an SVG may not contain scripts or external references.</div>
    </div>
    {editing.allowed ? <div>
      <input ref={file} type="file" accept={clientLogoContentTypes.join(",")} hidden onChange={(event) => void upload(event.target.files?.[0])} />
      <button type="button" className="nz-a-btn" disabled={busy} onClick={() => file.current?.click()}>{profile.logo ? "Replace logo…" : "Upload logo…"}</button>
      {profile.logo ? <> <button type="button" className="nz-a-btn danger" disabled={busy} onClick={remove}>Remove</button></> : null}
    </div> : null}
  </div>;
}

function BankCard({ bank, editing, onSaved }: { bank: OrganisationBankView; editing: Editing; onSaved: (message: string) => void }) {
  const [shown, setShown] = useState<OrganisationBankView | null>(null);
  const [form, setForm] = useState<{ accountName: string; sortCode: string; accountNumber: string; reason: string } | null>(null);
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const view = shown ?? bank;

  async function show() {
    setProblem(null); setBusy(true);
    try {
      const response = await fetch("/api/isolated/organisation/bank?reveal=1", { cache: "no-store" });
      const body = await response.json() as OrganisationBankView & { message?: string };
      if (!response.ok) setProblem(body.message ?? "The bank details could not be read.");
      else setShown(body);
    } catch { setProblem("The bank details could not be read."); }
    setBusy(false);
  }
  async function save() {
    if (!form) return;
    setIssues({}); setProblem(null);
    if (!form.reason.trim()) { setIssues({ reason: "Say why the bank details are changing — it is recorded in the audit log." }); return; }
    setBusy(true);
    const body = { accountName: form.accountName || null, sortCode: form.sortCode || null, accountNumber: form.accountNumber || null, expectedVersion: bank.version };
    const result = await putBrowserCommandWithReason("/api/isolated/organisation/bank", body, crypto.randomUUID(), form.reason);
    setBusy(false);
    if (result.state !== "success") { const failed = failure(result, "bank details"); setIssues(failed.issues); setProblem(failed.message); return; }
    setForm(null); setShown(null);
    onSaved(body.accountNumber ? "Saved the bank details." : "Cleared the bank details.");
  }

  return <div className="nz-a-section nz-a-sensitive">
    <h3>Bank details <CapabilityChip capability="admin.settings" /></h3>
    {problem ? <div className="nz-a-error" role="alert">{problem}</div> : null}
    {!form ? <>
      {view.configured
        ? <dl className="nz-a-facts"><dt>Account name</dt><dd>{view.accountName}</dd><dt>Sort code</dt><dd className="nz-a-mono">{view.sortCode}</dd><dt>Account number</dt><dd className="nz-a-mono">{view.accountNumber}</dd></dl>
        : <p className="nz-a-muted">Not set. Invoices will print these once they are.</p>}
      <div className="nz-a-hint">Printed on invoices only (Phase E). Changing them always needs a reason, and the audit log records that they changed — never the numbers.</div>
      <div>
        {view.configured ? (shown ? <button type="button" className="nz-a-btn" onClick={() => setShown(null)}>Hide</button> : <button type="button" className="nz-a-btn" disabled={busy} onClick={show}>Show</button>) : null}
        {editing.allowed ? <> <button type="button" className="nz-a-btn" onClick={() => setForm({ accountName: bank.accountName ?? "", sortCode: "", accountNumber: "", reason: "" })}>{view.configured ? "Change…" : "Add…"}</button></> : null}
      </div>
    </> : <div className="nz-a-subform">
      <TextField label="Account name" value={form.accountName} maxLength={140} error={issues.accountName} onChange={(accountName) => setForm({ ...form, accountName })} />
      <FieldRow>
        <TextField label="Sort code" mono value={form.sortCode} placeholder="12-34-56" error={issues.sortCode} onChange={(sortCode) => setForm({ ...form, sortCode })} />
        <TextField label="Account number" mono value={form.accountNumber} placeholder="8 digits" error={issues.accountNumber} onChange={(accountNumber) => setForm({ ...form, accountNumber })} />
      </FieldRow>
      <div className="nz-a-hint">Enter all three, or leave all three empty to clear them.</div>
      <TextAreaField label="Reason for the change" hint="Required — it is recorded in the audit log." value={form.reason} rows={2} required error={issues.reason} onChange={(reason) => setForm({ ...form, reason })} />
      <div><button type="button" className="nz-a-btn pri" disabled={busy} onClick={save}>{busy ? "Saving…" : "Save bank details"}</button> <button type="button" className="nz-a-btn" onClick={() => { setForm(null); setIssues({}); setProblem(null); }}>Cancel</button></div>
    </div>}
  </div>;
}

type DefaultDraft = { metricKey: string; label: string; unitWording: string; divider: string; iconKey: string; expectedVersion: number; isNew: boolean };
const dividerLabel = (divider: number) => divider === 1 ? "per 1" : `per ${count.format(divider)}`;

function DefaultsCard({ defaults, clientsWithout, editing, onSaved }: { defaults: IntensityDefault[]; clientsWithout: number; editing: Editing; onSaved: (message: string) => void }) {
  const [draft, setDraft] = useState<DefaultDraft | null>(null);
  const [applying, setApplying] = useState<{ reason: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const active = defaults.filter((entry) => entry.active);

  async function saveDefault() {
    if (!draft) return;
    setProblem(null); setBusy(true);
    const result = await postBrowserCommand("/api/isolated/organisation/intensity-defaults", {
      metricKey: draft.metricKey.trim().toLowerCase(), label: draft.label, unitWording: draft.unitWording, divider: Number(draft.divider), iconKey: draft.iconKey, expectedVersion: draft.expectedVersion,
    }, crypto.randomUUID());
    setBusy(false);
    if (result.state !== "success") { setProblem(failure(result, "default").message); return; }
    setDraft(null);
    onSaved(`Saved the default “${draft.label.trim()}”. New clients start with it; existing clients keep their own.`);
  }
  async function deactivate(entry: IntensityDefault) {
    setProblem(null); setBusy(true);
    const result = await postBrowserCommand(`/api/isolated/organisation/intensity-defaults/${encodeURIComponent(entry.metricKey)}/deactivate`, { expectedVersion: entry.version }, crypto.randomUUID());
    setBusy(false);
    if (result.state !== "success") { setProblem(failure(result, "default").message); return; }
    onSaved(`Deactivated the default “${entry.label}”. New clients no longer start with it.`);
  }
  async function apply() {
    if (!applying) return;
    if (!applying.reason.trim()) { setProblem("Say why — applying the defaults changes the clients' records and is recorded in the audit log."); return; }
    setProblem(null); setBusy(true);
    const result = await postBrowserCommandWithReason<{ clients: number; metrics: number }>("/api/isolated/organisation/intensity-defaults/apply", { expectedClients: clientsWithout }, crypto.randomUUID(), applying.reason);
    setBusy(false);
    if (result.state !== "success") { setProblem(failure(result, "set of clients").message); return; }
    setApplying(null);
    onSaved(`Applied the defaults to ${count.format(result.data.clients)} clients (${count.format(result.data.metrics)} metrics).`);
  }

  return <div className="nz-a-section">
    <h3>Intensity-metric defaults</h3>
    <p>What a new client’s emissions are normalised against from the start. Each client can then change its own; a change here reaches new clients only.</p>
    {problem ? <div className="nz-a-error" role="alert">{problem}</div> : null}
    <ul className="nz-a-history">{defaults.map((entry) => <li key={entry.metricKey} className={entry.active ? undefined : "nz-a-muted"}>
      <b>{entry.label}</b> · {intensityUnit({ unitWording: entry.unitWording, divider: entry.divider as IntensityDivider })} · <span className="nz-a-mono">{entry.iconKey}</span>{entry.isStandard ? " · standard" : ""}{entry.active ? "" : " · inactive"}
      {editing.allowed && !draft ? <> <button type="button" className="nz-a-linkish" onClick={() => setDraft({ metricKey: entry.metricKey, label: entry.label, unitWording: entry.unitWording, divider: String(entry.divider), iconKey: entry.iconKey, expectedVersion: entry.version, isNew: false })}>{entry.active ? "Edit…" : "Reactivate…"}</button>
        {entry.active ? <> · <button type="button" className="nz-a-linkish" disabled={busy} onClick={() => void deactivate(entry)}>Deactivate</button></> : null}</> : null}
    </li>)}</ul>
    {draft ? <div className="nz-a-subform">
      <FieldRow>
        <TextField label="Label" value={draft.label} onChange={(label) => setDraft({ ...draft, label })} />
        <TextField label="Key" mono value={draft.metricKey} readOnly={!draft.isNew} hint={draft.isNew ? "Lower-case letters, digits and dashes; fixed once saved." : undefined} onChange={(metricKey) => setDraft({ ...draft, metricKey })} />
      </FieldRow>
      <FieldRow>
        <TextField label="Unit wording" value={draft.unitWording} placeholder="employee, £m, m²" onChange={(unitWording) => setDraft({ ...draft, unitWording })} />
        <SelectField label="Per" value={draft.divider} options={intensityDividers.map((value) => ({ value: String(value), label: dividerLabel(value) }))} onChange={(divider) => setDraft({ ...draft, divider })} />
        <SelectField label="Icon" value={draft.iconKey} options={intensityIconKeys.map((value) => ({ value, label: value }))} onChange={(iconKey) => setDraft({ ...draft, iconKey })} />
      </FieldRow>
      <div><button type="button" className="nz-a-btn pri" disabled={busy} onClick={saveDefault}>Save default</button> <button type="button" className="nz-a-btn" onClick={() => setDraft(null)}>Cancel</button></div>
    </div> : editing.allowed ? <button type="button" className="nz-a-btn" onClick={() => setDraft({ metricKey: "", label: "", unitWording: "", divider: "1", iconKey: "metric", expectedVersion: 0, isNew: true })}>+ Add a default</button> : null}

    <h4 className="nz-a-subhead">Clients with no intensity metric</h4>
    {clientsWithout === 0 ? <p className="nz-a-muted">Every client has at least one intensity metric.</p> : <>
      <p><b>{count.format(clientsWithout)}</b> client{clientsWithout === 1 ? " has" : "s have"} no intensity metric, so there is nothing to record intensity against for them.</p>
      {editing.allowed ? applying ? <div className="nz-a-subform">
        <p>This adds the {active.length} active default{active.length === 1 ? "" : "s"} ({active.map((entry) => entry.label).join(", ")}) to exactly those {count.format(clientsWithout)} clients. Clients that already have metrics are not touched. It is recorded as one audited change.</p>
        <TextAreaField label="Reason" hint="Required — recorded in the audit log." value={applying.reason} rows={2} required onChange={(reason) => setApplying({ reason })} />
        <div><button type="button" className="nz-a-btn pri" disabled={busy || active.length === 0} onClick={apply}>Apply to {count.format(clientsWithout)} clients</button> <button type="button" className="nz-a-btn" onClick={() => setApplying(null)}>Cancel</button></div>
      </div> : <button type="button" className="nz-a-btn" onClick={() => setApplying({ reason: "" })}>Apply the defaults to these clients…</button> : null}
    </>}
  </div>;
}

const HISTORY_LABEL: Record<string, string> = {
  "organisation.profile.updated": "Profile changed", "organisation.logo.set": "Logo uploaded", "organisation.logo.removed": "Logo removed",
  "organisation.bank.set": "Bank details changed", "organisation.intensity_default.set": "Default metric set",
  "organisation.intensity_default.deactivated": "Default metric deactivated", "organisation.intensity_defaults.applied": "Defaults applied to clients",
  "organisation.profile.imported": "Imported from v7",
};

function HistoryCard({ refresh }: { refresh: number }) {
  const [state, setState] = useState<{ state: "loading" } | { state: "failed" } | { state: "ready"; history: OrganisationHistoryEntry[] }>({ state: "loading" });
  useEffect(() => {
    let live = true;
    fetch("/api/isolated/organisation/history", { cache: "no-store" })
      .then(async (response) => { const body = await response.json() as { history?: OrganisationHistoryEntry[] }; if (live) setState(response.ok && body.history ? { state: "ready", history: body.history } : { state: "failed" }); })
      .catch(() => { if (live) setState({ state: "failed" }); });
    return () => { live = false; };
  }, [refresh]);
  return <div className="nz-a-section">
    <h3>History</h3>
    {state.state === "loading" ? <p className="nz-a-muted">Reading the audit log…</p>
      : state.state === "failed" ? <p className="nz-a-error" role="alert">The history could not be read — this is not the same as there being none.</p>
      : state.history.length === 0 ? <p className="nz-a-muted">No changes recorded yet.</p>
      : <ul className="nz-a-history">{state.history.map((entry, index) => <li key={index}>
        <b>{HISTORY_LABEL[entry.action] ?? entry.action}</b>{entry.changed.length ? <> · {entry.changed.join(", ")}</> : null}
        <div className="nz-a-sub">{formatDateTime(entry.at)} · {entry.actor}{entry.reason ? <> · “{entry.reason}”</> : null}</div>
      </li>)}</ul>}
  </div>;
}
