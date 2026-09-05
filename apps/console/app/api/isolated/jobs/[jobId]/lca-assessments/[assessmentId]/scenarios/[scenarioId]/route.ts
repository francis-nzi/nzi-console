import {deleteLcaScenario,updateLcaScenario} from "@nzi/isolated-backend";
import type {CommandInputMap} from "@nzi/contracts";
import {requireCommandPrincipal} from "../../../../../../../../lib/commandAuth";
import {commandContext,commandFailure,commandSuccess} from "../../../../../../../../lib/commandResponse";
import {isolatedPool} from "../../../../../../../../lib/isolatedDatabase";

export const dynamic="force-dynamic";

export async function PATCH(request:Request,{params}:{params:Promise<{jobId:string;assessmentId:string;scenarioId:string}>}){try{const principal=await requireCommandPrincipal(request,"lca.scenario.update"),{jobId,assessmentId,scenarioId}=await params,body=await request.json() as Omit<CommandInputMap["lca.scenario.update"],"jobId"|"assessmentId"|"scenarioId">;return commandSuccess(await updateLcaScenario(isolatedPool(),{...body,jobId,assessmentId,scenarioId},commandContext(request,principal)));}catch(error){return commandFailure(error);}}

export async function DELETE(request:Request,{params}:{params:Promise<{jobId:string;assessmentId:string;scenarioId:string}>}){try{const principal=await requireCommandPrincipal(request,"lca.scenario.delete"),{jobId,assessmentId,scenarioId}=await params;return commandSuccess(await deleteLcaScenario(isolatedPool(),{jobId,assessmentId,scenarioId},commandContext(request,principal)));}catch(error){return commandFailure(error);}}
