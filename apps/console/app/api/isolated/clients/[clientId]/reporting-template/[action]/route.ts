import { deactivateClientReportingTemplate, initialiseClientReportingTemplateFromJob } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

// Phase 1c (0159) — `initialise`: build the next version from one of the client's CRP jobs. `deactivate`: withdraw the
// template — a version that says so; the reason (x-command-reason) is required. Never a delete.
export async function POST(request: Request, { params }: { params: Promise<{ clientId: string; action: string }> }) {
  try {
    const { clientId, action } = await params;
    if (action === "initialise") {
      const principal = await requireCommandPrincipal(request, "client.reportingTemplate.initialiseFromJob");
      const body = await request.json() as Omit<CommandInputMap["client.reportingTemplate.initialiseFromJob"], "clientId">;
      return commandSuccess(await initialiseClientReportingTemplateFromJob(isolatedPool(), { ...body, clientId }, commandContext(request, principal)));
    }
    if (action === "deactivate") {
      const principal = await requireCommandPrincipal(request, "client.reportingTemplate.deactivate");
      const body = await request.json() as Omit<CommandInputMap["client.reportingTemplate.deactivate"], "clientId">;
      return commandSuccess(await deactivateClientReportingTemplate(isolatedPool(), { ...body, clientId }, commandContext(request, principal)));
    }
    return Response.json({ type: "about:blank", title: "Unknown reporting-template action", status: 404 }, { status: 404 });
  } catch (error) { return commandFailure(error); }
}
