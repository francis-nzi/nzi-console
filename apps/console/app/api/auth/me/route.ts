import { authFailure } from "../../../lib/authResponse";
import { currentStaff } from "../../../lib/staffSession";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const principal = await currentStaff(request);
    // NZC-022 — the same capability set the command layer enforces; the UI gates controls from it.
    return Response.json({ userId: principal.userId, organisationId: principal.organisationId, role: principal.role, matrixVersion: principal.matrixVersion, capabilities: principal.capabilities }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return authFailure(error); }
}
