import {getCurrentPublishedCrpReport,withTenantRead} from "@nzi/isolated-backend";
import {apiFailure,requireIsolatedApiContext} from "../../../../../lib/isolatedDatabase";
import {isPublishedCrpReport} from "../../../../../portal/jobs/[jobId]/publishedReportValidation";

export const dynamic="force-dynamic";
export async function GET(_request:Request,{params}:{params:Promise<{jobId:string}>}){try{const {jobId}=await params,{pool,organisationId}=requireIsolatedApiContext();const report=await withTenantRead(pool,organisationId,db=>getCurrentPublishedCrpReport(db,jobId));if(!report)return Response.json({code:"NOT_FOUND",message:"No published CRP report is available for this job."},{status:404});if(!isPublishedCrpReport(report,jobId))return Response.json({code:"INVALID_PUBLISHED_EVIDENCE",message:"The published report evidence could not be verified."},{status:502,headers:{"Cache-Control":"no-store"}});return Response.json({report},{headers:{"Cache-Control":"no-store"}});}catch(error){return apiFailure(error);}}
