"use client";

import { FormEvent, useEffect, useState } from "react";

type Setup = { email: string; displayName: string | null; totpSecret: string; otpauthUri: string };

/** Reads the token from the fragment once, then removes it from the address bar and the history entry. */
function takeTokenFromFragment(): string {
  const token = new URLSearchParams(window.location.hash.replace(/^#/, "")).get("token") ?? "";
  if (window.location.hash) window.history.replaceState(null, "", window.location.pathname);
  return token;
}

export function StaffEnrolment() {
  const [token, setToken] = useState<string | null>(null);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [complete, setComplete] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [passwordLength, setPasswordLength] = useState(0);
  const [copied, setCopied] = useState(false);

  useEffect(() => { setToken(takeTokenFromFragment()); }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (pending || !token) return; setError("");
    const form = new FormData(event.currentTarget);
    if (!setup && form.get("password") !== form.get("confirmPassword")) { setError("The two passwords do not match."); return; }
    setPending(true);
    try {
      const response = await fetch(setup ? "/api/auth/enrolment/confirm" : "/api/auth/enrolment/setup", {
        method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store",
        body: JSON.stringify(setup ? { token, code: form.get("code") } : { token, password: form.get("password") }),
      });
      const body = await response.json();
      if (!response.ok) { setError(body.message ?? "Enrolment could not be completed."); return; }
      if (setup) { if (body.enrolled !== true) throw new Error(); setComplete(true); return; }
      if (typeof body.setup?.email !== "string" || typeof body.setup?.totpSecret !== "string" || typeof body.setup?.otpauthUri !== "string") throw new Error();
      setSetup(body.setup);
    } catch { setError("The enrolment service could not confirm the outcome. Retry this step before trying to sign in."); }
    finally { setPending(false); }
  }
  async function copySecret() { if (!setup) return; try { await navigator.clipboard.writeText(setup.totpSecret); setCopied(true); } catch { setError("The key could not be copied automatically. Select and copy it manually."); } }

  if (complete) return <section className="nz-invite-card complete"><div className="nz-invite-check">✓</div><span className="nz-eyebrow">Enrolment complete</span><h2>Your sign-in is ready</h2><p>Your password and authenticator are confirmed. This link no longer works.</p><a className="nz-btn pri nz-auth-submit" href="/login">Sign in</a></section>;

  return <form onSubmit={submit} className="nz-invite-card" aria-busy={pending}>
    <div className="nz-invite-card-head"><span className="nz-eyebrow">{setup ? "Step 2 of 2" : "Step 1 of 2"}</span><span>{setup ? "Authenticator" : "Password"}</span></div>
    <h2>{setup ? "Connect your authenticator" : "Create your password"}</h2>
    {token === "" ? <div className="nz-banner warn" role="alert">This enrolment link is incomplete. Ask your administrator for a new one.</div>
      : setup ? <><p>Add this key to your authenticator app for <b>{setup.email}</b> — or <a href={setup.otpauthUri}>open it in your authenticator</a> on this device — then enter the six-digit code it shows.</p><div className="nz-setup-key"><span>Setup key</span><strong className="num">{setup.totpSecret}</strong><button type="button" onClick={copySecret}>{copied ? "Copied" : "Copy key"}</button></div><label key="code" className="nz-fl">Authenticator code<input className="nz-inp num" name="code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="one-time-code" required disabled={pending} autoFocus /></label></>
      : <><p>Choose a password for the staff console that you do not use anywhere else. You will connect your authenticator next.</p><label key="password" className="nz-fl">New password<input className="nz-inp" name="password" type="password" minLength={12} maxLength={256} autoComplete="new-password" required disabled={pending || token === null} onChange={(event) => setPasswordLength(event.target.value.length)} aria-describedby="enrol-password-rule" autoFocus /></label><label key="confirm-password" className="nz-fl">Confirm password<input className="nz-inp" name="confirmPassword" type="password" minLength={12} maxLength={256} autoComplete="new-password" required disabled={pending || token === null} /></label><div className={`nz-password-rule ${passwordLength >= 12 ? "ready" : ""}`} id="enrol-password-rule"><i>{passwordLength >= 12 ? "✓" : "·"}</i> {passwordLength >= 12 ? "Minimum length met." : `${passwordLength} of 12 characters minimum`}</div></>}
    {error ? <div className="nz-banner warn" role="alert">{error}</div> : null}
    <button className="nz-btn pri nz-auth-submit" disabled={pending || !token}>{pending ? "Saving…" : setup ? "Verify and finish" : "Continue to authenticator"}</button>
    <small className="nz-invite-privacy">Enrolment links are single-use and expire automatically. Five incorrect codes end this link.</small>
  </form>;
}
