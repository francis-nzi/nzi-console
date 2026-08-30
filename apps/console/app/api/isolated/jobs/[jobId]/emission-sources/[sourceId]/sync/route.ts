import {syncEmissionSourceToScope} from "@nzi/isolated-backend";
import {requireCommandPrincipal} from "../../../../../../../lib/commandAuth";
import {commandContext,commandFailure,commandSuccess} from "../../../../../../../lib/commandResponse";
import {isolatedPool} from "../../../../../../../lib/isolatedDatabase";
export const dynamic="force-dynamic";
export async function POST(request:Request,{params}:{params:Promise<{jobId:string;sourceId:string}>}){try{const principal=await requireCommandPrincipal(request,"emission.source.sync"),{jobId,sourceId}=await params;return commandSuccess(await syncEmissionSourceToScope(isolatedPool(),{jobId,sourceId},commandContext(request,principal)));}catch(error){return commandFailure(error);}}
