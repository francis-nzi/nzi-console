"use client";
import {
  DEFAULT_SIGN_OFF, emailPersonFor, emailSignatureDocument, normaliseStaffSignature,
  type EmailBrand, type StaffSignatureDefaults, type StaffSignatureFields,
} from "@nzi/contracts";
import { FormEvent, useEffect, useState } from "react";

/**
 * The member's own email signature (email programme phase 5-2, R2): the personal lines — sign-off, title, email, mobile —
 * that go above the house chrome on the emails they send, with the name from their Team & access record. A live preview
 * draws the lines in the chrome exactly as a send does, in a frame with no permissions. Only ever their own: the route is
 * the session's.
 */

type Loaded = { fields: StaffSignatureFields; defaults: StaffSignatureDefaults; version: number; brand: EmailBrand };
type Draft = Record<keyof StaffSignatureFields, string>;
const ENDPOINT = "/api/account/signature";
const toDraft = (fields: StaffSignatureFields): Draft => ({ title: fields.title ?? "", displayEmail: fields.displayEmail ?? "", mobile: fields.mobile ?? "", signOff: fields.signOff ?? "" });

export function StaffSignature() {
  const [loaded, setLoaded] = useState<Loaded | null | "failed">(null);
  const [draft, setDraft] = useState<Draft>({ title: "", displayEmail: "", mobile: "", signOff: "" });
  const [issues, setIssues] = useState<Partial<Record<keyof StaffSignatureFields, string>>>({});
  const [notice, setNotice] = useState<{ message: string; ok: boolean } | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let live = true;
    fetch(ENDPOINT, { cache: "no-store" }).then(async (response) => {
      const body = await response.json().catch(() => ({}));
      if (!live) return;
      if (!response.ok || typeof body.version !== "number") { setLoaded("failed"); return; }
      setLoaded(body as Loaded); setDraft(toDraft(body.fields));
    }).catch(() => { if (live) setLoaded("failed"); });
    return () => { live = false; };
  }, []);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (pending || loaded === null || loaded === "failed") return;
    setPending(true); setNotice(null); setIssues({});
    try {
      const response = await fetch(ENDPOINT, { method: "PUT", headers: { "Content-Type": "application/json" }, cache: "no-store", body: JSON.stringify({ ...draft, expectedVersion: loaded.version }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setIssues(Object.fromEntries((Array.isArray(body.issues) ? body.issues : []).map((issue: { field: string; message: string }) => [issue.field, issue.message])));
        setNotice({ message: body.message ?? "Your signature was not saved.", ok: false });
        return;
      }
      setLoaded({ ...loaded, fields: body.fields, version: body.version }); setDraft(toDraft(body.fields));
      setNotice({ message: body.changed?.length ? "Signature saved. Emails you send from now on carry it." : "Nothing had changed.", ok: true });
    } catch { setNotice({ message: "The signature service could not confirm the save. Reload to check before trying again.", ok: false }); }
    finally { setPending(false); }
  }

  if (loaded === null) return <section className="nz-account-card" aria-busy="true"><span className="nz-eyebrow">Email signature</span><h2>Your signature</h2><p>Loading your signature…</p></section>;
  if (loaded === "failed") return <section className="nz-account-card" role="alert"><span className="nz-eyebrow">Email signature</span><h2>Your signature</h2><p>Your signature could not be read just now. Nothing is shown rather than lines that might not be yours.</p></section>;

  const fields: StaffSignatureFields = { title: draft.title, displayEmail: draft.displayEmail, mobile: draft.mobile, signOff: draft.signOff };
  const person = emailPersonFor(loaded.defaults, normaliseStaffSignature(fields));
  const input = (key: keyof StaffSignatureFields, label: string, placeholder: string, extra: { type?: string; autoComplete?: string } = {}) =>
    <label className="nz-fl">{label}<input className="nz-inp" name={key} value={draft[key]} placeholder={placeholder} disabled={pending} type={extra.type ?? "text"} autoComplete={extra.autoComplete ?? "off"}
      aria-invalid={issues[key] ? true : undefined} onChange={(event) => setDraft({ ...draft, [key]: event.target.value })} />{issues[key] ? <small className="nz-field-error" role="alert">{issues[key]}</small> : null}</label>;

  return <form onSubmit={save} className="nz-account-card nz-signature-card" aria-labelledby="account-signature-title" aria-busy={pending}>
    <span className="nz-eyebrow">Email signature</span>
    <h2 id="account-signature-title">Your signature</h2>
    <p>The lines above the Net Zero International signature on emails sent in your name, such as a client’s portal invitation. Leave a field empty to use the default shown.</p>
    <p className="nz-signature-name">Name: <b>{loaded.defaults.name ?? "—"}</b> — from your Team &amp; access record.</p>
    {input("signOff", "Sign-off", DEFAULT_SIGN_OFF)}
    {input("title", "Title", loaded.defaults.positionTitle ?? "Your title")}
    {input("displayEmail", "Email", loaded.defaults.workEmail ?? "you@netzero.international", { type: "email", autoComplete: "email" })}
    {input("mobile", "Mobile UK", "e.g. +44 7700 900123", { type: "tel", autoComplete: "tel" })}
    {person ? null : <div className="nz-banner warn" role="status">Your record has no name, so your emails carry the organisation’s signature only.</div>}
    <iframe className="nz-signature-preview" title="Preview of your email signature" sandbox="" srcDoc={emailSignatureDocument({ ...loaded.brand, person })} />
    {notice && <div className={`nz-banner ${notice.ok ? "ok" : "warn"}`} role={notice.ok ? "status" : "alert"}>{notice.message}</div>}
    <button className="nz-btn pri nz-auth-submit" disabled={pending}>{pending ? "Saving…" : "Save signature"}</button>
  </form>;
}
