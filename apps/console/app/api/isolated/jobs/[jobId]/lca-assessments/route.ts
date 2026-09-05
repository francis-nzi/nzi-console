import {createLcaAssessment,listLcaAssessments,withTenantRead} from "@nzi/isolated-backend";
import type {CommandInputMap} from "@nzi/contracts";
import {requireCommandPrincipal} from "../../../../../lib/commandAuth";
import {commandContext,commandFailure,commandSuccess} from "../../../../../lib/commandResponse";
import {apiFailure,isolatedPool,requireIsolatedApiContext} from "../../../../../lib/isolatedDatabase";

// Track C — LCA/PCF reference module, slice 1 (assessment register). Behind
// `job-module-lca`. GET the job's assessments; POST creates one.
export const dynamic="force-dynamic";

export async function GET(_request:Request,{params}:{params:Promise<{jobId:string}>}){try{const {jobId}=await params,{pool,organisationId}=requireIsolatedApiContext();return Response.json({assessments:await withTenantRead(pool,organisationId,db=>listLcaAssessments(db,jobId))});}catch(error){return apiFailure(error);}}

export async function POST(request:Request,{params}:{params:Promise<{jobId:string}>}){try{const principal=await requireCommandPrincipal(request,"lca.assessment.create"),{jobId}=await params,body=await request.json() as Omit<CommandInputMap["lca.assessment.create"],"jobId">;return commandSuccess(await createLcaAssessment(isolatedPool(),{...body,jobId},commandContext(request,principal)));}catch(error){return commandFailure(error);}}
