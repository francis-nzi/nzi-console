import "server-only";
import { countRecoveryCodes, RecoveryCodeError, regenerateRecoveryCodes, type RecoveryPrincipal } from "@nzi/isolated-backend";
import { authFailure, portalAuthFailure } from "./authResponse";
import { isolatedPool } from "./isolatedDatabase";
import { currentPortalUser, requirePortalOrigin } from "./portalSession";
import { currentStaff, requireAuthOrigin } from "./staffSession";

/**
 * MFA recovery codes for the signed-in person (email programme phase 4-2, R7), on each sign-in's account page. GET: how many
 * unused codes they hold. POST { code }: a new set, proved with a current authenticator code — the earlier set's unused
 * codes are revoked, and the new ones are returned once.
 */

const noStore = { "Cache-Control": "no-store" };
const realms = {
  staff: { who: async (request: Request) => { const staff = await currentStaff(request); return { organisationId: staff.organisationId, subjectId: staff.userId }; }, origin: requireAuthOrigin, failure: authFailure },
  portal: { who: async (request: Request) => { const user = await currentPortalUser(request); return { organisationId: user.organisationId, subjectId: user.userId }; }, origin: requirePortalOrigin, failure: portalAuthFailure },
} as const;

export function recoveryCodeRoutes(principal: RecoveryPrincipal) {
  const realm = realms[principal];
  return {
    GET: async (request: Request) => {
      try {
        const account = { ...(await realm.who(request)), principal };
        return Response.json({ remaining: await countRecoveryCodes(isolatedPool(), account) }, { headers: noStore });
      } catch (error) { return realm.failure(error); }
    },
    POST: async (request: Request) => {
      try {
        realm.origin(request);
        const account = { ...(await realm.who(request)), principal };
        const body = await request.json().catch(() => ({})) as { code?: unknown };
        if (typeof body.code !== "string") throw new RecoveryCodeError("Enter the six-digit code from your authenticator.");
        const recoveryCodes = await regenerateRecoveryCodes(isolatedPool(), account, { code: body.code }, process.env.NZI_CONSOLE_MFA_ENCRYPTION_KEY ?? "");
        return Response.json({ recoveryCodes }, { headers: noStore });
      } catch (error) {
        if (error instanceof RecoveryCodeError) return Response.json({ code: "INVALID_CODE", message: error.message }, { status: 422, headers: noStore });
        return realm.failure(error);
      }
    },
  };
}
