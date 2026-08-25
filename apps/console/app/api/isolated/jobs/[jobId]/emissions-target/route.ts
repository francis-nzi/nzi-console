import { getJobEmissionsTarget,upsertEmissionsTarget,withTenantRead } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext,commandFailure,commandSuccess } from "../../../../../lib/commandResponse";
import { apiFailure,isolatedPool,requireIsolatedApiContext } from "../../../../../lib/isolatedDatabase";

export const dynamic="force-dynamic";
export async function GET(_request:Request,{params}:{params:Promise<{jobId:string}>}){try{const {jobId}=await params,{pool,organisationId}=requireIsolatedApiContext();return Response.json({target:await withTenantRead(pool,organisationId,db=>getJobEmissionsTarget(db,jobId))});}catch(error){return apiFailure(error);}}
export async function PUT(request:Request,{params}:{params:Promise<{jobId:string}>}){try{const principal=await requireCommandPrincipal(request,"emissions.target.upsert"),{jobId}=await params,body=await request.json() as Omit<CommandInputMap["emissions.target.upsert"],"jobId">;return commandSuccess(await upsertEmissionsTarget(isolatedPool(),{...body,jobId},commandContext(request,principal)));}catch(error){return commandFailure(error);}}
