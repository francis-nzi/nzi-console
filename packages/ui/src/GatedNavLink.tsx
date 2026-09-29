"use client";

import { useEffect, useState, type ReactNode } from "react";

/**
 * A rail link shown only to someone who holds a capability in a family (e.g. any `admin.*`).
 *
 * The rail is rendered on every page, most of them server-side with no principal to hand, so the check happens here:
 * one `GET /api/auth/me` (shared across every gated link on the page), the same capability set the command layer
 * enforces. **It fails closed** — nothing shows while checking, on a signed-out response or on any error. This is a
 * convenience, not the boundary: the page it links to authorises the request itself.
 */
let meCapabilities: Promise<string[]> | null = null;
function loadCapabilities(meUrl: string): Promise<string[]> {
  meCapabilities ??= fetch(meUrl, { cache: "no-store", credentials: "same-origin" })
    .then(async (response) => {
      if (!response.ok) return [];
      const me = await response.json() as { capabilities?: Array<{ capability?: unknown }> };
      return Array.isArray(me.capabilities) ? me.capabilities.map((grant) => String(grant.capability ?? "")) : [];
    })
    .catch(() => []);
  return meCapabilities;
}

export function GatedNavLink({ capabilityPrefix, meUrl = "/api/auth/me", children }: { capabilityPrefix: string; meUrl?: string; children: ReactNode }) {
  const [allowed, setAllowed] = useState(false);
  useEffect(() => {
    let live = true;
    loadCapabilities(meUrl).then((capabilities) => { if (live) setAllowed(capabilities.some((capability) => capability.startsWith(capabilityPrefix))); });
    return () => { live = false; };
  }, [capabilityPrefix, meUrl]);
  return allowed ? <>{children}</> : null;
}
