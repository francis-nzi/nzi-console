import {createEmissionSourceGroup} from "@nzi/isolated-backend";
import type {CommandInputMap} from "@nzi/contracts";
import {requireCommandPrincipal} from "../../../../../lib/commandAuth";
import {commandContext,commandFailure,commandSuccess} from "../../../../../lib/commandResponse";
import {isolatedPool} from "../../../../../lib/isolatedDatabase";
export const dynamic="force-dynamic";
export async function POST(request:Request,{params}:{params:Promise<{jobId:string}>}){try{const principal=await requireCommandPrincipal(request,"emission.source.group.create"),{jobId}=await params,body=await request.json() as Omit<CommandInputMap["emission.source.group.create"],"jobId">;return commandSuccess(await createEmissionSourceGroup(isolatedPool(),{jobId,...body},commandContext(request,principal)));}catch(error){return commandFailure(error);}}
