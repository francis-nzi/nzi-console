import { importPortalScopeRows, issueSpendImportIdentity } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { commandSuccess } from "../../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../../lib/isolatedDatabase";
import { currentPortalUserForData, requirePortalOrigin } from "../../../../../../lib/portalSession";
import { PortalDataOffError, portalCommandContext, portalCommandFailure, portalDataOff, requirePortalData } from "../../../../../../lib/portalCommand";

export const dynamic = "force-dynamic";

/** Portal bulk import (BRIEF-portal-data-entry-parity #3): a previewed, confirmed template filed as pending rows, all or none (portal.scope.row.import). */
export async function POST(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    requirePortalData();
    requirePortalOrigin(request);
    const user = await currentPortalUserForData(request);
    const { jobId } = await params;
    const body = await request.json() as Omit<CommandInputMap["portal.scope.row.import"], "jobId">;
    const context = portalCommandContext(request, user);
    if (body.template === "spend") {
      // The identity is issued here, by the server, for this job as it is now: the client's own token (if any) is ignored, and so is any
      // pre-built row — the server routes and files the lines (RULING-portal-import-spend).
      const secret = process.env.NZI_CONSOLE_SESSION_SECRET;
      const issued = await issueSpendImportIdentity(isolatedPool(), user.organisationId, jobId, secret);
      if (!issued) return Response.json({ code: "VALIDATION_FAILED", message: "Command validation failed.", issues: [{ field: "jobId", code: "NOT_CONFIGURED", message: "This job has no reporting period set yet, so nothing can be imported." }] }, { status: 422 });
      return commandSuccess(await importPortalScopeRows(isolatedPool(), { jobId, template: "spend", rows: body.rows?.length ? body.rows : [], spend: { token: issued.token, lines: body.spend?.lines ?? [] } }, context, { spendSecret: secret }));
    }
    return commandSuccess(await importPortalScopeRows(isolatedPool(), { ...body, jobId }, context));
  } catch (error) { return error instanceof PortalDataOffError ? portalDataOff() : portalCommandFailure(error); }
}
