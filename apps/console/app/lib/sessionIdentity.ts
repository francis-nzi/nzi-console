import "server-only";
import { cache } from "react";
import { headers } from "next/headers";
import { currentStaff } from "./staffSession";
import { identityFor, type SessionIdentity } from "./identity";

/**
 * The signed-in staff member, once per request (the layout and the Control Room both ask). Null when nobody is
 * signed in — the login page, the portal, the enrolment page, or staff sign-in switched off — and the rail says so.
 */
export const sessionIdentity = cache(async (): Promise<SessionIdentity | null> => {
  try {
    const cookie = (await headers()).get("cookie");
    if (!cookie) return null;
    const base = (process.env.NZI_ISOLATED_API_URL ?? "http://localhost").replace(/\/$/, "");
    return identityFor(await currentStaff(new Request(`${base}/`, { headers: { cookie } })));
  } catch {
    return null;
  }
});
