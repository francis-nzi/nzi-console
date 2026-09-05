import {setLcaScenarioMultiplier} from "@nzi/isolated-backend";
import type {CommandInputMap} from "@nzi/contracts";
import {requireCommandPrincipal} from "../../../../../../../../../lib/commandAuth";
import {commandContext,commandFailure,commandSuccess} from "../../../../../../../../../lib/commandResponse";
import {isolatedPool} from "../../../../../../../../../lib/isolatedDatabase";

// Track C — L5: set (upsert) one what-if multiplier rule on a scenario.
export const dynamic="force-dynamic";

export async function PUT(request:Request,{params}:{params:Promise<{jobId:string;assessmentId:string;scenarioId:string}>}){try{const principal=await requireCommandPrincipal(request,"lca.scenario.multiplier.set"),{jobId,assessmentId,scenarioId}=await params,body=await request.json() as Omit<CommandInputMap["lca.scenario.multiplier.set"],"jobId"|"assessmentId"|"scenarioId">;return commandSuccess(await setLcaScenarioMultiplier(isolatedPool(),{...body,jobId,assessmentId,scenarioId},commandContext(request,principal)));}catch(error){return commandFailure(error);}}
