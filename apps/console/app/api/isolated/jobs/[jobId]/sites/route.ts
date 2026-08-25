import { createClientSite,listJobSites,withTenantRead } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext,commandFailure,commandSuccess } from "../../../../../lib/commandResponse";
import { apiFailure,isolatedPool,requireIsolatedApiContext } from "../../../../../lib/isolatedDatabase";
export const dynamic="force-dynamic";
export async function GET(_request:Request,{params}:{params:Promise<{jobId:string}>}){try{const {jobId}=await params,{pool,organisationId}=requireIsolatedApiContext();return Response.json({sites:await withTenantRead(pool,organisationId,db=>listJobSites(db,jobId))});}catch(error){return apiFailure(error);}}
export async function POST(request:Request,{params}:{params:Promise<{jobId:string}>}){try{const principal=await requireCommandPrincipal(request,"site.create"),{jobId}=await params,body=await request.json() as Omit<CommandInputMap["site.create"],"jobId">;return commandSuccess(await createClientSite(isolatedPool(),{jobId,...body},commandContext(request,principal)));}catch(error){return commandFailure(error);}}
