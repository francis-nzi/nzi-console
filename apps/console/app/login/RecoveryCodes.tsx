"use client";

import { FormEvent, useEffect, useState } from "react";

/**
 * The sign-in's MFA step (4-2): the authenticator's six digits, or — asked for — one recovery code. The server tells them
 * apart; this only changes what the field invites and accepts.
 */
export function MfaCodeField({ pending, recovery, onToggle }: { pending: boolean; recovery: boolean; onToggle: () => void }) {
  return <>
    {recovery
      ? <label className="nz-fl">Recovery code<input key="recovery" className="nz-inp num" name="code" autoComplete="off" autoCapitalize="characters" spellCheck={false} pattern="[A-Za-z0-9 \-]{10,13}" maxLength={13} placeholder="ABCDE-FGHJK" required disabled={pending} autoFocus /></label>
      : <label className="nz-fl">MFA code<input key="totp" className="nz-inp num" name="code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="one-time-code" required disabled={pending} autoFocus /></label>}
    <button type="button" className="nz-auth-secondary" disabled={pending} onClick={onToggle}>{recovery ? "Use your authenticator code" : "Lost your authenticator? Use a recovery code"}</button>
  </>;
}

/**
 * The account page's recovery codes (4-2): how many are left, and a new set — proved with the authenticator, since a session
 * alone is not proof of who holds it. People who enrolled before 4-2 start with none, and make their first set here.
 */
export function AccountRecoveryCodes({ endpoint }: { endpoint: string }) {
  const [remaining, setRemaining] = useState<number | null | "failed">(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  useEffect(() => {
    let live = true;
    fetch(endpoint, { cache: "no-store" }).then(async (response) => {
      const body = await response.json().catch(() => ({}));
      if (live) setRemaining(response.ok && typeof body.remaining === "number" ? body.remaining : "failed");
    }).catch(() => { if (live) setRemaining("failed"); });
    return () => { live = false; };
  }, [endpoint]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (pending) return; setError(""); setPending(true);
    try {
      const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store", body: JSON.stringify({ code: new FormData(event.currentTarget).get("code") }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !Array.isArray(body.recoveryCodes)) { setError(body.message ?? "New recovery codes could not be made."); return; }
      setCodes(body.recoveryCodes); setRemaining(body.recoveryCodes.length);
    } catch { setError("The recovery-code service could not confirm the outcome. Your earlier codes may no longer work — try again."); }
    finally { setPending(false); }
  }

  return <section className="nz-account-card" aria-labelledby="account-recovery-title">
    <span className="nz-eyebrow">Authenticator recovery</span>
    <h2 id="account-recovery-title">Recovery codes</h2>
    <p>{remaining === null ? "Checking your recovery codes…"
      : remaining === "failed" ? "Your recovery codes could not be checked just now — this is not the same as having none."
      : remaining === 0 ? "You have no unused recovery codes. Make a set now, so a lost authenticator does not lock you out."
      : `You have ${remaining} unused recovery code${remaining === 1 ? "" : "s"}. Each signs you in once if your authenticator is lost.`}</p>
    {codes ? <RecoveryCodesPanel codes={codes} /> : <form onSubmit={submit}>
      <label className="nz-fl">Authenticator code<input className="nz-inp num" name="code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="one-time-code" required disabled={pending} /></label>
      {error ? <div className="nz-banner warn" role="alert">{error}</div> : null}
      <button className="nz-btn pri" disabled={pending}>{pending ? "Making codes…" : remaining === 0 ? "Make recovery codes" : "Make a new set"}</button>
      <small className="nz-invite-privacy">A new set replaces any unused codes you hold now.</small>
    </form>}
  </section>;
}

/** After a recovery code stood in for the authenticator: how many are left, and the way to a new set. */
export function RecoveredNotice({ remaining, accountHref, continueHref, low }: { remaining: number; accountHref: string; continueHref: string; low: number }) {
  return <section className="nz-auth-card" role="status">
    <span className="nz-eyebrow">Signed in with a recovery code</span>
    <h1>{remaining === 0 ? "That was your last recovery code" : `${remaining} recovery code${remaining === 1 ? "" : "s"} left`}</h1>
    <p>{remaining <= low ? "You are running low. " : ""}Generate a new set on your account page — it needs your authenticator. If your authenticator is lost, ask for it to be replaced before your codes run out.</p>
    <a className="nz-btn pri nz-auth-submit" href={accountHref} style={{ display: "flex", alignItems: "center", justifyContent: "center", textDecoration: "none" }}>Go to your account</a>
    <a className="nz-auth-secondary" href={continueHref}>Continue</a>
  </section>;
}

/**
 * MFA recovery codes, shown once (email programme phase 4-2, R7): at the end of staff enrolment, the portal accept page, and
 * when a signed-in person generates a new set. The codes exist only in this browser now — the server keeps their hashes —
 * so the panel asks the person to keep them before it lets them go on.
 */
export function RecoveryCodesPanel({ codes, continueHref, continueLabel }: { codes: string[]; continueHref?: string; continueLabel?: string }) {
  const [kept, setKept] = useState(false);
  const [copied, setCopied] = useState(false);
  const [problem, setProblem] = useState("");
  const text = `NZ Insights Pro — MFA recovery codes\nEach works once, in place of an authenticator code.\n\n${codes.join("\n")}\n`;

  async function copy() {
    try { await navigator.clipboard.writeText(text); setCopied(true); } catch { setProblem("The codes could not be copied automatically. Select them and copy them by hand."); }
  }
  function download() {
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const anchor = document.createElement("a");
    anchor.href = url; anchor.download = "nz-insights-pro-recovery-codes.txt"; anchor.click();
    URL.revokeObjectURL(url);
  }

  return <section className="nz-recovery-codes" aria-labelledby="recovery-codes-title">
    <span className="nz-eyebrow">Recovery codes</span>
    <h3 id="recovery-codes-title">Keep these somewhere safe</h3>
    <p>If you lose your authenticator, each code signs you in once in its place. They are shown <b>only now</b> — nobody at NZI can see them again.</p>
    <ol className="nz-recovery-code-list num">{codes.map((code) => <li key={code}>{code}</li>)}</ol>
    <div className="nz-recovery-code-actions">
      <button type="button" className="nz-btn" onClick={() => void copy()}>{copied ? "Copied" : "Copy codes"}</button>
      <button type="button" className="nz-btn" onClick={download}>Download as text</button>
    </div>
    {problem ? <div className="nz-banner warn" role="alert">{problem}</div> : null}
    <label className="nz-recovery-kept"><input type="checkbox" checked={kept} onChange={(event) => setKept(event.target.checked)} /> I have saved these codes somewhere safe</label>
    {continueHref ? <a className={`nz-btn pri nz-auth-submit${kept ? "" : " is-disabled"}`} aria-disabled={!kept} href={kept ? continueHref : undefined}
      style={{ display: "flex", alignItems: "center", justifyContent: "center", textDecoration: "none", pointerEvents: kept ? undefined : "none", opacity: kept ? 1 : 0.55 }}>{continueLabel ?? "Sign in"}</a> : null}
  </section>;
}
