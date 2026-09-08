"use client";

// P2b (Portal Phase 2 security precondition) — terms-of-access gate. Live
// re-checks `must_accept_tac` on every shell load; this does the same by
// re-reading /api/portal/auth/me on mount and on tab refocus. The authoritative
// block is server-side (every portal DATA route 403s PORTAL_TERMS_REQUIRED
// until an acceptance row for the current version exists) — this is the UX that
// lets the client clear it. Inert when there is no session (401 on /me).
import { useCallback, useEffect, useState } from "react";
import { Drawer } from "@nzi/ui";
import { PORTAL_TERMS, PORTAL_TERMS_HEADING } from "./portalTermsContent";

type Status = { mustAccept: boolean; version: string };

export function PortalTermsGate() {
  const [status, setStatus] = useState<Status | null>(null);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const check = useCallback(async () => {
    try {
      const response = await fetch("/api/portal/auth/me", { cache: "no-store" });
      if (!response.ok) { setStatus(null); return; }
      const body = (await response.json()) as { mustAcceptTerms?: unknown; termsVersion?: unknown };
      setStatus({
        mustAccept: body.mustAcceptTerms === true,
        version: typeof body.termsVersion === "string" ? body.termsVersion : "",
      });
    } catch { setStatus(null); }
  }, []);

  useEffect(() => {
    void check();
    const onVisible = () => { if (document.visibilityState === "visible") void check(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [check]);

  const accept = useCallback(async () => {
    if (busy || !checked || !status) return;
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/portal/auth/accept-terms", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: status.version }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { message?: string };
        setError(body.message ?? "Your acceptance could not be recorded. Try again.");
        return;
      }
      window.location.reload();
    } catch {
      setError("Your acceptance could not be recorded. Check your connection and try again.");
    } finally { setBusy(false); }
  }, [busy, checked, status]);

  const decline = useCallback(async () => {
    try { await fetch("/api/portal/auth/logout", { method: "POST" }); } catch { /* sign out locally regardless */ }
    window.location.assign("/portal/login?reason=terms-declined");
  }, []);

  if (!status?.mustAccept) return null;
  return (
    <Drawer open onClose={() => undefined} ariaLabel="Portal terms of access" className="nz-portal-terms">
      <div className="nz-portal-terms-card">
        <div className="nz-portal-terms-head">
          <span className="nz-eyebrow">Client portal</span>
          <h2 id="nz-portal-terms-h">Before you continue</h2>
          <p>Please read and accept the portal terms of access to reach your reporting workspace.</p>
        </div>
        <div className="nz-portal-terms-body" tabIndex={0} aria-label="Terms of access">
          <h3>{PORTAL_TERMS_HEADING} <span className="muted">· Version {status.version}</span></h3>
          {PORTAL_TERMS.map((clause) => (
            <div key={clause.title}><b>{clause.title}</b><p>{clause.body}</p></div>
          ))}
        </div>
        <label className="nz-portal-terms-accept">
          <input type="checkbox" checked={checked} onChange={(event) => setChecked(event.target.checked)} />
          <span>I have read and agree to the client portal terms of access.</span>
        </label>
        {error ? <div className="nz-banner warn" role="alert">{error}</div> : null}
        <div className="nz-portal-terms-actions">
          <button type="button" className="nz-btn" onClick={() => void decline()}>Decline &amp; sign out</button>
          <button type="button" className="nz-btn pri" disabled={!checked || busy} onClick={() => void accept()}>{busy ? "Saving…" : "Accept & continue"}</button>
        </div>
      </div>
    </Drawer>
  );
}
