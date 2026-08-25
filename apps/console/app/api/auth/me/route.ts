import { authFailure } from "../../../lib/authResponse";
import { currentStaff } from "../../../lib/staffSession";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const principal = await currentStaff(request);
    return Response.json({ userId: principal.userId, organisationId: principal.organisationId, role: principal.role, permissions: principal.permissions }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return authFailure(error); }
}
