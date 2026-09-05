import {deleteLcaTransportLeg,updateLcaTransportLeg} from "@nzi/isolated-backend";
import type {CommandInputMap} from "@nzi/contracts";
import {requireCommandPrincipal} from "../../../../../../../../../../lib/commandAuth";
import {commandContext,commandFailure,commandSuccess} from "../../../../../../../../../../lib/commandResponse";
import {isolatedPool} from "../../../../../../../../../../lib/isolatedDatabase";

export const dynamic="force-dynamic";

export async function PATCH(request:Request,{params}:{params:Promise<{jobId:string;assessmentId:string;lineItemId:string;legId:string}>}){try{const principal=await requireCommandPrincipal(request,"lca.transportLeg.update"),{jobId,assessmentId,lineItemId,legId}=await params,body=await request.json() as Omit<CommandInputMap["lca.transportLeg.update"],"jobId"|"assessmentId"|"lineItemId"|"legId">;return commandSuccess(await updateLcaTransportLeg(isolatedPool(),{...body,jobId,assessmentId,lineItemId,legId},commandContext(request,principal)));}catch(error){return commandFailure(error);}}

export async function DELETE(request:Request,{params}:{params:Promise<{jobId:string;assessmentId:string;lineItemId:string;legId:string}>}){try{const principal=await requireCommandPrincipal(request,"lca.transportLeg.delete"),{jobId,assessmentId,lineItemId,legId}=await params;return commandSuccess(await deleteLcaTransportLeg(isolatedPool(),{jobId,assessmentId,lineItemId,legId},commandContext(request,principal)));}catch(error){return commandFailure(error);}}
