"use client";

import { useEffect, useState } from "react";
import type { Capability, CapabilityGrant, StaffRole } from "@nzi/contracts";

/**
 * Whether the signed-in staff member may exercise `capability` — resolved from
 * /api/auth/me, which returns the same PERMISSION_MATRIX.md capabilities the command
 * layer enforces (NZC-022). A mutation is blocked with its reason up front rather
 * than failing after the click; the server check stays authoritative.
 */
export type EditAccess =
  | { state: "checking"; reason: string }
  | { state: "allowed" }
  | { state: "denied"; reason: string }
  | { state: "unavailable"; reason: string };

export type StaffMe = { userId: string; organisationId: string; role: StaffRole; matrixVersion: number; capabilities: CapabilityGrant[] };

const UNCHECKED = "Your permissions could not be checked, so editing is unavailable.";
const DENIED: Partial<Record<Capability, string>> = {
  "client.edit": "Your role does not include editing the client record.",
  "contact.manage": "Your role does not include managing contacts.",
  "site.manage": "Your role does not include managing sites.",
  "baseline.rebaseline": "Your role does not include re-baselining.",
  "snapshot.review": "Your role does not include approving snapshots.",
  "report.publish": "Your role does not include releasing reports.",
  "report.edit": "Your role does not include preparing reports.",
  "portal.admin": "Your role does not include portal administration.",
};

// One /api/auth/me per page load, shared by every control that asks.
let mePromise: Promise<StaffMe | "signed-out" | null> | null = null;
function loadMe(): Promise<StaffMe | "signed-out" | null> {
  mePromise ??= fetch("/api/auth/me", { cache: "no-store", credentials: "same-origin" })
    .then(async (response) => {
      if (response.status === 401) return "signed-out" as const;
      if (!response.ok) return null;
      const me = await response.json() as Partial<StaffMe>;
      return Array.isArray(me.capabilities) && typeof me.userId === "string" ? me as StaffMe : null;
    })
    .catch(() => null)
    .finally(() => { setTimeout(() => { mePromise = null; }, 30_000); });
  return mePromise;
}

/** `clientOwnerUserId` — for an own-clients capability, whose client this is. */
export function accessFor(me: StaffMe, capability: Capability, clientOwnerUserId?: string | null): EditAccess {
  const grant = me.capabilities.find((item) => item.capability === capability);
  if (!grant) return { state: "denied", reason: DENIED[capability] ?? "Your role does not include this change." };
  if (grant.scope === "own_clients" && clientOwnerUserId !== me.userId) return { state: "denied", reason: "Your role allows this on your own clients only." };
  return { state: "allowed" };
}

export function useStaffMe(enabled = true): StaffMe | "signed-out" | null | undefined {
  const [me, setMe] = useState<StaffMe | "signed-out" | null | undefined>(undefined);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void loadMe().then((value) => { if (live) setMe(value); });
    return () => { live = false; };
  }, [enabled]);
  return me;
}

export function useEditAccess(capability: Capability, writeEnabled: boolean, clientOwnerUserId?: string | null): EditAccess {
  const me = useStaffMe(writeEnabled);
  if (!writeEnabled) return { state: "unavailable", reason: "Editing is switched off in this environment." };
  if (me === undefined) return { state: "checking", reason: "Checking your permissions…" };
  if (me === "signed-out") return { state: "denied", reason: "Sign in as staff to make changes." };
  if (me === null) return { state: "unavailable", reason: UNCHECKED };
  return accessFor(me, capability, clientOwnerUserId);
}
