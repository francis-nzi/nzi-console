"use client";

import { type FormEvent, useState } from "react";

/**
 * Trainee sign-in. Two steps, like every other realm on the platform.
 *
 * The copy is written for a person rather than an account holder: this is their own record,
 * signed into with their own email, and it stays theirs when they change jobs. There is no
 * "contact your administrator" here — there is no administrator over a person's own record.
 */
export function TraineeLoginForm() {
  const [challenge, setChallenge] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true); setError("");
    try {
      const form = new FormData(event.currentTarget);
      const response = await fetch(challenge ? "/api/trainee/auth/mfa" : "/api/trainee/auth/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(challenge ? { challengeToken: challenge, code: form.get("code") } : { email: form.get("email"), password: form.get("password") }),
      });
      const body = await response.json() as { message?: string; authenticated?: boolean; mfaRequired?: boolean; challengeToken?: string };
      if (!response.ok) { setError(body.message ?? "Sign-in failed."); return; }
      if (challenge) {
        if (body.authenticated !== true) throw new Error();
        window.location.assign("/trainee");
        return;
      }
      if (body.mfaRequired !== true || typeof body.challengeToken !== "string" || !body.challengeToken.trim()) throw new Error();
      setChallenge(body.challengeToken);
    } catch {
      setError("Sign-in could not confirm the outcome. Please retry the current step.");
    } finally {
      setPending(false);
    }
  }

  return <form onSubmit={submit} className="nz-auth-card">
    <div className="nz-auth-step"><span className="nz-eyebrow">Your training record</span><span>Step {challenge ? "2" : "1"} of 2</span></div>
    <h1>{challenge ? "Verify it's you" : "Trainee sign in"}</h1>
    <p>{challenge
      ? "Your password was accepted. Enter the six-digit code from your authenticator app."
      : "Sign in with the personal email address you enrolled with — not a work address, so your record stays yours if you change jobs."}</p>
    <div className="nz-auth-progress" aria-hidden="true"><i className="done" /><i className={challenge ? "done" : ""} /></div>
    {challenge
      ? <label className="nz-fl">Six-digit code<input className="nz-inp num" name="code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="one-time-code" required disabled={pending} autoFocus /></label>
      : <>
        <label className="nz-fl">Personal email<input className="nz-inp" name="email" type="email" autoComplete="username" required disabled={pending} autoFocus /></label>
        <label className="nz-fl">Password<input className="nz-inp" name="password" type="password" autoComplete="current-password" required disabled={pending} /></label>
      </>}
    {error ? <div className="nz-banner warn" role="alert" style={{ marginTop: 14 }}>{error}</div> : null}
    <button className="nz-btn pri nz-auth-submit" disabled={pending}>{pending ? "Checking…" : challenge ? "Verify and continue" : "Continue"}</button>
    {challenge ? <button type="button" className="nz-auth-secondary" disabled={pending} onClick={() => { setChallenge(""); setError(""); }}>Use a different email</button> : null}
    <div className="nz-auth-support">
      <b>{challenge ? "Authenticator unavailable?" : "Changed your email address?"}</b>
      <span>{challenge
        ? "Contact the NZI training team and they will help you back in."
        : "Sign in with the address you last confirmed, then change it under My details — the new one becomes your sign-in once you verify it."}</span>
    </div>
  </form>;
}
