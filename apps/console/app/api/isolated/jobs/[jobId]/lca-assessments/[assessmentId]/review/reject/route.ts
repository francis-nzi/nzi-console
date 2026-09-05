import {rejectLcaAssessment} from "@nzi/isolated-backend";
import {requireCommandPrincipal} from "../../../../../../../../lib/commandAuth";
import {commandContext,commandFailure,commandSuccess} from "../../../../../../../../lib/commandResponse";
import {isolatedPool} from "../../../../../../../../lib/isolatedDatabase";

// Track C — L4 independent review: reject (a reviewer note is required).
export const dynamic="force-dynamic";

export async function POST(request:Request,{params}:{params:Promise<{jobId:string;assessmentId:string}>}){try{const principal=await requireCommandPrincipal(request,"lca.assessment.review.reject"),{jobId,assessmentId}=await params,body=await request.json() as {expectedVersion:number;reviewerNote:string};return commandSuccess(await rejectLcaAssessment(isolatedPool(),{jobId,assessmentId,expectedVersion:body.expectedVersion,reviewerNote:body.reviewerNote},commandContext(request,principal)));}catch(error){return commandFailure(error);}}
