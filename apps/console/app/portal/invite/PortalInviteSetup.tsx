"use client";

import { FormEvent, useState } from "react";

type Setup = { email: string; displayName: string; totpSecret: string };

export function PortalInviteSetup({ token }: { token: string }) {
  const [setup, setSetup] = useState<Setup | null>(null);
  const [complete, setComplete] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [passwordLength, setPasswordLength] = useState(0);
  const [copied, setCopied] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (pending) return; setPending(true); setError("");
    const form = new FormData(event.currentTarget);
    try { const response = await fetch(setup ? "/api/portal/invitations/confirm" : "/api/portal/invitations/setup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(setup ? { token, code: form.get("code") } : { token, password: form.get("password") }) });
      const body = await response.json();
      if (!response.ok) { setError(body.message ?? "Account setup could not be completed."); return; }
      if (setup) { if(body.activated!==true)throw new Error();setComplete(true); return; }
      if(typeof body.setup?.email!=="string"||typeof body.setup?.displayName!=="string"||typeof body.setup?.totpSecret!=="string")throw new Error();
      setSetup(body.setup);
    } catch { setError("The secure enrolment service could not verify the outcome. Retry this step before attempting to sign in."); }
    finally { setPending(false); }
  }
  async function copySecret(){if(!setup)return;try{await navigator.clipboard.writeText(setup.totpSecret);setCopied(true)}catch{setError("The setup key could not be copied automatically. Select and copy it manually.")}}

  if (complete) return <section className="nz-invite-card complete"><div className="nz-invite-check">✓</div><span className="nz-eyebrow">Enrolment complete</span><h2>Account ready</h2><p>Your password and MFA are confirmed. Your authorised reporting workspace is ready.</p><a className="nz-btn pri nz-auth-submit" href="/portal/login">Sign in securely</a></section>;

  return <form onSubmit={submit} className="nz-invite-card" aria-busy={pending}>
    <div className="nz-invite-card-head"><span className="nz-eyebrow">{setup ? "Step 2 of 2" : "Step 1 of 2"}</span><span>{setup ? "Authenticator" : "Password"}</span></div>
    <h2>{setup ? "Protect your account" : "Create your account"}</h2>
    {!token ? <div className="nz-banner warn" role="alert">This setup link is incomplete. Request a new invitation from your NZI representative.</div> : setup ? <><p>Add this key to your authenticator app for <b>{setup.email}</b>, then enter the six-digit code.</p><div className="nz-setup-key"><span>Manual setup key</span><strong className="num">{setup.totpSecret}</strong><button type="button" onClick={copySecret}>{copied?"Copied":"Copy key"}</button></div><label className="nz-fl">Authenticator code<input className="nz-inp num" name="code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="one-time-code" required disabled={pending} autoFocus /></label></> : <><p>Choose a unique password for the client portal. You will connect your authenticator next.</p><label className="nz-fl">New password<input className="nz-inp" name="password" type="password" minLength={12} autoComplete="new-password" required disabled={pending} onChange={event=>setPasswordLength(event.target.value.length)} aria-describedby="invite-password-rule" autoFocus /></label><div className={`nz-password-rule ${passwordLength>=12?"ready":""}`} id="invite-password-rule"><i>{passwordLength>=12?"✓":"·"}</i> {passwordLength>=12?"Minimum length met — use a unique password.":`${passwordLength} of 12 characters minimum`}</div></>}
    {error ? <div className="nz-banner warn" role="alert">{error}</div> : null}
    <button className="nz-btn pri nz-auth-submit" disabled={pending || !token}>{pending ? "Saving…" : setup ? "Verify and activate" : "Continue to MFA"}</button>
    <small className="nz-invite-privacy">Invitation tokens are single-use and expire automatically.</small>
  </form>;
}
