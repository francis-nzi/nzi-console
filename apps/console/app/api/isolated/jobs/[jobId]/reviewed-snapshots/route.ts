import { createReviewedCrpSnapshot,listReviewedCrpSnapshots,withTenantRead } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext,commandFailure,commandSuccess } from "../../../../../lib/commandResponse";
import { apiFailure,isolatedPool,requireIsolatedApiContext } from "../../../../../lib/isolatedDatabase";
export const dynamic="force-dynamic";
export async function GET(_request:Request,{params}:{params:Promise<{jobId:string}>}){try{const {jobId}=await params,{pool,organisationId}=requireIsolatedApiContext();return Response.json({snapshots:await withTenantRead(pool,organisationId,db=>listReviewedCrpSnapshots(db,jobId))});}catch(error){return apiFailure(error);}}
export async function POST(request:Request,{params}:{params:Promise<{jobId:string}>}){try{const principal=await requireCommandPrincipal(request,"report.snapshot.create"),{jobId}=await params,body=await request.json() as Partial<Omit<CommandInputMap["report.snapshot.create"],"jobId">>,pool=isolatedPool();const expectedJobVersion=body.expectedJobVersion??await withTenantRead(pool,principal.organisationId,async db=>(await db.query<{version:number}>("SELECT version FROM nzi_console.jobs WHERE job_id=$1",[jobId])).rows[0]?.version??0);return commandSuccess(await createReviewedCrpSnapshot(pool,{jobId,expectedJobVersion},commandContext(request,principal)));}catch(error){return commandFailure(error);}}
