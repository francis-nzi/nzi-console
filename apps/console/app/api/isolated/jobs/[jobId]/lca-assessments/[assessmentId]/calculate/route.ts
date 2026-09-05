import {calculateLcaAssessment} from "@nzi/isolated-backend";
import {requireCommandPrincipal} from "../../../../../../../lib/commandAuth";
import {commandContext,commandFailure,commandSuccess} from "../../../../../../../lib/commandResponse";
import {isolatedPool} from "../../../../../../../lib/isolatedDatabase";

// Track C — L4 calc engine: resolves every line item's + transport leg's
// factor mapping, recomputes the module breakdown / hotspots / mass
// reconciliation / total, and resets review (a recalculation invalidates any
// prior sign-off).
export const dynamic="force-dynamic";

export async function POST(request:Request,{params}:{params:Promise<{jobId:string;assessmentId:string}>}){try{const principal=await requireCommandPrincipal(request,"lca.assessment.calculate"),{jobId,assessmentId}=await params,body=await request.json() as {expectedVersion:number};return commandSuccess(await calculateLcaAssessment(isolatedPool(),{jobId,assessmentId,expectedVersion:body.expectedVersion},commandContext(request,principal)));}catch(error){return commandFailure(error);}}
