import { createPortalTrackerAction, deletePortalTrackerAction, getPortalActionTracker, PortalActionValidationError, updatePortalTrackerAction, VersionConflictError } from "@nzi/isolated-backend";
import { portalAuthFailure } from "../../../../../lib/authResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";
import { currentPortalUserForData, requirePortalOrigin } from "../../../../../lib/portalSession";

export const dynamic = "force-dynamic";
const fail = (error: unknown) => error instanceof PortalActionValidationError
  ? Response.json({ code: "INVALID_TRACKER_ACTION", message: error.message }, { status: 422 })
  : error instanceof VersionConflictError
    ? Response.json({ code: "VERSION_CONFLICT", message: error.message }, { status: 409 })
    : portalAuthFailure(error);

export async function GET(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try { const user = await currentPortalUserForData(request), { jobId } = await params; return Response.json(await getPortalActionTracker(isolatedPool(), user, jobId), { headers: { "Cache-Control": "private, no-store" } }); }
  catch (error) { return fail(error); }
}
export async function POST(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try { requirePortalOrigin(request); const user = await currentPortalUserForData(request), { jobId } = await params, body = await request.json() as Record<string, unknown>; return Response.json(await createPortalTrackerAction(isolatedPool(), user, jobId, body), { status: 201, headers: { "Cache-Control": "private, no-store" } }); }
  catch (error) { return fail(error); }
}
export async function PATCH(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try { requirePortalOrigin(request); const user = await currentPortalUserForData(request), { jobId } = await params, body = await request.json() as Record<string, unknown>; if (typeof body.actionId !== "string" || !Number.isInteger(body.expectedVersion)) throw new PortalActionValidationError("An action and its current version are required."); return Response.json(await updatePortalTrackerAction(isolatedPool(), user, jobId, body.actionId, Number(body.expectedVersion), body), { headers: { "Cache-Control": "private, no-store" } }); }
  catch (error) { return fail(error); }
}
export async function DELETE(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try { requirePortalOrigin(request); const user = await currentPortalUserForData(request), { jobId } = await params, body = await request.json() as Record<string, unknown>; if (typeof body.actionId !== "string" || !Number.isInteger(body.expectedVersion)) throw new PortalActionValidationError("An action and its current version are required."); return Response.json(await deletePortalTrackerAction(isolatedPool(), user, jobId, body.actionId, Number(body.expectedVersion)), { headers: { "Cache-Control": "private, no-store" } }); }
  catch (error) { return fail(error); }
}
