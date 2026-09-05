import {approveLcaAssessment} from "@nzi/isolated-backend";
import {requireCommandPrincipal} from "../../../../../../../../lib/commandAuth";
import {commandContext,commandFailure,commandSuccess} from "../../../../../../../../lib/commandResponse";
import {isolatedPool} from "../../../../../../../../lib/isolatedDatabase";

// Track C — L4 independent review: approve (binds review_status -> reviewed_version, NZC-055).
export const dynamic="force-dynamic";

export async function POST(request:Request,{params}:{params:Promise<{jobId:string;assessmentId:string}>}){try{const principal=await requireCommandPrincipal(request,"lca.assessment.review.approve"),{jobId,assessmentId}=await params,body=await request.json() as {expectedVersion:number;reviewerNote?:string};return commandSuccess(await approveLcaAssessment(isolatedPool(),{jobId,assessmentId,expectedVersion:body.expectedVersion,reviewerNote:body.reviewerNote},commandContext(request,principal)));}catch(error){return commandFailure(error);}}
