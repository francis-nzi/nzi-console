import {listGrantedPortalJobs,withTenantRead} from "@nzi/isolated-backend";
import {authFailure} from "../../../lib/authResponse";
import {isolatedPool} from "../../../lib/isolatedDatabase";
import {currentPortalUser} from "../../../lib/portalSession";
import {isPortalJobList} from "../../../portal/portalPortfolioValidation";
export const dynamic="force-dynamic";
export async function GET(request:Request){try{const user=await currentPortalUser(request),jobs=await withTenantRead(isolatedPool(),user.organisationId,db=>listGrantedPortalJobs(db,{portalUserId:user.userId,clientId:user.clientId}));if(!isPortalJobList(jobs))return Response.json({code:"INVALID_PORTFOLIO_EVIDENCE",message:"The reporting engagement evidence could not be verified."},{status:502,headers:{"Cache-Control":"private, no-store"}});return Response.json({jobs},{headers:{"Cache-Control":"private, no-store"}});}catch(error){return authFailure(error);}}
