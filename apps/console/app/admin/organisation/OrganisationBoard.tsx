"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { patchBrowserCommand, postBrowserCommand, postBrowserCommandWithReason, putBrowserCommandWithReason } from "@nzi/api-client";
import {
  CLIENT_LOGO_MAX_BYTES, clientLogoContentTypes, intensityDividers, intensityIconKeys, intensityUnit, normaliseProfile, organisationFooter, ORGANISATION_PROFILE_FIELDS,
  type ClientLogoContentType, type IntensityDivider, type OrganisationProfileFields,
} from "@nzi/contracts";
import type { IntensityDefault, OrganisationBankView, OrganisationHistoryEntry, OrganisationProfileView } from "@nzi/isolated-backend";
import { AuditLine, CapabilityChip, FieldRow, SelectField, TextAreaField, TextField } from "@nzi/ui";
import { formatDateTime } from "../../lib/formatDate";
import { fieldIssues, statusOf, type ActionStatus } from "./actionStatus";

/**
 * The Organisation screen (admin Phase D, D1): the company profile as one form; the logo, the bank details and the
 * intensity defaults as their own cards, each with its own command. Bank details arrive masked and are shown only when
 * asked for; changing them always says why. Every change is recorded — field names, never values.
 *
 * **Every action says what happened, beside the button that did it** (the fast-follow to D1): saving, with the button
 * disabled and a spinner so nothing can be sent twice; "Saved — version N", after which the page reloads the stored
 * record; "No changes to save"; or, when someone else saved first, "changed since you opened it — reload". The profile is
 * one row by design: there is nothing to create, archive or delete here, only Save.
 */
type Editing = { allowed: true } | { allowed: false; reason: string };
type Draft = Record<keyof OrganisationProfileFields, string>;
type Card = "profile" | "logo" | "bank" | "defaults";
type Report = (card: Card, status: ActionStatus | null) => void;

const count = new Intl.NumberFormat("en-GB");
const toDraft = (fields: OrganisationProfileFields): Draft => Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, value ?? ""])) as Draft;
const toFields = (draft: Draft): OrganisationProfileFields => Object.fromEntries(Object.entries(draft).map(([key, value]) => [key, value.trim() ? value : null])) as OrganisationProfileFields;

/** Beside the button: a live region, so a screen reader hears it too. A conflict offers the reload it asks for. */
function StatusLine({ status }: { status: ActionStatus | null | undefined }) {
  if (!status || status.kind === "saving") return <span className="nz-a-status" role="status" aria-live="polite" />;
  const alert = status.kind === "conflict" || status.kind === "error";
  return <span className={`nz-a-status ${status.kind}`} role={alert ? "alert" : "status"} aria-live={alert ? "assertive" : "polite"}>
    {status.kind === "saved" ? <span aria-hidden="true">✓ </span> : null}{status.text}
    {status.kind === "conflict" ? <> <button type="button" className="nz-a-linkish" onClick={() => window.location.reload()}>Reload</button></> : null}
  </span>;
}

/** A button that cannot be pressed twice: disabled, with a spinner, while its request is in flight. */
function ActionButton({ busy, label, busyLabel = "Saving…", className = "nz-a-btn", disabled, onClick }: {
  busy: boolean; label: ReactNode; busyLabel?: string; className?: string; disabled?: boolean; onClick: () => void;
}) {
  return <button type="button" className={className} disabled={busy || disabled} aria-busy={busy} onClick={onClick}>
    {busy ? <><span className="nz-a-spinner" aria-hidden="true" />{busyLabel}</> : label}
  </button>;
}

/** One request at a time per card, whatever the button state says in between renders. */
function useInFlight() {
  const flying = useRef(false);
  return async (work: () => Promise<void>) => {
    if (flying.current) return;
    flying.current = true;
    try { await work(); } finally { flying.current = false; }
  };
}

export function OrganisationBoard({ profile, bank, defaults, clientsWithout, roster, editing }: {
  profile: OrganisationProfileView; bank: OrganisationBankView; defaults: IntensityDefault[]; clientsWithout: number;
  roster: Array<{ userId: string; displayName: string }>; editing: Editing;
}) {
  const router = useRouter();
  // Held here, above the cards, so a confirmation survives the reload that brings in the saved version.
  const [statuses, setStatuses] = useState<Partial<Record<Card, ActionStatus>>>({});
  const [saves, setSaves] = useState(0);
  const report: Report = (card, status) => setStatuses((previous) => ({ ...previous, [card]: status ?? undefined }));
  const saved = (card: Card, text: string) => { report(card, { kind: "saved", text }); setSaves((value) => value + 1); router.refresh(); };
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
    {/* Keyed by version: after a save the form starts again from what was stored (normalised), not from what was typed. */}
    <ProfileForm key={profile.version} profile={profile} roster={roster} editing={editing} status={statuses.profile} report={report} saved={saved} />
    <LogoCard profile={profile} editing={editing} status={statuses.logo} report={report} saved={saved} />
    <BankCard key={bank.version} bank={bank} editing={editing} status={statuses.bank} report={report} saved={saved} />
    <DefaultsCard defaults={defaults} clientsWithout={clientsWithout} editing={editing} status={statuses.defaults} report={report} saved={saved} />
    <HistoryCard refresh={saves} />
  </>;
}

type CardProps = { editing: Editing; status: ActionStatus | undefined; report: Report; saved: (card: Card, text: string) => void };

function ProfileForm({ profile, roster, editing, status, report, saved }: CardProps & { profile: OrganisationProfileView; roster: Array<{ userId: string; displayName: string }> }) {
  const [draft, setDraft] = useState<Draft>(toDraft(profile.fields));
  const [issues, setIssues] = useState<Record<string, string>>({});
  const key = useRef(crypto.randomUUID());
  const run = useInFlight();
  const readOnly = !editing.allowed;
  const busy = status?.kind === "saving";
  // An edit after a result clears it: "Saved" must never describe something typed since.
  const edit = (next: Draft) => { setDraft(next); if (status && status.kind !== "saving" && status.kind !== "conflict") report("profile", null); };
  const field = (name: keyof OrganisationProfileFields, label: string, extra: { placeholder?: string; hint?: string; maxLength?: number; mono?: boolean } = {}) =>
    <TextField label={label} value={draft[name]} error={issues[name]} readOnly={readOnly} {...extra} onChange={(value) => edit({ ...draft, [name]: value })} />;
  // What will print once saved: the same normalising the command applies.
  const derived = organisationFooter({ ...normaliseProfile(toFields(draft)), footerOverride: null });
  const signatoryOptions = roster.map((member) => ({ value: member.userId, label: member.displayName }));
  if (profile.signatory && !roster.some((member) => member.userId === profile.signatory!.userId)) signatoryOptions.push({ value: profile.signatory.userId, label: `${profile.signatory.name} (not active)` });

  const save = () => run(async () => {
    if (readOnly) return;
    setIssues({});
    // Nothing differs from what is stored (as the command would normalise it): say so, and send nothing.
    const next = normaliseProfile(toFields(draft)), stored = normaliseProfile(profile.fields);
    if (ORGANISATION_PROFILE_FIELDS.every((name) => next[name] === stored[name])) { report("profile", { kind: "nochange", text: "No changes to save." }); return; }
    report("profile", { kind: "saving", text: "Saving…" });
    const result = await patchBrowserCommand<{ version: number }>("/api/isolated/organisation", { ...toFields(draft), expectedVersion: profile.version }, key.current);
    if (result.state !== "success") { setIssues(fieldIssues(result)); report("profile", statusOf(result, "profile")); return; }
    key.current = crypto.randomUUID();
    saved("profile", `Saved — the profile is now version ${result.data.version}.`);
  });

  return <div className="nz-a-section">
    <h3>Company profile</h3>
    <FieldRow>{field("legalName", "Legal name", { maxLength: 200 })}{field("displayName", "Display name", { maxLength: 120, hint: "The name on screens, reports and the portal." })}{field("shortName", "Short name", { maxLength: 20, hint: "Used in client-facing copy, e.g. “your NZI consultant”. Empty uses the display name." })}</FieldRow>
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
      error={issues.footerOverride} disabled={readOnly} onChange={(value) => edit({ ...draft, footerOverride: value })} />
    <h4 className="nz-a-subhead">Certificates</h4>
    <FieldRow>
      <SelectField label="Signatory" value={draft.signatoryUserId} placeholder="None" options={signatoryOptions} error={issues.signatoryUserId} disabled={readOnly}
        hint="A member of staff; their name is read from their staff record." onChange={(value) => edit({ ...draft, signatoryUserId: value })} />
      {field("signatoryTitle", "Signatory title", { maxLength: 120 })}
    </FieldRow>
    {readOnly ? null : <div className="nz-a-actions"><ActionButton className="nz-a-btn pri" busy={busy} label="Save profile" onClick={() => void save()} /><StatusLine status={status} /></div>}
  </div>;
}

function LogoCard({ profile, editing, status, report, saved }: CardProps & { profile: OrganisationProfileView }) {
  const file = useRef<HTMLInputElement>(null);
  const run = useInFlight();
  const busy = status?.kind === "saving";
  const upload = (selected: File | undefined) => run(async () => {
    if (!selected) return;
    const contentType = selected.type as ClientLogoContentType;
    if (!(clientLogoContentTypes as readonly string[]).includes(contentType)) { report("logo", { kind: "error", text: "The logo must be a PNG or SVG." }); return; }
    if (selected.size > CLIENT_LOGO_MAX_BYTES) { report("logo", { kind: "error", text: `The logo must be ${CLIENT_LOGO_MAX_BYTES / 1024} KB or smaller.` }); return; }
    report("logo", { kind: "saving", text: "Uploading…" });
    const dataBase64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).replace(/^data:[^;]+;base64,/, ""));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(selected);
    }).catch(() => null);
    if (dataBase64 === null) { report("logo", { kind: "error", text: "The logo file could not be read." }); return; }
    const result = await postBrowserCommand<{ version: number }>("/api/isolated/organisation/logo", { fileName: selected.name, contentType, dataBase64 }, crypto.randomUUID());
    if (file.current) file.current.value = "";
    if (result.state !== "success") { report("logo", statusOf(result, "logo")); return; }
    saved("logo", `Saved — the logo is uploaded (profile version ${result.data.version}).`);
  });
  const remove = () => run(async () => {
    report("logo", { kind: "saving", text: "Removing…" });
    const result = await postBrowserCommand<{ version: number }>("/api/isolated/organisation/logo/remove", {}, crypto.randomUUID());
    if (result.state !== "success") { report("logo", statusOf(result, "logo")); return; }
    saved("logo", "Removed — the file is kept in the audit trail.");
  });
  return <div className="nz-a-section">
    <h3>Logo</h3>
    <div className="nz-a-logo-row">
      {profile.logo
        ? <img className="nz-a-logo" src={`/api/isolated/organisation/logo?asset=${encodeURIComponent(profile.logo.assetId)}`} alt={`${profile.fields.displayName ?? profile.organisationName} logo`} />
        : <span className="nz-a-logo nz-a-logo-empty" aria-label="No logo">{(profile.fields.displayName ?? profile.organisationName).slice(0, 1)}</span>}
      <div className="nz-a-hint">{profile.logo ? `${profile.logo.fileName} · ${profile.logo.byteSize < 1024 ? "under 1" : count.format(Math.round(profile.logo.byteSize / 1024))} KB · ${profile.logo.contentType === "image/png" ? "PNG" : "SVG"}` : "No logo yet — reports and the portal show the monogram."}<br />PNG or SVG, up to {CLIENT_LOGO_MAX_BYTES / 1024} KB; an SVG may not contain scripts or external references.</div>
    </div>
    {editing.allowed ? <div className="nz-a-actions">
      <input ref={file} type="file" accept={clientLogoContentTypes.join(",")} hidden onChange={(event) => void upload(event.target.files?.[0])} />
      <ActionButton busy={busy} busyLabel="Working…" label={profile.logo ? "Replace logo…" : "Upload logo…"} onClick={() => file.current?.click()} />
      {profile.logo ? <ActionButton className="nz-a-btn danger" busy={false} disabled={busy} label="Remove" onClick={() => void remove()} /> : null}
      <StatusLine status={status} />
    </div> : null}
  </div>;
}

function BankCard({ bank, editing, status, report, saved }: CardProps & { bank: OrganisationBankView }) {
  const [shown, setShown] = useState<OrganisationBankView | null>(null);
  const [form, setForm] = useState<{ accountName: string; sortCode: string; accountNumber: string; reason: string } | null>(null);
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [reading, setReading] = useState(false);
  const run = useInFlight();
  const busy = status?.kind === "saving";
  const view = shown ?? bank;

  async function show() {
    setReading(true);
    try {
      const response = await fetch("/api/isolated/organisation/bank?reveal=1", { cache: "no-store" });
      const body = await response.json() as OrganisationBankView & { message?: string };
      if (!response.ok) report("bank", { kind: "error", text: body.message ?? "The bank details could not be read." });
      else setShown(body);
    } catch { report("bank", { kind: "error", text: "The bank details could not be read." }); }
    setReading(false);
  }
  const save = () => run(async () => {
    if (!form) return;
    setIssues({});
    if (!form.reason.trim()) { setIssues({ reason: "Say why the bank details are changing — it is recorded in the audit log." }); report("bank", { kind: "error", text: "A reason is required." }); return; }
    report("bank", { kind: "saving", text: "Saving…" });
    const body = { accountName: form.accountName || null, sortCode: form.sortCode || null, accountNumber: form.accountNumber || null, expectedVersion: bank.version };
    const result = await putBrowserCommandWithReason<{ version: number; configured: boolean }>("/api/isolated/organisation/bank", body, crypto.randomUUID(), form.reason);
    if (result.state !== "success") { setIssues(fieldIssues(result)); report("bank", statusOf(result, "bank details")); return; }
    setForm(null); setShown(null);
    saved("bank", result.data.configured ? `Saved — the bank details are now version ${result.data.version}.` : `Cleared — the bank details are now version ${result.data.version}.`);
  });

  return <div className="nz-a-section nz-a-sensitive">
    <h3>Bank details <CapabilityChip capability="admin.settings" /></h3>
    {!form ? <>
      {view.configured
        ? <dl className="nz-a-facts"><dt>Account name</dt><dd>{view.accountName}</dd><dt>Sort code</dt><dd className="nz-a-mono">{view.sortCode}</dd><dt>Account number</dt><dd className="nz-a-mono">{view.accountNumber}</dd></dl>
        : <p className="nz-a-muted">Not set. Invoices will print these once they are.</p>}
      <div className="nz-a-hint">Printed on invoices only (Phase E). Changing them always needs a reason, and the audit log records that they changed — never the numbers.</div>
      <div className="nz-a-actions">
        {view.configured ? (shown ? <button type="button" className="nz-a-btn" onClick={() => setShown(null)}>Hide</button> : <ActionButton busy={reading} busyLabel="Reading…" label="Show" onClick={() => void show()} />) : null}
        {editing.allowed ? <button type="button" className="nz-a-btn" onClick={() => { report("bank", null); setForm({ accountName: bank.accountName ?? "", sortCode: "", accountNumber: "", reason: "" }); }}>{view.configured ? "Change…" : "Add…"}</button> : null}
        <StatusLine status={status} />
      </div>
    </> : <div className="nz-a-subform">
      <TextField label="Account name" value={form.accountName} maxLength={140} error={issues.accountName} onChange={(accountName) => setForm({ ...form, accountName })} />
      <FieldRow>
        <TextField label="Sort code" mono value={form.sortCode} placeholder="12-34-56" error={issues.sortCode} onChange={(sortCode) => setForm({ ...form, sortCode })} />
        <TextField label="Account number" mono value={form.accountNumber} placeholder="8 digits" error={issues.accountNumber} onChange={(accountNumber) => setForm({ ...form, accountNumber })} />
      </FieldRow>
      <div className="nz-a-hint">Enter all three, or leave all three empty to clear them.</div>
      <TextAreaField label="Reason for the change" hint="Required — it is recorded in the audit log." value={form.reason} rows={2} required error={issues.reason} onChange={(reason) => setForm({ ...form, reason })} />
      <div className="nz-a-actions">
        <ActionButton className="nz-a-btn pri" busy={busy} label="Save bank details" onClick={() => void save()} />
        <button type="button" className="nz-a-btn" disabled={busy} onClick={() => { setForm(null); setIssues({}); report("bank", null); }}>Cancel</button>
        <StatusLine status={status} />
      </div>
    </div>}
  </div>;
}

/** Q4: the organisation has no currency of its own until Phase E, so a currency default reads in GBP here. */
const DEFAULTS_CURRENCY = "GBP";
type DefaultDraft = { metricKey: string; label: string; unitWording: string; divider: string; iconKey: string; expectedVersion: number; isNew: boolean };
const dividerLabel = (divider: number) => divider === 1 ? "per 1" : `per ${count.format(divider)}`;

function DefaultsCard({ defaults, clientsWithout, editing, status, report, saved }: CardProps & { defaults: IntensityDefault[]; clientsWithout: number }) {
  const [draft, setDraft] = useState<DefaultDraft | null>(null);
  const [applying, setApplying] = useState<{ reason: string } | null>(null);
  const run = useInFlight();
  const busy = status?.kind === "saving";
  const active = defaults.filter((entry) => entry.active);

  const saveDefault = () => run(async () => {
    if (!draft) return;
    const current = defaults.find((entry) => entry.metricKey === draft.metricKey);
    if (current && current.active && current.label === draft.label.trim() && current.unitWording === draft.unitWording.trim() && String(current.divider) === draft.divider && current.iconKey === draft.iconKey) {
      report("defaults", { kind: "nochange", text: "No changes to save." }); return;
    }
    report("defaults", { kind: "saving", text: "Saving…" });
    const result = await postBrowserCommand<{ version: number }>("/api/isolated/organisation/intensity-defaults", {
      metricKey: draft.metricKey.trim().toLowerCase(), label: draft.label, unitWording: draft.unitWording, divider: Number(draft.divider), iconKey: draft.iconKey, expectedVersion: draft.expectedVersion,
    }, crypto.randomUUID());
    if (result.state !== "success") { report("defaults", statusOf(result, "default")); return; }
    setDraft(null);
    saved("defaults", `Saved “${draft.label.trim()}” (version ${result.data.version}). New clients start with it; existing clients keep their own.`);
  });
  const deactivate = (entry: IntensityDefault) => run(async () => {
    report("defaults", { kind: "saving", text: "Saving…" });
    const result = await postBrowserCommand("/api/isolated/organisation/intensity-defaults/" + encodeURIComponent(entry.metricKey) + "/deactivate", { expectedVersion: entry.version }, crypto.randomUUID());
    if (result.state !== "success") { report("defaults", statusOf(result, "default")); return; }
    saved("defaults", `Deactivated “${entry.label}”. New clients no longer start with it.`);
  });
  const apply = () => run(async () => {
    if (!applying) return;
    if (!applying.reason.trim()) { report("defaults", { kind: "error", text: "Say why — applying the defaults changes the clients' records and is recorded in the audit log." }); return; }
    report("defaults", { kind: "saving", text: "Applying…" });
    const result = await postBrowserCommandWithReason<{ clients: number; metrics: number }>("/api/isolated/organisation/intensity-defaults/apply", { expectedClients: clientsWithout }, crypto.randomUUID(), applying.reason);
    if (result.state !== "success") { report("defaults", statusOf(result, "set of clients")); return; }
    setApplying(null);
    saved("defaults", `Applied — ${count.format(result.data.clients)} clients now have the defaults (${count.format(result.data.metrics)} metrics).`);
  });

  return <div className="nz-a-section">
    <h3>Intensity-metric defaults</h3>
    <p>What a new client’s emissions are normalised against from the start. Each client can then change its own; a change here reaches new clients only.</p>
    <ul className="nz-a-history">{defaults.map((entry) => <li key={entry.metricKey} className={entry.active ? undefined : "nz-a-muted"}>
      <b>{entry.label}</b> · {/* A currency default reads in GBP until Phase E adds an organisation currency (D3, Q4). */}
      {intensityUnit({ unitWording: entry.unitWording, divider: entry.divider as IntensityDivider, unitKind: entry.unitKind }, { currency: DEFAULTS_CURRENCY })} · <span className="nz-a-mono">{entry.iconKey}</span>{entry.isStandard ? " · standard" : ""}{entry.active ? "" : " · inactive"}
      {editing.allowed && !draft ? <> <button type="button" className="nz-a-linkish" disabled={busy} onClick={() => { report("defaults", null); setDraft({ metricKey: entry.metricKey, label: entry.label, unitWording: entry.unitWording, divider: String(entry.divider), iconKey: entry.iconKey, expectedVersion: entry.version, isNew: false }); }}>{entry.active ? "Edit…" : "Reactivate…"}</button>
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
      <div className="nz-a-actions">
        <ActionButton className="nz-a-btn pri" busy={busy} label="Save default" onClick={() => void saveDefault()} />
        <button type="button" className="nz-a-btn" disabled={busy} onClick={() => { setDraft(null); report("defaults", null); }}>Cancel</button>
        <StatusLine status={status} />
      </div>
    </div> : editing.allowed ? <div className="nz-a-actions">
      <button type="button" className="nz-a-btn" disabled={busy} onClick={() => { report("defaults", null); setDraft({ metricKey: "", label: "", unitWording: "", divider: "1", iconKey: "metric", expectedVersion: 0, isNew: true }); }}>+ Add a default</button>
      {!applying ? <StatusLine status={status} /> : null}
    </div> : null}

    <h4 className="nz-a-subhead">Clients with no intensity metric</h4>
    {clientsWithout === 0 ? <p className="nz-a-muted">Every client has at least one intensity metric.</p> : <>
      <p><b>{count.format(clientsWithout)}</b> client{clientsWithout === 1 ? " has" : "s have"} no intensity metric, so there is nothing to record intensity against for them.</p>
      {editing.allowed ? applying ? <div className="nz-a-subform">
        <p>This adds the {active.length} active default{active.length === 1 ? "" : "s"} ({active.map((entry) => entry.label).join(", ")}) to exactly those {count.format(clientsWithout)} clients. Clients that already have metrics are not touched. It is recorded as one audited change.</p>
        <TextAreaField label="Reason" hint="Required — recorded in the audit log." value={applying.reason} rows={2} required onChange={(reason) => setApplying({ reason })} />
        <div className="nz-a-actions">
          <ActionButton className="nz-a-btn pri" busy={busy} busyLabel="Applying…" disabled={active.length === 0} label={`Apply to ${count.format(clientsWithout)} clients`} onClick={() => void apply()} />
          <button type="button" className="nz-a-btn" disabled={busy} onClick={() => { setApplying(null); report("defaults", null); }}>Cancel</button>
          <StatusLine status={status} />
        </div>
      </div> : <button type="button" className="nz-a-btn" disabled={busy} onClick={() => { report("defaults", null); setApplying({ reason: "" }); }}>Apply the defaults to these clients…</button> : null}
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
