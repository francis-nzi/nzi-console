import { regenerateReportSection } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const principal = await requireCommandPrincipal(request, "report.section.regenerate");
    const body = (await request.json()) as CommandInputMap["report.section.regenerate"];
    return commandSuccess(await regenerateReportSection(isolatedPool(), body, commandContext(request, principal)));
  } catch (error) {
    return commandFailure(error);
  }
}
