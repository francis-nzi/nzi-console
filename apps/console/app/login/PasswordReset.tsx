"use client";

import { FormEvent, useEffect, useState } from "react";

/**
 * Forgot password and set a new one (email programme phase 4-1), for both sign-ins: the staff console and the client
 * portal pass their own endpoints and sign-in page. The request form says the same thing whatever the address — it is
 * told nothing else — and the reset form reads its token from the URL fragment once, then removes it from the address bar.
 */

type Realm = { requestEndpoint: string; completeEndpoint: string; signInHref: string; forgotHref: string; accountNoun: string };
/** A link dressed as the card's primary button: centred, as the `<button>` it stands beside would be. */
const LINK_BUTTON = { display: "flex", alignItems: "center", justifyContent: "center", textDecoration: "none" } as const;

export function ForgotPasswordForm({ realm }: { realm: Realm }) {
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (pending) return; setError(""); setPending(true);
    try {
      const response = await fetch(realm.requestEndpoint, {
        method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store",
        body: JSON.stringify({ email: new FormData(event.currentTarget).get("email") }),
      });
      const body = await response.json().catch(() => ({}));
      if (response.status !== 202 || body.requested !== true) { setError(body.message ?? "Password reset is not available just now. Try again shortly."); return; }
      setSent(body.message);
    } catch { setError("The reset service could not be reached. Try again shortly."); }
    finally { setPending(false); }
  }

  if (sent) return <section className="nz-auth-card" role="status">
    <span className="nz-eyebrow">Check your email</span>
    <h1>Look for the reset link</h1>
    <p>{sent}</p>
    <p className="sub">Nothing arrived? Check the address you typed and your junk folder, then ask again. Your password is unchanged until you use the link.</p>
    <a className="nz-btn pri nz-auth-submit" href={realm.signInHref} style={LINK_BUTTON}>Back to sign in</a>
  </section>;

  return <form onSubmit={submit} className="nz-auth-card" aria-busy={pending}>
    <span className="nz-eyebrow">Forgotten password</span>
    <h1>Reset your password</h1>
    <p>Enter the email address you sign in with. If it has {realm.accountNoun}, we will email it a link to choose a new password. Your authenticator is not changed.</p>
    <label className="nz-fl">Email<input className="nz-inp" name="email" type="email" autoComplete="username" required disabled={pending} autoFocus /></label>
    {error ? <div className="nz-banner warn" role="alert" style={{ marginTop: 14 }}>{error}</div> : null}
    <button className="nz-btn pri nz-auth-submit" disabled={pending}>{pending ? "Sending…" : "Email me a reset link"}</button>
    <a className="nz-auth-secondary" href={realm.signInHref}>Back to sign in</a>
  </form>;
}

/** Reads the token from the fragment once, then removes it from the address bar and the history entry. */
function takeTokenFromFragment(): string {
  const token = new URLSearchParams(window.location.hash.replace(/^#/, "")).get("token") ?? "";
  if (window.location.hash) window.history.replaceState(null, "", window.location.pathname);
  return token;
}

export function ResetPasswordForm({ realm }: { realm: Realm }) {
  const [token, setToken] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [length, setLength] = useState(0);
  useEffect(() => { setToken(takeTokenFromFragment()); }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (pending || !token) return; setError("");
    const form = new FormData(event.currentTarget);
    if (form.get("password") !== form.get("confirmPassword")) { setError("The two passwords do not match."); return; }
    setPending(true);
    try {
      const response = await fetch(realm.completeEndpoint, {
        method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store",
        body: JSON.stringify({ token, password: form.get("password") }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.reset !== true) { setError(body.message ?? "The password could not be reset."); return; }
      setDone(true);
    } catch { setError("The reset service could not confirm the outcome. Try signing in with the new password before trying again."); }
    finally { setPending(false); }
  }

  if (done) return <section className="nz-auth-card" role="status">
    <span className="nz-eyebrow">Password reset</span>
    <h1>Your new password is set</h1>
    <p>Every session that was signed in to this account has been signed out. Sign in with your new password and your authenticator code.</p>
    <a className="nz-btn pri nz-auth-submit" href={realm.signInHref} style={LINK_BUTTON}>Sign in</a>
  </section>;

  return <form onSubmit={submit} className="nz-auth-card" aria-busy={pending}>
    <span className="nz-eyebrow">Password reset</span>
    <h1>Choose a new password</h1>
    {token === "" ? <div className="nz-banner warn" role="alert">This reset link is incomplete. <a href={realm.forgotHref}>Request a new one</a>.</div> : <>
      <p>Use a password you do not use anywhere else. Your authenticator stays as it is.</p>
      <label className="nz-fl">New password<input className="nz-inp" name="password" type="password" minLength={12} maxLength={256} autoComplete="new-password" required disabled={pending || token === null} onChange={(event) => setLength(event.target.value.length)} aria-describedby="reset-password-rule" autoFocus /></label>
      <label className="nz-fl">Confirm password<input className="nz-inp" name="confirmPassword" type="password" minLength={12} maxLength={256} autoComplete="new-password" required disabled={pending || token === null} /></label>
      <div className={`nz-password-rule ${length >= 12 ? "ready" : ""}`} id="reset-password-rule"><i>{length >= 12 ? "✓" : "·"}</i> {length >= 12 ? "Minimum length met." : `${length} of 12 characters minimum`}</div>
    </>}
    {error ? <div className="nz-banner warn" role="alert" style={{ marginTop: 14 }}>{error}{/expired|invalid/i.test(error) ? <> <a href={realm.forgotHref}>Request a new link</a>.</> : null}</div> : null}
    <button className="nz-btn pri nz-auth-submit" disabled={pending || !token}>{pending ? "Saving…" : "Set new password"}</button>
    <small className="nz-invite-privacy">Reset links are single-use and expire after an hour. Setting a new password signs this account out everywhere.</small>
  </form>;
}

export const STAFF_RESET: Realm = { requestEndpoint: "/api/auth/password-reset/request", completeEndpoint: "/api/auth/password-reset/complete", signInHref: "/login", forgotHref: "/forgot-password", accountNoun: "a staff account" };
export const PORTAL_RESET: Realm = { requestEndpoint: "/api/portal/auth/password-reset/request", completeEndpoint: "/api/portal/auth/password-reset/complete", signInHref: "/portal/login", forgotHref: "/portal/forgot-password", accountNoun: "a client portal account" };
