import {createLcaLineItem,listLcaLineItems,withTenantRead} from "@nzi/isolated-backend";
import type {CommandInputMap} from "@nzi/contracts";
import {requireCommandPrincipal} from "../../../../../../../lib/commandAuth";
import {commandContext,commandFailure,commandSuccess} from "../../../../../../../lib/commandResponse";
import {apiFailure,isolatedPool,requireIsolatedApiContext} from "../../../../../../../lib/isolatedDatabase";

// Track C — LCA inventory (slice 2). GET the assessment's line items; POST
// creates one (manual add or a component-library pick).
export const dynamic="force-dynamic";

export async function GET(_request:Request,{params}:{params:Promise<{jobId:string;assessmentId:string}>}){try{const {assessmentId}=await params,{pool,organisationId}=requireIsolatedApiContext();return Response.json({lines:await withTenantRead(pool,organisationId,db=>listLcaLineItems(db,assessmentId))});}catch(error){return apiFailure(error);}}

export async function POST(request:Request,{params}:{params:Promise<{jobId:string;assessmentId:string}>}){try{const principal=await requireCommandPrincipal(request,"lca.lineItem.create"),{jobId,assessmentId}=await params,body=await request.json() as Omit<CommandInputMap["lca.lineItem.create"],"jobId"|"assessmentId">;return commandSuccess(await createLcaLineItem(isolatedPool(),{...body,jobId,assessmentId},commandContext(request,principal)));}catch(error){return commandFailure(error);}}
