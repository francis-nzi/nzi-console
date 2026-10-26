import "server-only";
import { completePasswordReset, PasswordResetError, requestPasswordReset, type ResetPrincipal } from "@nzi/isolated-backend";
import { authFailure, portalAuthFailure } from "./authResponse";
import { isolatedPool } from "./isolatedDatabase";
import { requirePortalAuthEnabled, requirePortalOrigin } from "./portalSession";
import { requireAuthEnabled, requireAuthOrigin } from "./staffSession";

/**
 * The forgot-password routes for both sign-ins (email programme phase 4-1). One shape, two gates: the staff routes sit behind
 * staff sign-in being on and the console's own origin, the portal routes behind portal sign-in — exactly as each login does.
 *
 * **No account enumeration (R3).** A request answers `202` with the same body whether or not the address has an account,
 * whether it was rate-limited, and whether the email was queued — and never sooner than {@link RESPONSE_FLOOR_MS}, so the
 * extra work of issuing a link and queuing its email is not visible in the time it takes either.
 */

export const RESPONSE_FLOOR_MS = 700;
const REQUESTED = { requested: true, message: "If that address has an account, a link to reset its password is on its way. It works once, for an hour." };
const noStore = { "Cache-Control": "no-store" };
const gates = {
  staff: { enabled: requireAuthEnabled, origin: requireAuthOrigin, failure: authFailure },
  portal: { enabled: requirePortalAuthEnabled, origin: requirePortalOrigin, failure: portalAuthFailure },
} as const;

const floor = async (startedAt: number) => {
  const wait = RESPONSE_FLOOR_MS - (Date.now() - startedAt);
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
};

export function resetRequestRoute(principal: ResetPrincipal) {
  return async (request: Request) => {
    const startedAt = Date.now();
    try {
      gates[principal].enabled(); gates[principal].origin(request);
      const body = await request.json().catch(() => ({})) as { email?: unknown };
      if (typeof body.email === "string") {
        await requestPasswordReset(isolatedPool(), {
          organisationId: process.env.NZI_DEMO_ORGANISATION_ID ?? "", principal, email: body.email, origin: process.env.NZI_ISOLATED_API_URL ?? "",
        });
      }
      await floor(startedAt);
      return Response.json(REQUESTED, { status: 202, headers: noStore });
    } catch (error) {
      await floor(startedAt);
      // A fault is said as one rather than dressed as "check your email" — it does not depend on whether the address exists.
      if (error instanceof PasswordResetError) return Response.json({ code: "RESET_UNAVAILABLE", message: "Password reset is not available just now." }, { status: 503, headers: noStore });
      return gates[principal].failure(error);
    }
  };
}

export function resetCompleteRoute(principal: ResetPrincipal) {
  return async (request: Request) => {
    try {
      gates[principal].enabled(); gates[principal].origin(request);
      const body = await request.json().catch(() => ({})) as { token?: unknown; password?: unknown };
      if (typeof body.token !== "string" || typeof body.password !== "string") throw new PasswordResetError();
      await completePasswordReset(isolatedPool(), { organisationId: process.env.NZI_DEMO_ORGANISATION_ID ?? "", principal, token: body.token, password: body.password });
      return Response.json({ reset: true }, { headers: noStore });
    } catch (error) {
      if (error instanceof PasswordResetError) return Response.json({ code: "INVALID_RESET", message: error.message }, { status: 422, headers: noStore });
      return gates[principal].failure(error);
    }
  };
}
