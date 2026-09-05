import {gapFillLcaLineItem} from "@nzi/isolated-backend";
import type {CommandInputMap} from "@nzi/contracts";
import {requireCommandPrincipal} from "../../../../../../../../../lib/commandAuth";
import {commandContext,commandFailure,commandSuccess} from "../../../../../../../../../lib/commandResponse";
import {isolatedPool} from "../../../../../../../../../lib/isolatedDatabase";

// Track C — L4 gap-filling: the LCA analogue of the Data Assurance gate.
export const dynamic="force-dynamic";

export async function POST(request:Request,{params}:{params:Promise<{jobId:string;assessmentId:string;lineItemId:string}>}){try{const principal=await requireCommandPrincipal(request,"lca.lineItem.gapFill"),{jobId,assessmentId,lineItemId}=await params,body=await request.json() as Omit<CommandInputMap["lca.lineItem.gapFill"],"jobId"|"assessmentId"|"lineItemId">;return commandSuccess(await gapFillLcaLineItem(isolatedPool(),{...body,jobId,assessmentId,lineItemId},commandContext(request,principal)));}catch(error){return commandFailure(error);}}
