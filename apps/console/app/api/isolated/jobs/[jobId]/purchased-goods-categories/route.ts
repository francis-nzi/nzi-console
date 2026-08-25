import { createPurchasedGoodsCategory,listJobPurchasedGoodsCategories,withTenantRead } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext,commandFailure,commandSuccess } from "../../../../../lib/commandResponse";
import { apiFailure,isolatedPool,requireIsolatedApiContext } from "../../../../../lib/isolatedDatabase";
export const dynamic="force-dynamic";
export async function GET(_request:Request,{params}:{params:Promise<{jobId:string}>}){try{const {jobId}=await params,{pool,organisationId}=requireIsolatedApiContext();return Response.json({categories:await withTenantRead(pool,organisationId,db=>listJobPurchasedGoodsCategories(db,jobId))});}catch(error){return apiFailure(error);}}
export async function POST(request:Request,{params}:{params:Promise<{jobId:string}>}){try{const principal=await requireCommandPrincipal(request,"purchased.goods.category.create"),{jobId}=await params,body=await request.json() as Omit<CommandInputMap["purchased.goods.category.create"],"jobId">;return commandSuccess(await createPurchasedGoodsCategory(isolatedPool(),{jobId,...body},commandContext(request,principal)));}catch(error){return commandFailure(error);}}
