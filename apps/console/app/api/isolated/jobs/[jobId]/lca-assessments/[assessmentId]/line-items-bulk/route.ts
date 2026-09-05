import {bulkCreateLcaLineItems} from "@nzi/isolated-backend";
import type {CommandInputMap} from "@nzi/contracts";
import {requireCommandPrincipal} from "../../../../../../../lib/commandAuth";
import {commandContext,commandFailure,commandSuccess} from "../../../../../../../lib/commandResponse";
import {isolatedPool} from "../../../../../../../lib/isolatedDatabase";

// Track C — BOM import (bulk): reuses the same command, creating every pasted
// / picked line in one idempotent transaction.
export const dynamic="force-dynamic";

export async function POST(request:Request,{params}:{params:Promise<{jobId:string;assessmentId:string}>}){try{const principal=await requireCommandPrincipal(request,"lca.lineItem.bulkCreate"),{jobId,assessmentId}=await params,body=await request.json() as Omit<CommandInputMap["lca.lineItem.bulkCreate"],"jobId"|"assessmentId">;return commandSuccess(await bulkCreateLcaLineItems(isolatedPool(),{...body,jobId,assessmentId},commandContext(request,principal)));}catch(error){return commandFailure(error);}}
