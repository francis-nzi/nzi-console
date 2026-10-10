import { updateReportSectionPlan } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../lib/commandResponse";
import { isolatedPool } from "../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

// Reporting F-1 (Q2) — reorder a validated report's sections before it is published. Version-checked; returns the version the
// caller now holds, which publish then pins.
export async function POST(request: Request) {
  try {
    const principal = await requireCommandPrincipal(request, "report.sectionPlan.update");
    const body = await request.json() as CommandInputMap["report.sectionPlan.update"];
    return commandSuccess(await updateReportSectionPlan(isolatedPool(), body, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
