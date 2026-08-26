"use client";

import { FormEvent, useState } from "react";

type Setup = { email: string; displayName: string; totpSecret: string };

export function PortalInviteSetup({ token }: { token: string }) {
  const [setup, setSetup] = useState<Setup | null>(null);
  const [complete, setComplete] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setPending(true); setError("");
    const form = new FormData(event.currentTarget);
    const response = await fetch(setup ? "/api/portal/invitations/confirm" : "/api/portal/invitations/setup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(setup ? { token, code: form.get("code") } : { token, password: form.get("password") }) });
    const body = await response.json(); setPending(false);
    if (!response.ok) { setError(body.message ?? "Account setup could not be completed."); return; }
    if (setup) { setComplete(true); return; }
    setSetup(body.setup);
  }

  if (complete) return <section className="nz-invite-card complete"><div className="nz-invite-check">✓</div><span className="nz-eyebrow">Enrolment complete</span><h2>Account ready</h2><p>Your password and MFA are confirmed. Your authorised reporting workspace is ready.</p><a className="nz-btn pri nz-auth-submit" href="/portal/login">Sign in securely</a></section>;

  return <form onSubmit={submit} className="nz-invite-card">
    <div className="nz-invite-card-head"><span className="nz-eyebrow">{setup ? "Step 2 of 2" : "Step 1 of 2"}</span><span>{setup ? "Authenticator" : "Password"}</span></div>
    <h2>{setup ? "Protect your account" : "Create your account"}</h2>
    {!token ? <div className="nz-banner warn">This setup link is incomplete. Request a new invitation from your NZI representative.</div> : setup ? <><p>Add this key to your authenticator app for <b>{setup.email}</b>, then enter the six-digit code.</p><div className="nz-setup-key"><span>Manual setup key</span><strong className="num">{setup.totpSecret}</strong></div><label className="nz-fl">Authenticator code<input className="nz-inp num" name="code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="one-time-code" required autoFocus /></label></> : <><p>Choose a unique password for the client portal. You will connect your authenticator next.</p><label className="nz-fl">New password<input className="nz-inp" name="password" type="password" minLength={12} autoComplete="new-password" required autoFocus /></label><div className="nz-password-rule"><i>✓</i> At least 12 characters</div></>}
    {error ? <div className="nz-banner warn" role="alert">{error}</div> : null}
    <button className="nz-btn pri nz-auth-submit" disabled={pending || !token}>{pending ? "Saving…" : setup ? "Verify and activate" : "Continue to MFA"}</button>
    <small className="nz-invite-privacy">Invitation tokens are single-use and expire automatically.</small>
  </form>;
}
