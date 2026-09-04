import {listScopeRowRollforwardPreview,rollforwardScopeRows,withTenantRead} from "@nzi/isolated-backend";
import type {CommandInputMap} from "@nzi/contracts";
import {requireCommandPrincipal} from "../../../../../../lib/commandAuth";
import {commandContext,commandFailure,commandSuccess} from "../../../../../../lib/commandResponse";
import {apiFailure,isolatedPool,requireIsolatedApiContext} from "../../../../../../lib/isolatedDatabase";

// NZC-063 — "Reuse Previous Year Rows". GET previews the prior CRP job's
// enabled scope rows (factor/hierarchy/site + moved-factor and
// already-rolled-forward flags); POST copies the chosen rows forward.
export const dynamic="force-dynamic";

export async function GET(_request:Request,{params}:{params:Promise<{jobId:string}>}){try{const {jobId}=await params,{pool,organisationId}=requireIsolatedApiContext();return Response.json(await withTenantRead(pool,organisationId,db=>listScopeRowRollforwardPreview(db,jobId)));}catch(error){return apiFailure(error);}}

export async function POST(request:Request,{params}:{params:Promise<{jobId:string}>}){try{const principal=await requireCommandPrincipal(request,"scope.row.rollforward"),{jobId}=await params,body=await request.json() as Omit<CommandInputMap["scope.row.rollforward"],"jobId">;return commandSuccess(await rollforwardScopeRows(isolatedPool(),{...body,jobId},commandContext(request,principal)));}catch(error){return commandFailure(error);}}
