import { resetClientPortalProfile, resetClientPortalVisibility } from "@nzi/isolated-backend";
import { requireCommandPrincipal } from "../../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/**
 * Portal Management → "Reset all to default", one atomic command per tab: `visibility` is client.portal.profile.reset (portal.admin),
 * `scopes` is client.portal.visibility.reset (category.visibility — as the scope and category switches are). One audit event each.
 */
export async function POST(request: Request, { params }: { params: Promise<{ clientId: string }> }) {
  try {
    const body = await request.json().catch(() => ({})) as { group?: unknown; note?: string | null };
    if (body.group !== "visibility" && body.group !== "scopes") return Response.json({ code: "VALIDATION_FAILED", message: "Command validation failed.", issues: [{ field: "group", code: "UNKNOWN", message: "Reset the settings or the scopes and categories." }] }, { status: 422 });
    const { clientId } = await params;
    if (body.group === "visibility") {
      const principal = await requireCommandPrincipal(request, "client.portal.profile.reset");
      return commandSuccess(await resetClientPortalProfile(isolatedPool(), { clientId, note: body.note ?? null }, commandContext(request, principal)));
    }
    const principal = await requireCommandPrincipal(request, "client.portal.visibility.reset");
    return commandSuccess(await resetClientPortalVisibility(isolatedPool(), { clientId, note: body.note ?? null }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
