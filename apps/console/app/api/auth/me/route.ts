import { staffChromeFirstName, staffDisplayName } from "@nzi/isolated-backend";
import { authFailure } from "../../../lib/authResponse";
import { isolatedPool } from "../../../lib/isolatedDatabase";
import { currentStaff } from "../../../lib/staffSession";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const principal = await currentStaff(request);
    // NZC-022 — the same capability set the command layer enforces; the UI gates controls from it.
    // The name is only for the chrome (rail chip, greeting): the authenticated member of staff's own, never a constant.
    // `firstName` is how they are addressed (0207); `displayName` stays the full name for the places that record who did something.
    return Response.json({ userId: principal.userId, displayName: await staffDisplayName(isolatedPool(), principal), firstName: await staffChromeFirstName(isolatedPool(), principal), organisationId: principal.organisationId, role: principal.role, matrixVersion: principal.matrixVersion, capabilities: principal.capabilities }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return authFailure(error); }
}
