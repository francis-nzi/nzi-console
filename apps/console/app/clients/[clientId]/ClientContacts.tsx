"use client";

import { useRef, useState } from "react";
import { GatedButton } from "@nzi/ui";
import { patchBrowserCommand, postBrowserCommand, type BrowserCommandResult } from "@nzi/api-client";
import { clientContactRoleLabels, clientContactRoles, contactConsentBasisLabels, contactConsentView, staffRecordableBases, type ClientContactReadModel, type ClientContactRole, type ContactConsentDecision, type ContactConsentEvent, type StaffRecordableBasis } from "@nzi/contracts";
import { formatDate } from "../../lib/formatDate";
import type { EditAccess } from "../../lib/useEditAccess";

/**
 * Client contacts with roles (client workspace v9). Each role feeds one downstream
 * picker — report signees, portal candidates, invoice recipients, training attendees —
 * and every change goes through the contact commands (contact.manage), versioned and
 * deactivated rather than deleted.
 */

/** The short badge each role wears on the contacts list. */
export const contactRoleBadges: Record<ClientContactRole, string> = {
  report_signee: "Signee", portal_candidate: "Portal", invoice_recipient: "Billing", training_attendee: "Training",
};

const errorText = (result: BrowserCommandResult<unknown>) =>
  result.state === "validation_failed" ? (result.issues[0]?.message ?? result.message) : result.state === "success" ? "" : result.message;

/**
 * How a contact's email consent reads on the list.
 *
 * Never a bare "granted": the state always appears with the basis and date behind it, or
 * says that there is none. A state with no recorded decision is what a hand-edited database
 * looks like, and the whole point of the consent control is that it should be visible.
 */
function ConsentLine({ contact, latest }: { contact: ClientContactReadModel; latest: ContactConsentEvent | null }) {
  const view = contactConsentView(contact.emailConsent, latest);
  const tone = view.kind === "sendable" ? "done" : view.kind === "unevidenced" ? "need" : "est";
  return <div className="nz-consent-line">
    <span className={`nz-st ${tone}`}>{view.label}</span>
    <span className="sub">
      {view.kind === "sendable"
        ? `${view.detail} · ${formatDate(view.event.recordedAt.slice(0, 10))}`
        : view.kind === "refused" && view.event !== null
          ? `${view.detail} Recorded ${formatDate(view.event.recordedAt.slice(0, 10))}.`
          : view.detail}
    </span>
  </div>;
}

/** The card. Editing happens in the workspace's drawer host, not here. */
export function ClientContacts({ contacts, consent, consentUnavailable, access, onEdit }: {
  contacts: ClientContactReadModel[];
  /** Newest decision per contact; a contact with none is not in here. */
  consent: ContactConsentEvent[];
  /**
   * Set when the consent history could not be read at all. Distinct from an empty `consent`,
   * which means "no decision has been recorded" — the opposite claim.
   */
  consentUnavailable: string | null;
  access: EditAccess;
  onEdit: (contact: ClientContactReadModel | null) => void;
}) {
  const blocked = access.state !== "allowed";
  const latestByContact = new Map(consent.map((event) => [event.contactId, event]));

  return <section className="nz-panel">
    <div className="nz-card-h">
      <span className="eyebrow">Relationship</span><h2>Contacts</h2><span className="sp" />
      <GatedButton className="nz-editlink" blocked={blocked} blockedReason={access.state === "allowed" ? undefined : access.reason} reasonClassName="hint nz-gated-reason" onClick={() => onEdit(null)}>＋ Add</GatedButton>
    </div>
    <div className="nz-card-b">
      {consentUnavailable !== null ? <div className="nz-banner warn" role="status" style={{ margin: "0 0 10px" }}>{consentUnavailable}</div> : null}
      {contacts.length === 0
        ? <p className="sub" style={{ margin: "8px 0" }}>No contacts yet. Add the people this client works through — and mark who signs reports, who can use the portal and who receives invoices.</p>
        : contacts.map((contact) => <div key={contact.id} className="nz-lrow">
          <div className="ic" aria-hidden="true">◔</div>
          <div className="main">
            <div className="nm">{contact.fullName}</div>
            {contact.jobTitle ? <div className="sub">{contact.jobTitle}</div> : null}
            {contact.isPrimary || contact.roles.length ? <div className="nz-rolebadges">
              {contact.isPrimary ? <span className="nz-tag">Primary</span> : null}
              {contact.roles.map((role) => <span key={role} className="nz-tag rr" title={clientContactRoleLabels[role]}>{contactRoleBadges[role]}</span>)}
            </div> : null}
            {/* Only where there is an address to email. A contact with none cannot be
                written to whatever the state says, and a consent line there would imply a
                channel that does not exist. */}
            {/* An unreadable history is not "no decision recorded". The state is still shown —
                it is on the contact row itself — but without a basis it cannot be vouched for,
                so the line says that rather than implying nobody ever decided. */}
            {contact.email
              ? consentUnavailable !== null
                ? <div className="nz-consent-line"><span className="nz-st need">Consent history unavailable</span></div>
                : <ConsentLine contact={contact} latest={latestByContact.get(contact.id) ?? null} />
              : null}
          </div>
          <button type="button" className="nz-editlink" onClick={() => onEdit(contact)} aria-label={`Edit contact ${contact.fullName}`}>Edit</button>
        </div>)}
    </div>
  </section>;
}

export function ContactForm({ clientId, contact, latestConsent, access, onClose, onSaved }: {
  clientId: string; contact: ClientContactReadModel | null;
  /** The newest decision for this contact, so the drawer can show a basis rather than a bare state. */
  latestConsent: ContactConsentEvent | null;
  access: EditAccess; onClose: () => void; onSaved: (text: string) => void;
}) {
  const [fullName, setFullName] = useState(contact?.fullName ?? "");
  const [jobTitle, setJobTitle] = useState(contact?.jobTitle ?? "");
  const [email, setEmail] = useState(contact?.email ?? "");
  const [phone, setPhone] = useState(contact?.phone ?? "");
  const [isPrimary, setPrimary] = useState(contact?.isPrimary ?? false);
  const [roles, setRoles] = useState<ClientContactRole[]>(contact?.roles ?? []);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = useRef<string | null>(null);

  const problem = !fullName.trim() ? "Give the contact's full name."
    : email.trim() && !/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email.trim()) ? "Enter a valid email address."
    : roles.includes("portal_candidate") && !email.trim() ? "A portal candidate needs an email address to be invited."
    : null;
  const toggle = (role: ClientContactRole) => setRoles((current) => current.includes(role) ? current.filter((item) => item !== role) : clientContactRoles.filter((item) => item === role || current.includes(item)));

  async function run(path: string, input: Record<string, unknown>, method: "post" | "patch", done: string) {
    setPending(true);
    setError(null);
    key.current ??= crypto.randomUUID();
    const result = await (method === "patch" ? patchBrowserCommand : postBrowserCommand)<{ version: number }>(path, input, key.current);
    setPending(false);
    if (result.state !== "success") {
      key.current = null;
      setError(result.state === "conflict" ? "This contact changed since it was opened. Close and reopen it to see the latest." : errorText(result));
      return;
    }
    key.current = null;
    onSaved(done);
  }
  const fields = { fullName: fullName.trim(), jobTitle: jobTitle.trim() || null, email: email.trim() || null, phone: phone.trim() || null, isPrimary, roles };
  const save = () => contact
    ? run(`/api/isolated/contacts/${encodeURIComponent(contact.id)}`, { ...fields, expectedVersion: contact.version }, "patch", `${fields.fullName} saved.`)
    : run(`/api/isolated/clients/${encodeURIComponent(clientId)}/contacts`, fields, "post", `${fields.fullName} added.`);
  const remove = () => contact && run(`/api/isolated/contacts/${encodeURIComponent(contact.id)}/deactivate`, { expectedVersion: contact.version }, "post", `${contact.fullName} removed. Their history stays on the record.`);

  const blockedReason = access.state !== "allowed" ? access.reason : problem;
  return <>
    <div className="nz-dh"><div className="k">Relationship</div><h3>{contact ? contact.fullName : "New contact"}</h3><button type="button" className="x" onClick={onClose} aria-label="Close">×</button></div>
    <div className="nz-db">
      <div className="nz-two">
        <label className="nz-fl"><span>Full name<span className="nz-req">*</span></span><input className="nz-inp" value={fullName} onChange={(event) => setFullName(event.target.value)} autoComplete="off" /></label>
        <label className="nz-fl"><span>Job title</span><input className="nz-inp" value={jobTitle} onChange={(event) => setJobTitle(event.target.value)} autoComplete="off" /></label>
      </div>
      <label className="nz-fl"><span>Email</span><input className="nz-inp" type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="off" /></label>
      <label className="nz-fl"><span>Phone</span><input className="nz-inp" type="tel" value={phone} placeholder="Optional" onChange={(event) => setPhone(event.target.value)} autoComplete="off" /></label>
      <div className="nz-fl"><span>Roles <span className="nz-hint" style={{ display: "inline", fontWeight: 500 }}>— what this contact is used for downstream</span></span>
        <div className="nz-roles" role="group" aria-label="Contact roles">
          <label className="nz-rolechk"><input type="checkbox" checked={isPrimary} onChange={(event) => setPrimary(event.target.checked)} /> Primary contact</label>
          {clientContactRoles.map((role) => <label key={role} className="nz-rolechk"><input type="checkbox" checked={roles.includes(role)} onChange={() => toggle(role)} /> {clientContactRoleLabels[role]}</label>)}
        </div>
        <span className="nz-hint">Signee appears on published reports; portal candidate can be invited to the portal; recipient receives commercial documents; attendee is eligible for training places.</span>
      </div>
      {/* Consent is its own governed decision, not a contact field: it has its own command,
          its own audited event and its own action. Saving the contact must not be a way to
          change it by accident, so it is recorded here and never by the Save below. */}
      {contact ? <ContactConsent contact={contact} latest={latestConsent} access={access} onRecorded={onSaved} /> : null}
      {error ? <div className="nz-banner warn" role="alert">{error}</div> : null}
    </div>
    <div className="nz-df">
      <span className="sp" />
      {contact ? <GatedButton className="nz-btn danger" blocked={pending || access.state !== "allowed"} blockedReason={pending ? "Saving…" : access.state === "allowed" ? undefined : access.reason} reasonClassName="hint nz-gated-reason" onClick={() => void remove()}>Remove</GatedButton> : null}
      <GatedButton className="nz-btn pri" blocked={pending || blockedReason !== null} blockedReason={pending ? "Saving…" : blockedReason ?? undefined} reasonClassName="hint nz-gated-reason" onClick={() => void save()}>{pending ? "Saving…" : "Save contact"}</GatedButton>
    </div>
  </>;
}

/**
 * Recording whether this contact may be emailed by automations.
 *
 * Deliberately not a checkbox on the contact form. Consent is a decision with a basis and an
 * author, audited as its own event — a control that could be flipped in passing while
 * editing a phone number would be exactly the casual permission this gate exists to prevent.
 *
 * It records; it sends nothing. Staging suppresses every send, and production sending stays
 * behind gate (b), the live worker standup.
 */
function ContactConsent({ contact, latest, access, onRecorded }: {
  contact: ClientContactReadModel;
  latest: ContactConsentEvent | null;
  access: EditAccess;
  onRecorded: (text: string) => void;
}) {
  const [basis, setBasis] = useState<StaffRecordableBasis>("consultant-recorded");
  const [note, setNote] = useState("");
  const [pending, setPending] = useState<ContactConsentDecision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = useRef<string | null>(null);
  const view = contactConsentView(contact.emailConsent, latest);

  async function record(state: ContactConsentDecision) {
    setPending(state);
    setError(null);
    key.current ??= crypto.randomUUID();
    const result = await postBrowserCommand<{ version: number }>(
      `/api/isolated/contacts/${encodeURIComponent(contact.id)}/consent`,
      { expectedVersion: contact.version, state, basis, note: note.trim() || null },
      key.current);
    setPending(null);
    if (result.state !== "success") {
      key.current = null;
      setError(result.state === "conflict"
        ? "This contact changed since it was opened. Close and reopen it to see the latest."
        : errorText(result));
      return;
    }
    key.current = null;
    onRecorded(state === "granted"
      ? `Consent recorded for ${contact.fullName}.`
      : `${contact.fullName} recorded as declined. Nothing further will be sent to them.`);
  }

  if (!contact.email) {
    return <div className="nz-fl"><span>Email consent</span>
      <span className="nz-hint">This contact has no email address, so nothing can be sent to them and there is nothing to consent to.</span>
    </div>;
  }

  const blocked = access.state !== "allowed";
  return <div className="nz-consent">
    <span className="l">Email consent</span>
    <div className="nz-consent-now">
      <span className={`nz-st ${view.kind === "sendable" ? "done" : view.kind === "unevidenced" ? "need" : "est"}`}>{view.label}</span>
      <span className="sub">{view.detail}</span>
    </div>
    {latest !== null ? <p className="nz-hint" style={{ marginTop: 4 }}>
      Last recorded by {latest.recordedBy} on {formatDate(latest.recordedAt.slice(0, 10))}
      {latest.note ? ` — “${latest.note}”` : ""}.
    </p> : null}

    <label className="nz-fl" style={{ marginTop: 8 }}><span>How this reached NZI</span>
      <select className="nz-inp" value={basis} onChange={(event) => setBasis(event.target.value as StaffRecordableBasis)}>
        {staffRecordableBases.map((option) => <option key={option} value={option}>{contactConsentBasisLabels[option]}</option>)}
      </select>
    </label>
    <label className="nz-fl"><span>Note <span className="nz-hint" style={{ display: "inline", fontWeight: 500 }}>— optional; what was said, and when</span></span>
      <input className="nz-inp" value={note} onChange={(event) => setNote(event.target.value)} placeholder="Confirmed by email, 12/09/2026" autoComplete="off" />
    </label>
    <span className="nz-hint">
      Recording consent does not send anything. It lifts the block so reminders may be sent once the
      live sending gate is open.
    </span>
    {error ? <div className="nz-banner warn" role="alert">{error}</div> : null}
    <div className="nz-consent-actions">
      <GatedButton className="nz-btn" blocked={blocked || pending !== null || contact.emailConsent === "declined"}
        blockedReason={blocked ? access.reason : pending !== null ? "Recording…" : contact.emailConsent === "declined" ? "Already recorded as declined." : undefined}
        reasonClassName="hint nz-gated-reason" onClick={() => void record("declined")}>
        {pending === "declined" ? "Recording…" : "Record declined"}
      </GatedButton>
      <GatedButton className="nz-btn pri" blocked={blocked || pending !== null || contact.emailConsent === "granted"}
        blockedReason={blocked ? access.reason : pending !== null ? "Recording…" : contact.emailConsent === "granted" ? "Already recorded as consented." : undefined}
        reasonClassName="hint nz-gated-reason" onClick={() => void record("granted")}>
        {pending === "granted" ? "Recording…" : "Record consent"}
      </GatedButton>
    </div>
  </div>;
}
