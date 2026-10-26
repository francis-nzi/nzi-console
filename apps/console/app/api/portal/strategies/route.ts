import { addPortalStrategy, getPortalClientStrategies, updatePortalStrategy, withTenantRead } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { portalAuthFailure } from "../../../lib/authResponse";
import { commandSuccess } from "../../../lib/commandResponse";
import { isolatedPool } from "../../../lib/isolatedDatabase";
import { PortalPlanParticipationOffError, portalCommandContext, portalCommandFailure, portalDataOff, requirePortalPlanParticipation } from "../../../lib/portalCommand";
import { portalFeatureEnabled } from "../../../lib/portalFlags";
import { currentPortalUserForData, requirePortalOrigin } from "../../../lib/portalSession";

export const dynamic = "force-dynamic";

/**
 * Client portal · the reduction plan.
 *
 * GET reads it. Since Actions A2, behind `portal-plan-participation`, the client also writes to it — POST adds an action from
 * the library (it lands Proposed, for their adviser to agree), PATCH nominates an owner or, as the owner, moves an
 * action's date, progress and status. There is **no DELETE**, by design: taking an action off a plan is the adviser's,
 * with a reason. A custom action is proposed at `./proposals`.
 *
 * Tenancy: the client is the session's own client — `user.clientId`, never a path, query or body parameter — inside
 * `withTenantRead` on the session's organisation, and every write runs as the portal principal for that client.
 *
 * `today` is resolved here, on the server, as a London calendar date. Taking it from the
 * request would let a client's device clock decide whether their own plan is overdue.
 */
const londonToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date());

export async function GET(request: Request) {
  try {
    const user = await currentPortalUserForData(request);
    const strategies = await withTenantRead(isolatedPool(), user.organisationId, (db) =>
      getPortalClientStrategies(db, {
        clientId: user.clientId, today: londonToday(),
        viewer: { organisationId: user.organisationId, portalUserId: user.userId },
        participation: portalFeatureEnabled("portal-plan-participation"),
      }),
    );
    return Response.json(strategies, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return portalAuthFailure(error);
  }
}

/** Add an action from the library to your own plan (portal.strategy.add). */
export async function POST(request: Request) {
  try {
    requirePortalPlanParticipation();
    requirePortalOrigin(request);
    const user = await currentPortalUserForData(request);
    const body = await request.json() as Omit<CommandInputMap["portal.strategy.add"], "clientId">;
    return commandSuccess(await addPortalStrategy(isolatedPool(), { strategyId: body.strategyId, clientId: user.clientId }, portalCommandContext(request, user)));
  } catch (error) { return error instanceof PortalPlanParticipationOffError ? portalDataOff() : portalCommandFailure(error); }
}

/** Nominate an owner, or — as the owner — move the date, progress and status (portal.strategy.update). */
export async function PATCH(request: Request) {
  try {
    requirePortalPlanParticipation();
    requirePortalOrigin(request);
    const user = await currentPortalUserForData(request);
    const body = await request.json() as CommandInputMap["portal.strategy.update"];
    return commandSuccess(await updatePortalStrategy(isolatedPool(), body, portalCommandContext(request, user)));
  } catch (error) { return error instanceof PortalPlanParticipationOffError ? portalDataOff() : portalCommandFailure(error); }
}
