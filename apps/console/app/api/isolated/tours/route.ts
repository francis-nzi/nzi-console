import { listTourSeen, recordTourSeen, withTenantRead, withTenantWrite } from "@nzi/isolated-backend";
import { currentStaff, requireAuthOrigin } from "../../../lib/staffSession";
import { apiFailure, isolatedPool } from "../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/**
 * Which tours this person has been shown.
 *
 * **The one write in this app that is not a command** (NZC-082). Every mutation elsewhere is
 * permission-checked and audited; this is a person's own UI state, the server-side equivalent
 * of a remembered collapsed panel, kept here only so it follows them between devices. An audit
 * entry for "was shown a tour" would be noise in a log that exists to answer who changed a
 * client's data.
 *
 * The safety is structural rather than a capability: the user and the organisation come from
 * the **verified session**, never from the body, so the only row anyone can write is their
 * own. The body carries the tour and whether they dismissed it — nothing that identifies a
 * person.
 */
export async function GET(request: Request) {
  try {
    const staff = await currentStaff(request);
    const seen = await withTenantRead(isolatedPool(), staff.organisationId, (db) => listTourSeen(db, staff.userId));
    return Response.json({ seen }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return apiFailure(error); }
}

export async function POST(request: Request) {
  try {
    requireAuthOrigin(request);
    const staff = await currentStaff(request);
    const body = await request.json() as { tourId?: unknown; tourVersion?: unknown; dismissed?: unknown };
    const tourId = typeof body.tourId === "string" ? body.tourId.trim() : "";
    const tourVersion = Number(body.tourVersion);
    if (tourId === "" || !Number.isInteger(tourVersion) || tourVersion < 1) {
      return Response.json({ message: "A tour and its version are required." }, { status: 400 });
    }
    await withTenantWrite(isolatedPool(), staff.organisationId, (db) => recordTourSeen(db, {
      organisationId: staff.organisationId,
      // From the session. A caller cannot record on someone else's behalf.
      userId: staff.userId,
      tourId, tourVersion, dismissed: body.dismissed === true,
    }));
    return Response.json({ ok: true });
  } catch (error) { return apiFailure(error); }
}
