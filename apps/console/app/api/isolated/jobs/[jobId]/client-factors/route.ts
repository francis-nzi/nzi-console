import {createClientFactor} from "@nzi/isolated-backend";
import type {CommandInputMap} from "@nzi/contracts";
import {requireCommandPrincipal} from "../../../../../lib/commandAuth";
import {commandContext,commandFailure,commandSuccess} from "../../../../../lib/commandResponse";
import {isolatedPool} from "../../../../../lib/isolatedDatabase";
export const dynamic="force-dynamic";
// A factor made on a job (CRP, or LCA/PCF — GAPS G6): the job's client's, pinned to the job unless reusable.
export async function POST(request:Request,{params}:{params:Promise<{jobId:string}>}){try{const principal=await requireCommandPrincipal(request,"client.factor.create"),{jobId}=await params,body=await request.json() as Omit<CommandInputMap["client.factor.create"],"jobId"|"clientId"|"organisationLevel">;return commandSuccess(await createClientFactor(isolatedPool(),{...body,jobId,clientId:null,organisationLevel:false},commandContext(request,principal)));}catch(error){return commandFailure(error);}}
