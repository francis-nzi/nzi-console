import {deleteLcaScenarioMultiplier} from "@nzi/isolated-backend";
import {requireCommandPrincipal} from "../../../../../../../../../../lib/commandAuth";
import {commandContext,commandFailure,commandSuccess} from "../../../../../../../../../../lib/commandResponse";
import {isolatedPool} from "../../../../../../../../../../lib/isolatedDatabase";

export const dynamic="force-dynamic";

export async function DELETE(request:Request,{params}:{params:Promise<{jobId:string;assessmentId:string;scenarioId:string;multiplierId:string}>}){try{const principal=await requireCommandPrincipal(request,"lca.scenario.multiplier.delete"),{jobId,assessmentId,scenarioId,multiplierId}=await params;return commandSuccess(await deleteLcaScenarioMultiplier(isolatedPool(),{jobId,assessmentId,scenarioId,multiplierId},commandContext(request,principal)));}catch(error){return commandFailure(error);}}
