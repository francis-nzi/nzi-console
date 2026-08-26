"use client";

import { FormEvent, useState } from "react";

export function PortalAccount() {
  const [notice, setNotice] = useState<{ message: string; ok: boolean } | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setPending(true); setNotice(null);
    const form = new FormData(event.currentTarget), newPassword = String(form.get("newPassword") ?? ""), confirmation = String(form.get("confirmation") ?? "");
    if (newPassword !== confirmation) { setPending(false); setNotice({ message: "New password confirmation does not match.", ok: false }); return; }
    const response = await fetch("/api/portal/auth/password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ currentPassword: form.get("currentPassword"), newPassword }) });
    const body = await response.json(); setPending(false);
    setNotice({ message: response.ok ? "Password changed. Other portal sessions have been signed out." : body.message ?? "Password change failed.", ok: response.ok });
    if (response.ok) event.currentTarget.reset();
  }

  return <main className="nz-account-shell">
    <header className="nz-account-header"><a href="/portal" className="nz-portal-brand"><span>N</span><div><b>NZI Pro</b><small>Client portal</small></div></a><a href="/portal" className="nz-btn">Back to reporting jobs</a></header>
    <section className="nz-account-layout">
      <aside className="nz-account-brief"><span className="nz-eyebrow light">Account protection</span><h1>Keep your reporting workspace secure.</h1><p>A strong, unique password protects published reports, review conversations and client-supplied data.</p><div className="nz-account-trust"><span><i>✓</i> Minimum 12 characters</span><span><i>✓</i> MFA remains active</span><span><i>✓</i> Other sessions revoked</span></div></aside>
      <form onSubmit={submit} className="nz-account-card"><span className="nz-eyebrow">Client portal security</span><h2>Change password</h2><p>Confirm your current password, then choose a new password used only for NZI Pro.</p><label className="nz-fl">Current password<input className="nz-inp" name="currentPassword" type="password" autoComplete="current-password" required /></label><div className="nz-account-divider"/><label className="nz-fl">New password<input className="nz-inp" name="newPassword" type="password" minLength={12} autoComplete="new-password" required /></label><label className="nz-fl">Confirm new password<input className="nz-inp" name="confirmation" type="password" minLength={12} autoComplete="new-password" required /></label>{notice && <div className={`nz-banner ${notice.ok ? "ok" : "warn"}`} role="status">{notice.message}</div>}<button className="nz-btn pri nz-auth-submit" disabled={pending}>{pending ? "Changing…" : "Change password securely"}</button></form>
    </section>
  </main>;
}
