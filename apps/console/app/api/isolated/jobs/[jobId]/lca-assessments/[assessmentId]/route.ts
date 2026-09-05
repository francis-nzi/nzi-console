import {updateLcaAssessment} from "@nzi/isolated-backend";
import type {CommandInputMap} from "@nzi/contracts";
import {requireCommandPrincipal} from "../../../../../../lib/commandAuth";
import {commandContext,commandFailure,commandSuccess} from "../../../../../../lib/commandResponse";
import {isolatedPool} from "../../../../../../lib/isolatedDatabase";

export const dynamic="force-dynamic";

export async function PATCH(request:Request,{params}:{params:Promise<{jobId:string;assessmentId:string}>}){try{const principal=await requireCommandPrincipal(request,"lca.assessment.update"),{jobId,assessmentId}=await params,body=await request.json() as Omit<CommandInputMap["lca.assessment.update"],"jobId"|"assessmentId">;return commandSuccess(await updateLcaAssessment(isolatedPool(),{...body,jobId,assessmentId},commandContext(request,principal)));}catch(error){return commandFailure(error);}}
