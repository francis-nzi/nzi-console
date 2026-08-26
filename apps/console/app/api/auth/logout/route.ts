import { authFailure } from "../../../lib/authResponse";
import { clearSessionCookie, endStaffSession, requireAuthEnabled, requireAuthOrigin } from "../../../lib/staffSession";

export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    requireAuthEnabled(); requireAuthOrigin(request); await endStaffSession(request);
    const headers = { "Set-Cookie": clearSessionCookie(), "Cache-Control": "no-store" };
    if (request.headers.get("accept")?.includes("text/html")) return new Response(null, { status: 303, headers: { ...headers, Location: "/login" } });
    return Response.json({ authenticated: false }, { headers });
  } catch (error) { return authFailure(error); }
}
