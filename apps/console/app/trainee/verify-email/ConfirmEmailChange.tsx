"use client";

import { useState } from "react";

/**
 * Confirming an email change. Every existing session is revoked as the address switches —
 * including this one — so the change takes effect everywhere at once rather than leaving a
 * signed-in tab on the old identity.
 */
export function ConfirmEmailChange({ token }: { token: string }) {
  const [state, setState] = useState<{ kind: "ready" } | { kind: "pending" } | { kind: "done"; email: string } | { kind: "failed"; message: string }>(
    token.trim() ? { kind: "ready" } : { kind: "failed", message: "This link is missing its verification code. Request the change again from My details." },
  );

  if (state.kind === "done") {
    return <div className="nz-auth-card">
      <h1>Email confirmed</h1>
      <p>Your sign-in address is now <b>{state.email}</b>. You have been signed out everywhere, so sign in again with the new address.</p>
      <a className="nz-btn pri nz-auth-submit" href="/trainee/login?reason=email-changed">Sign in</a>
    </div>;
  }

  return <div className="nz-auth-card">
    <h1>Confirm your new email</h1>
    <p>Confirming switches your sign-in address. Your training record, your certificates and who arranged them are untouched.</p>
    {state.kind === "failed" ? <div className="nz-banner warn" role="alert" style={{ marginTop: 14 }}>{state.message}</div> : null}
    <button className="nz-btn pri nz-auth-submit" disabled={state.kind === "pending" || !token.trim()} onClick={async () => {
      setState({ kind: "pending" });
      try {
        const response = await fetch("/api/trainee/email-change", {
          method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }),
        });
        const body = await response.json() as { message?: string; email?: string };
        if (!response.ok || typeof body.email !== "string") {
          setState({ kind: "failed", message: body.message ?? "This verification link is no longer valid." });
          return;
        }
        setState({ kind: "done", email: body.email });
      } catch {
        setState({ kind: "failed", message: "The confirmation could not be completed. Please try again." });
      }
    }}>{state.kind === "pending" ? "Confirming…" : "Confirm this address"}</button>
  </div>;
}
