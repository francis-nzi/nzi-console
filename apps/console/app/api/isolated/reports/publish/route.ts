import { publishCrpReport } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../lib/commandAuth";
import { commandContext,commandFailure,commandSuccess } from "../../../../lib/commandResponse";
import { checkBeforePublish } from "../../../../lib/driftCheck";
import { isolatedPool } from "../../../../lib/isolatedDatabase";

// BRIEF-v7-import-j000663 Part C: a job imported from the previous system is checked against it just before the publish, outside the
// command's transaction; the command's gate (issueReportVersion) then reads that stored check.
export async function POST(request:Request){try{const principal=await requireCommandPrincipal(request,"report.publish"),body=await request.json() as CommandInputMap["report.publish"];const context=commandContext(request,principal);await checkBeforePublish(principal,(body as {reportVersionId?:unknown})?.reportVersionId,context.correlationId);return commandSuccess(await publishCrpReport(isolatedPool(),body,context));}catch(error){return commandFailure(error);}}
