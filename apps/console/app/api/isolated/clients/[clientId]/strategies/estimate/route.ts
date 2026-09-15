import { setClientStrategyEstimate } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/**
 * What a strategy is expected to save — a forward **estimate**, gated by `strategy.manage`.
 *
 * `estimate: null` clears it. The client is not in the body: the strategy's own row says
 * whose plan it belongs to, and the access check resolves the client from it.
 *
 * A percentage is resolved server-side against the benchmark in force; the command refuses
 * one it cannot resolve rather than storing a zero, because "no baseline for that scope" and
 * "this saves nothing" are opposite claims.
 */
export async function POST(request: Request) {
  try {
    const principal = await requireCommandPrincipal(request, "client.strategy.estimate.set");
    const body = await request.json() as CommandInputMap["client.strategy.estimate.set"];
    return commandSuccess(await setClientStrategyEstimate(isolatedPool(), body, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
