"use client";

// P1 (Portal Phase 2 security precondition) — client-side half of idle
// auto-logout. The authoritative enforcement is server-side
// (`resolvePortalPrincipal` rejects a session whose `last_seen_at` is stale, so
// a closed laptop still self-heals within the window). This component adds the
// UX: activity slides the window, a countdown dialog warns before the cut, and
// on timeout it ends the session server-side (revoke) and returns to /login —
// so an open tab doesn't sit "signed in" and doesn't rely on the token's 8h TTL.
import { useCallback, useEffect, useRef, useState } from "react";
import { Drawer } from "@nzi/ui";

const ACTIVITY_EVENTS = ["mousemove", "keydown", "pointerdown", "scroll", "touchstart"] as const;
const WARNING_SECONDS = 120; // countdown dialog shows this long before the cut
const PING_THROTTLE_MS = 60_000; // at most one /me activity ping per minute
const DEFAULT_IDLE_MINUTES = 30;

export function PortalInactivityGuard() {
  const [armed, setArmed] = useState(false);
  const [idleMs, setIdleMs] = useState(DEFAULT_IDLE_MINUTES * 60_000);
  const [warnLeft, setWarnLeft] = useState<number | null>(null);
  const lastActivity = useRef(Date.now());
  const lastPing = useRef(0);
  const loggingOut = useRef(false);

  // Arm only when there is a live session — on /portal/login `/me` 401s and the
  // guard stays inert (no redirect loop).
  useEffect(() => {
    let cancelled = false;
    fetch("/api/portal/auth/me", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { idleLimitMinutes?: unknown } | null) => {
        if (cancelled || !body) return;
        const minutes = typeof body.idleLimitMinutes === "number" && body.idleLimitMinutes > 0 ? body.idleLimitMinutes : DEFAULT_IDLE_MINUTES;
        setIdleMs(minutes * 60_000);
        lastActivity.current = Date.now();
        setArmed(true);
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  const logout = useCallback(async () => {
    if (loggingOut.current) return;
    loggingOut.current = true;
    try { await fetch("/api/portal/auth/logout", { method: "POST" }); } catch { /* end locally regardless */ }
    window.location.assign("/portal/login?reason=idle");
  }, []);

  const stayIn = useCallback(() => {
    lastActivity.current = Date.now();
    lastPing.current = Date.now();
    setWarnLeft(null);
    void fetch("/api/portal/auth/me", { cache: "no-store" }).catch(() => undefined); // slide the server window
  }, []);

  useEffect(() => {
    if (!armed) return;
    const markActive = () => {
      lastActivity.current = Date.now();
      if (Date.now() - lastPing.current > PING_THROTTLE_MS) {
        lastPing.current = Date.now();
        void fetch("/api/portal/auth/me", { cache: "no-store" }).catch(() => undefined);
      }
    };
    ACTIVITY_EVENTS.forEach((evt) => window.addEventListener(evt, markActive, { passive: true }));
    const tick = setInterval(() => {
      const remaining = idleMs - (Date.now() - lastActivity.current);
      if (remaining <= 0) { void logout(); return; }
      setWarnLeft(remaining <= WARNING_SECONDS * 1000 ? Math.ceil(remaining / 1000) : null);
    }, 1000);
    return () => {
      ACTIVITY_EVENTS.forEach((evt) => window.removeEventListener(evt, markActive));
      clearInterval(tick);
    };
  }, [armed, idleMs, logout]);

  if (!armed || warnLeft === null) return null;
  const mm = Math.floor(warnLeft / 60);
  const ss = String(warnLeft % 60).padStart(2, "0");
  return (
    <Drawer open onClose={stayIn} ariaLabel="Session about to end" className="nz-portal-idle">
      <div className="nz-portal-idle-card" role="alertdialog" aria-labelledby="nz-portal-idle-h" aria-describedby="nz-portal-idle-d">
        <h2 id="nz-portal-idle-h">Still there?</h2>
        <p id="nz-portal-idle-d">For your security you&rsquo;ll be signed out after {Math.round(idleMs / 60_000)} minutes of inactivity. You have <b>{mm}:{ss}</b> left.</p>
        <div className="nz-portal-idle-actions">
          <button type="button" className="nz-btn" onClick={() => void logout()}>Sign out now</button>
          <button type="button" className="nz-btn pri" onClick={stayIn} autoFocus>Stay signed in</button>
        </div>
      </div>
    </Drawer>
  );
}
