import { publishCrpReport } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../lib/commandAuth";
import { commandContext,commandFailure,commandSuccess } from "../../../../lib/commandResponse";
import { isolatedPool } from "../../../../lib/isolatedDatabase";

export async function POST(request:Request){try{const principal=await requireCommandPrincipal(request,"report.publish"),body=await request.json() as CommandInputMap["report.publish"];return commandSuccess(await publishCrpReport(isolatedPool(),body,commandContext(request,principal)));}catch(error){return commandFailure(error);}}
