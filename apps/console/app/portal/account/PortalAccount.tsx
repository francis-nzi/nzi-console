"use client";

import { FormEvent, useState } from "react";

export function PortalAccount() {
  const [notice, setNotice] = useState<{ message: string; ok: boolean } | null>(null);
  const [pending, setPending] = useState(false);
  const [passwordLength, setPasswordLength] = useState(0);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (pending) return; setPending(true); setNotice(null);
    const formElement = event.currentTarget, form = new FormData(formElement), newPassword = String(form.get("newPassword") ?? ""), confirmation = String(form.get("confirmation") ?? "");
    if (newPassword !== confirmation) { setPending(false); setNotice({ message: "New password confirmation does not match.", ok: false }); return; }
    try { const response = await fetch("/api/portal/auth/password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ currentPassword: form.get("currentPassword"), newPassword }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message ?? "Password change failed.");
      if (body.changed !== true) throw new Error("The password service returned an invalid confirmation. Your password state could not be verified.");
      setNotice({ message: "Password changed. Other portal sessions have been signed out; MFA remains active.", ok: true });
      formElement.reset(); setPasswordLength(0);
    } catch (cause) { setNotice({ message: cause instanceof Error ? cause.message : "The secure password service could not be reached. Your password has not been changed.", ok: false }); }
    finally { setPending(false); }
  }

  return <main className="nz-account-shell">
    <header className="nz-account-header"><a href="/portal" className="nz-portal-brand"><span>N</span><div><b>NZI Pro</b><small>Client portal</small></div></a><a href="/portal" className="nz-btn">Back to reporting jobs</a></header>
    <section className="nz-account-layout">
      <aside className="nz-account-brief"><span className="nz-eyebrow light">Account protection</span><h1>Keep your reporting workspace secure.</h1><p>A strong, unique password protects published reports, review conversations and client-supplied data.</p><div className="nz-account-trust"><span><i>✓</i> Minimum 12 characters</span><span><i>✓</i> MFA remains active</span><span><i>✓</i> Other sessions revoked on change</span></div></aside>
      <form onSubmit={submit} className="nz-account-card" aria-busy={pending}><span className="nz-eyebrow">Client portal security</span><h2>Change password</h2><p>Confirm your current password, then choose a new password used only for NZI Pro.</p><label className="nz-fl">Current password<input className="nz-inp" name="currentPassword" type="password" autoComplete="current-password" required disabled={pending} /></label><div className="nz-account-divider"/><label className="nz-fl">New password<input className="nz-inp" name="newPassword" type="password" minLength={12} autoComplete="new-password" required disabled={pending} onChange={event=>setPasswordLength(event.target.value.length)} aria-describedby="new-password-guidance" /></label><div className={`nz-password-meter ${passwordLength>=12?"ready":""}`} id="new-password-guidance"><span><i style={{width:`${Math.min(100,passwordLength/12*100)}%`}}/></span><small>{passwordLength>=12?"Minimum length met — use a unique password.":`${passwordLength} of 12 characters minimum`}</small></div><label className="nz-fl">Confirm new password<input className="nz-inp" name="confirmation" type="password" minLength={12} autoComplete="new-password" required disabled={pending} /></label>{notice && <div className={`nz-banner ${notice.ok ? "ok" : "warn"}`} role={notice.ok?"status":"alert"}>{notice.message}</div>}<button className="nz-btn pri nz-auth-submit" disabled={pending}>{pending ? "Changing…" : "Change password securely"}</button></form>
    </section>
  </main>;
}
