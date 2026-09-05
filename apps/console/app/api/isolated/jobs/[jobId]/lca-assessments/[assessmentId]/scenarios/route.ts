import {createLcaScenario,listLcaScenarios,withTenantRead} from "@nzi/isolated-backend";
import type {CommandInputMap} from "@nzi/contracts";
import {requireCommandPrincipal} from "../../../../../../../lib/commandAuth";
import {commandContext,commandFailure,commandSuccess} from "../../../../../../../lib/commandResponse";
import {apiFailure,isolatedPool,requireIsolatedApiContext} from "../../../../../../../lib/isolatedDatabase";

// Track C — L5 what-if scenarios. GET the scenario list; POST creates one.
export const dynamic="force-dynamic";

export async function GET(_request:Request,{params}:{params:Promise<{jobId:string;assessmentId:string}>}){try{const {assessmentId}=await params,{pool,organisationId}=requireIsolatedApiContext();return Response.json({scenarios:await withTenantRead(pool,organisationId,db=>listLcaScenarios(db,assessmentId))});}catch(error){return apiFailure(error);}}

export async function POST(request:Request,{params}:{params:Promise<{jobId:string;assessmentId:string}>}){try{const principal=await requireCommandPrincipal(request,"lca.scenario.create"),{jobId,assessmentId}=await params,body=await request.json() as Omit<CommandInputMap["lca.scenario.create"],"jobId"|"assessmentId">;return commandSuccess(await createLcaScenario(isolatedPool(),{...body,jobId,assessmentId},commandContext(request,principal)));}catch(error){return commandFailure(error);}}
