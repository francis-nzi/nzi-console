import { restoreReportVersion } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../lib/commandResponse";
import { isolatedPool } from "../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Client-review loop S7: roll the current round's wording back to an earlier version of the same job and scope - `report.restoreVersion`. */
export async function POST(request: Request) {
  try {
    const principal = await requireCommandPrincipal(request, "report.restoreVersion");
    const body = (await request.json()) as CommandInputMap["report.restoreVersion"];
    return commandSuccess(await restoreReportVersion(isolatedPool(), body, commandContext(request, principal)));
  } catch (error) {
    return commandFailure(error);
  }
}
