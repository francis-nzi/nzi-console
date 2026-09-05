import {createLcaTransportLeg,listLcaTransportLegs,withTenantRead} from "@nzi/isolated-backend";
import type {CommandInputMap} from "@nzi/contracts";
import {requireCommandPrincipal} from "../../../../../../../../../lib/commandAuth";
import {commandContext,commandFailure,commandSuccess} from "../../../../../../../../../lib/commandResponse";
import {apiFailure,isolatedPool,requireIsolatedApiContext} from "../../../../../../../../../lib/isolatedDatabase";

// Track C — LCA transport legs (slice 3; A2/A4/C2 line items only). GET the
// leg sequence for one line item; POST appends the next leg (auto leg_order).
export const dynamic="force-dynamic";

export async function GET(_request:Request,{params}:{params:Promise<{jobId:string;assessmentId:string;lineItemId:string}>}){try{const {lineItemId}=await params,{pool,organisationId}=requireIsolatedApiContext();return Response.json({legs:await withTenantRead(pool,organisationId,db=>listLcaTransportLegs(db,lineItemId))});}catch(error){return apiFailure(error);}}

export async function POST(request:Request,{params}:{params:Promise<{jobId:string;assessmentId:string;lineItemId:string}>}){try{const principal=await requireCommandPrincipal(request,"lca.transportLeg.create"),{jobId,assessmentId,lineItemId}=await params,body=await request.json() as Omit<CommandInputMap["lca.transportLeg.create"],"jobId"|"assessmentId"|"lineItemId">;return commandSuccess(await createLcaTransportLeg(isolatedPool(),{...body,jobId,assessmentId,lineItemId},commandContext(request,principal)));}catch(error){return commandFailure(error);}}
