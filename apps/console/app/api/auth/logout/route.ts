import { authFailure } from "../../../lib/authResponse";
import { clearSessionCookie, endStaffSession, requireAuthEnabled, requireAuthOrigin } from "../../../lib/staffSession";

export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    requireAuthEnabled(); requireAuthOrigin(request); await endStaffSession(request);
    return Response.json({ authenticated: false }, { headers: { "Set-Cookie": clearSessionCookie(), "Cache-Control": "no-store" } });
  } catch (error) { return authFailure(error); }
}
