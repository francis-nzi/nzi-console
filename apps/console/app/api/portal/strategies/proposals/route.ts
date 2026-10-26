import { proposePortalStrategy } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { commandSuccess } from "../../../../lib/commandResponse";
import { isolatedPool } from "../../../../lib/isolatedDatabase";
import { PortalPlanParticipationOffError, portalCommandContext, portalCommandFailure, portalDataOff, requirePortalPlanParticipation } from "../../../../lib/portalCommand";
import { currentPortalUserForData, requirePortalOrigin } from "../../../../lib/portalSession";

export const dynamic = "force-dynamic";

/**
 * Client portal · propose a custom action (Actions A2, R2). It is not on the plan until the client's adviser approves it
 * in the CRM; until then the portal lists it as "with your adviser". POST only — a proposal is not edited or withdrawn
 * from here.
 */
export async function POST(request: Request) {
  try {
    requirePortalPlanParticipation();
    requirePortalOrigin(request);
    const user = await currentPortalUserForData(request);
    const body = await request.json() as Omit<CommandInputMap["portal.strategy.propose"], "clientId">;
    return commandSuccess(await proposePortalStrategy(isolatedPool(),
      { title: body.title, scope: body.scope, note: body.note, clientId: user.clientId }, portalCommandContext(request, user)));
  } catch (error) { return error instanceof PortalPlanParticipationOffError ? portalDataOff() : portalCommandFailure(error); }
}
