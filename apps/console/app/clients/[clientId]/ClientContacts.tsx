"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Drawer, GatedButton } from "@nzi/ui";
import { patchBrowserCommand, postBrowserCommand, type BrowserCommandResult } from "@nzi/api-client";
import { clientContactRoleLabels, clientContactRoles, type ClientContactReadModel, type ClientContactRole } from "@nzi/contracts";
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

type Notice = { kind: "ok" | "warn"; text: string } | null;
const errorText = (result: BrowserCommandResult<unknown>) =>
  result.state === "validation_failed" ? (result.issues[0]?.message ?? result.message) : result.state === "success" ? "" : result.message;

export function ClientContacts({ clientId, contacts, access }: { clientId: string; contacts: ClientContactReadModel[]; access: EditAccess }) {
  const router = useRouter();
  const [editing, setEditing] = useState<{ contact: ClientContactReadModel | null } | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const blocked = access.state !== "allowed";

  return <section className="nz-panel">
    <div className="nz-card-h">
      <span className="eyebrow">Relationship</span><h2>Contacts</h2><span className="sp" />
      <GatedButton className="nz-editlink" blocked={blocked} blockedReason={access.state === "allowed" ? undefined : access.reason} reasonClassName="hint nz-gated-reason" onClick={() => { setNotice(null); setEditing({ contact: null }); }}>＋ Add</GatedButton>
    </div>
    {notice ? <div className={`nz-banner ${notice.kind}`} role="status" style={{ margin: "12px 16px 0" }}>{notice.text}</div> : null}
    <div className="nz-card-b">
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
          </div>
          <button type="button" className="nz-editlink" onClick={() => { setNotice(null); setEditing({ contact }); }} aria-label={`Edit contact ${contact.fullName}`}>Edit</button>
        </div>)}
    </div>
    <Drawer open={editing !== null} onClose={() => setEditing(null)} ariaLabel={editing?.contact ? `Edit contact ${editing.contact.fullName}` : "Add a contact"} className="nz-site-drawer" dismissOnOutsideClick>
      {editing ? <ContactForm key={editing.contact?.id ?? "new"} clientId={clientId} contact={editing.contact} access={access}
        onClose={() => setEditing(null)}
        onSaved={(text) => { setEditing(null); setNotice({ kind: "ok", text }); router.refresh(); }} /> : null}
    </Drawer>
  </section>;
}

function ContactForm({ clientId, contact, access, onClose, onSaved }: {
  clientId: string; contact: ClientContactReadModel | null; access: EditAccess; onClose: () => void; onSaved: (text: string) => void;
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
      {error ? <div className="nz-banner warn" role="alert">{error}</div> : null}
    </div>
    <div className="nz-df">
      <span className="sp" />
      {contact ? <GatedButton className="nz-btn danger" blocked={pending || access.state !== "allowed"} blockedReason={pending ? "Saving…" : access.state === "allowed" ? undefined : access.reason} reasonClassName="hint nz-gated-reason" onClick={() => void remove()}>Remove</GatedButton> : null}
      <GatedButton className="nz-btn pri" blocked={pending || blockedReason !== null} blockedReason={pending ? "Saving…" : blockedReason ?? undefined} reasonClassName="hint nz-gated-reason" onClick={() => void save()}>{pending ? "Saving…" : "Save contact"}</GatedButton>
    </div>
  </>;
}
