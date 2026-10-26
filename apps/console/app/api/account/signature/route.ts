import { emailBrandFor } from "@nzi/contracts";
import {
  readOrganisationProfile, readStaffSignature, StaffSignatureError, updateOwnStaffSignature, VersionConflictError, withTenantRead,
} from "@nzi/isolated-backend";
import { authFailure } from "../../../lib/authResponse";
import { isolatedPool } from "../../../lib/isolatedDatabase";
import { currentStaff, requireAuthOrigin } from "../../../lib/staffSession";

/**
 * The signed-in member's own email signature (email programme phase 5-2, R2), for the account page's Signature card.
 *
 * GET: their signature, its defaults from their record, and the organisation's house chrome to preview it in. PUT: save it.
 * **Only ever their own**: the member is the session's — the body is read for the four fields and the version, and nothing
 * in it can name another member.
 */
export const dynamic = "force-dynamic";
const noStore = { "Cache-Control": "no-store" };
const field = (value: unknown) => (typeof value === "string" ? value : null);
/** A sign-in problem answers as one; anything else is the signature's own failure, never "sign-in could not be completed". */
const failure = (error: unknown, message: string) => {
  const response = authFailure(error);
  return response.status === 500 ? Response.json({ code: "SIGNATURE_UNAVAILABLE", message }, { status: 500, headers: noStore }) : response;
};

export async function GET(request: Request) {
  try {
    const staff = await currentStaff(request);
    const data = await withTenantRead(isolatedPool(), staff.organisationId, async (db) => ({
      signature: await readStaffSignature(db, staff.userId),
      // The chrome the lines sit above, as a send draws it: the same settings, the same origin for the logo.
      brand: emailBrandFor((await readOrganisationProfile(db, staff.organisationId))?.fields ?? null, process.env.NZI_ISOLATED_API_URL ?? null),
    }));
    if (!data.signature) return Response.json({ code: "NOT_FOUND", message: "Your staff record could not be found." }, { status: 404, headers: noStore });
    return Response.json({ ...data.signature, brand: data.brand }, { headers: noStore });
  } catch (error) { return failure(error, "Your signature could not be read just now."); }
}

export async function PUT(request: Request) {
  try {
    requireAuthOrigin(request);
    const staff = await currentStaff(request);
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    if (typeof body.expectedVersion !== "number") return Response.json({ code: "INVALID", message: "The signature's version is missing." }, { status: 422, headers: noStore });
    const saved = await updateOwnStaffSignature(isolatedPool(), { organisationId: staff.organisationId, userId: staff.userId }, {
      title: field(body.title), displayEmail: field(body.displayEmail), mobile: field(body.mobile), signOff: field(body.signOff), expectedVersion: body.expectedVersion,
    });
    return Response.json(saved, { headers: noStore });
  } catch (error) {
    if (error instanceof StaffSignatureError) return Response.json({ code: "INVALID", message: error.message, issues: error.issues }, { status: 422, headers: noStore });
    if (error instanceof VersionConflictError) return Response.json({ code: "VERSION_CONFLICT", message: "Your signature changed elsewhere — reload to see it, then save again." }, { status: 409, headers: noStore });
    // The save is one transaction: a failure here changed nothing.
    return failure(error, "Your signature could not be saved just now — nothing was changed.");
  }
}
