import {deleteLcaLineItem,updateLcaLineItem} from "@nzi/isolated-backend";
import type {CommandInputMap} from "@nzi/contracts";
import {requireCommandPrincipal} from "../../../../../../../../lib/commandAuth";
import {commandContext,commandFailure,commandSuccess} from "../../../../../../../../lib/commandResponse";
import {isolatedPool} from "../../../../../../../../lib/isolatedDatabase";

export const dynamic="force-dynamic";

export async function PATCH(request:Request,{params}:{params:Promise<{jobId:string;assessmentId:string;lineItemId:string}>}){try{const principal=await requireCommandPrincipal(request,"lca.lineItem.update"),{jobId,assessmentId,lineItemId}=await params,body=await request.json() as Omit<CommandInputMap["lca.lineItem.update"],"jobId"|"assessmentId"|"lineItemId">;return commandSuccess(await updateLcaLineItem(isolatedPool(),{...body,jobId,assessmentId,lineItemId},commandContext(request,principal)));}catch(error){return commandFailure(error);}}

export async function DELETE(request:Request,{params}:{params:Promise<{jobId:string;assessmentId:string;lineItemId:string}>}){try{const principal=await requireCommandPrincipal(request,"lca.lineItem.delete"),{jobId,assessmentId,lineItemId}=await params;return commandSuccess(await deleteLcaLineItem(isolatedPool(),{jobId,assessmentId,lineItemId},commandContext(request,principal)));}catch(error){return commandFailure(error);}}
