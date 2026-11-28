import { setClientFactorYearValues } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

// GAPS G2 — a factor's values by year, set as a whole (a new version, append-only).
export async function POST(request: Request, { params }: { params: Promise<{ clientFactorId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "client.factor.year-values.set");
    const { clientFactorId } = await params;
    const body = (await request.json()) as Omit<CommandInputMap["client.factor.year-values.set"], "clientFactorId">;
    return commandSuccess(await setClientFactorYearValues(isolatedPool(), { ...body, clientFactorId }, commandContext(request, principal)));
  } catch (error) {
    return commandFailure(error);
  }
}
