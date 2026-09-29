import "server-only";
import { cache } from "react";
import { headers } from "next/headers";
import type { CapabilityGrant } from "@nzi/contracts";
import { AuthDisabledError, AuthenticationError, currentStaff } from "../lib/staffSession";

/**
 * Who may open the admin section, decided on the server for every request — the rail's Admin link is only a
 * convenience (GatedNavLink); this is the boundary.
 *
 * Ruled P2: no new capability. The section opens to anyone holding any `admin.*` capability (Admin, today), and each
 * write will need its own specific capability. **It fails closed**: no data service, sign-in disabled, signed out, or
 * no admin capability each give a stated reason, never the section.
 */
export type AdminAccess =
  | { state: "allowed"; organisationId: string; userId: string; role: string; capabilities: readonly CapabilityGrant[] }
  | { state: "forbidden"; reason: string }
  | { state: "signed-out"; reason: string }
  | { state: "unavailable"; reason: string };

export const holdsAdmin = (capabilities: readonly CapabilityGrant[]) => capabilities.some((grant) => grant.capability.startsWith("admin."));
export const holds = (capabilities: readonly CapabilityGrant[], capability: string, scope?: string) =>
  capabilities.some((grant) => grant.capability === capability && (scope === undefined || grant.scope === scope));

/** Resolved once per request, however many server components ask. */
export const adminAccess = cache(async (): Promise<AdminAccess> => {
  if (process.env.NZI_DATA_MODE !== "isolated-api") {
    return { state: "unavailable", reason: "This environment runs on fixture data, with no database behind it, so there is no configuration to administer." };
  }
  try {
    const incoming = await headers();
    const base = (process.env.NZI_ISOLATED_API_URL ?? "http://localhost").replace(/\/$/, "");
    const principal = await currentStaff(new Request(`${base}/admin`, { headers: { cookie: incoming.get("cookie") ?? "" } }));
    if (!holdsAdmin(principal.capabilities)) {
      return { state: "forbidden", reason: "Your role does not include administration. Administration needs an admin capability (admin.lookups, admin.users, admin.settings or admin.templates)." };
    }
    return { state: "allowed", organisationId: principal.organisationId, userId: principal.userId, role: principal.role, capabilities: principal.capabilities };
  } catch (error) {
    if (error instanceof AuthDisabledError) return { state: "unavailable", reason: "Staff sign-in is disabled in this environment, so admin access cannot be checked — and admin is never opened without that check." };
    if (error instanceof AuthenticationError) return { state: "signed-out", reason: "Sign in to open administration." };
    // Anything else (the database, the session store) is a failure to check, not a verdict on the person.
    return { state: "unavailable", reason: "Admin access could not be checked just now, so administration is not shown. Try again shortly." };
  }
});
