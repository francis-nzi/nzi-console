import { updateReportNarrative } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../lib/commandResponse";
import { isolatedPool } from "../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** B2-4 (d)(ii): change one narrative section on a validated version, in place — `report.narrative.update`. */
export async function POST(request: Request) {
  try {
    const principal = await requireCommandPrincipal(request, "report.narrative.update");
    const body = (await request.json()) as CommandInputMap["report.narrative.update"];
    return commandSuccess(await updateReportNarrative(isolatedPool(), body, commandContext(request, principal)));
  } catch (error) {
    return commandFailure(error);
  }
}
