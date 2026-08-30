import {updateEmissionSourceStatus} from "@nzi/isolated-backend";
import type {CommandInputMap} from "@nzi/contracts";
import {requireCommandPrincipal} from "../../../../../../../lib/commandAuth";
import {commandContext,commandFailure,commandSuccess} from "../../../../../../../lib/commandResponse";
import {isolatedPool} from "../../../../../../../lib/isolatedDatabase";
export const dynamic="force-dynamic";
export async function PATCH(request:Request,{params}:{params:Promise<{jobId:string;sourceId:string}>}){try{const principal=await requireCommandPrincipal(request,"emission.source.status.update"),{jobId,sourceId}=await params,body=await request.json() as Omit<CommandInputMap["emission.source.status.update"],"jobId"|"sourceId">;return commandSuccess(await updateEmissionSourceStatus(isolatedPool(),{...body,jobId,sourceId},commandContext(request,principal)));}catch(error){return commandFailure(error);}}
