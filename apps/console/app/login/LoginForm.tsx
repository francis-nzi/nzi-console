"use client";
import { FormEvent, useState } from "react";

export function LoginForm() {
  const [challenge, setChallenge] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setPending(true); setError("");
    const form = new FormData(event.currentTarget);
    const response = await fetch(challenge ? "/api/auth/mfa" : "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(challenge ? { challengeToken: challenge, code: form.get("code") } : { email: form.get("email"), password: form.get("password") }) });
    const body = await response.json(); setPending(false);
    if (!response.ok) { setError(body.message ?? "Sign-in failed."); return; }
    if (challenge) { window.location.assign("/"); return; }
    setChallenge(body.challengeToken);
  }
  return <form onSubmit={submit} className="nz-auth-card">
    <div className="nz-eyebrow">Secure staff workspace</div><h1>Staff sign in</h1>
    <p>{challenge ? "Enter the six-digit code from your authenticator app." : "Use your independent NZI staff account."}</p>
    {challenge ? <label className="nz-fl">MFA code<input className="nz-inp num" name="code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="one-time-code" required autoFocus /></label> : <><label className="nz-fl">Email<input className="nz-inp" name="email" type="email" autoComplete="username" required autoFocus /></label><label className="nz-fl">Password<input className="nz-inp" name="password" type="password" autoComplete="current-password" required /></label></>}
    {error ? <div className="nz-banner warn" role="alert" style={{ marginTop: 14 }}>{error}</div> : null}
    <button className="nz-btn pri nz-auth-submit" disabled={pending}>{pending ? "Checking…" : challenge ? "Verify and continue" : "Continue securely"}</button>
    <div className="nz-auth-help">Access problems? Contact your NZI platform administrator.</div>
  </form>;
}
