import { getPortalPreview, PortalPreviewError } from "@nzi/isolated-backend";
import { authFailure } from "../../../../../lib/authResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";
import { currentStaff } from "../../../../../lib/staffSession";

export const dynamic = "force-dynamic";

/**
 * Staff portal preview — GET only, and read-only by construction: there is no write surface in
 * the preview, and nothing here accepts a body.
 *
 * It does write one row, and only one: the `portal.preview.open` audit event. A GET with a side
 * effect is worth being deliberate about, and this is the narrow case where it is right — the
 * thing being audited *is* the looking, so there is no later action to hang the record on. The
 * alternative, a POST to open and a GET to read, would let a client's portal be read without the
 * record of who read it.
 *
 * `today` is resolved on the server as a London calendar date, exactly as the client's own portal
 * route does. Taking it from the request would let the viewer's clock decide whether a client's
 * plan is overdue — and the preview's whole claim is that it shows what the client sees.
 */
const londonToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date());

export async function GET(request: Request, { params }: { params: Promise<{ clientId: string }> }) {
  try {
    const principal = await currentStaff(request);
    const { clientId } = await params;
    const preview = await getPortalPreview(isolatedPool(), principal, { clientId, today: londonToday() });
    return Response.json(preview, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof PortalPreviewError) {
      return Response.json({ code: "CLIENT_UNAVAILABLE", message: error.message }, { status: 404 });
    }
    return authFailure(error as Error);
  }
}
