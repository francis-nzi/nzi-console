"use client";

import { useEffect, useState } from "react";

/**
 * Whether the signed-in staff member may run a command gated on `permission` —
 * resolved from /api/auth/me so a mutation is blocked with its reason up front
 * rather than failing after the click. The server still enforces it (NZC-022).
 */
export type EditAccess =
  | { state: "checking"; reason: string }
  | { state: "allowed" }
  | { state: "denied"; reason: string }
  | { state: "unavailable"; reason: string };

const UNCHECKED = "Your permissions could not be checked, so editing is unavailable.";

export function useEditAccess(permission: string, writeEnabled: boolean): EditAccess {
  const [access, setAccess] = useState<EditAccess>(writeEnabled
    ? { state: "checking", reason: "Checking your permissions…" }
    : { state: "unavailable", reason: "Editing is switched off in this environment." });

  useEffect(() => {
    if (!writeEnabled) return;
    let live = true;
    fetch("/api/auth/me", { cache: "no-store", credentials: "same-origin" })
      .then(async (response) => {
        if (!live) return;
        if (response.status === 401) { setAccess({ state: "denied", reason: "Sign in as staff to make changes." }); return; }
        if (!response.ok) { setAccess({ state: "unavailable", reason: UNCHECKED }); return; }
        const me = await response.json() as { permissions?: string[] };
        if (!live) return;
        setAccess(me.permissions?.includes(permission) ? { state: "allowed" } : { state: "denied", reason: "Your role does not include permission to change emissions data." });
      })
      .catch(() => { if (live) setAccess({ state: "unavailable", reason: UNCHECKED }); });
    return () => { live = false; };
  }, [permission, writeEnabled]);

  return access;
}
