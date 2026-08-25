import { addManualDataset } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../../lib/commandAuth";
import { commandContext,commandFailure,commandSuccess } from "../../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../../lib/isolatedDatabase";
export const dynamic="force-dynamic";
export async function POST(request:Request,{params}:{params:Promise<{jobId:string}>}){try{const principal=await requireCommandPrincipal(request,"dataset.override.add"),{jobId}=await params,body=await request.json() as Omit<CommandInputMap["dataset.override.add"],"jobId">;return commandSuccess(await addManualDataset(isolatedPool(),{...body,jobId},commandContext(request,principal)));}catch(error){return commandFailure(error);}}
