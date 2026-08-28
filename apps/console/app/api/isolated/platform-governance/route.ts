import {listAuditEvents,listStaffRoleGovernance,withTenantRead} from "@nzi/isolated-backend";
import {authFailure} from "../../../lib/authResponse";
import {isolatedPool} from "../../../lib/isolatedDatabase";
import {currentStaff} from "../../../lib/staffSession";

export const dynamic="force-dynamic";
export async function GET(request:Request){try{const principal=await currentStaff(request),{roles,events}=await withTenantRead(isolatedPool(),principal.organisationId,async db=>({roles:await listStaffRoleGovernance(db),events:await listAuditEvents(db)})),checkedAt=new Date().toISOString(),services=[{id:"console",name:"Console web",area:"Application",state:"success" as const,detail:"Authenticated application route is responding.",checkedAt},{id:"database",name:"Tenant database",area:"Data",state:"success" as const,detail:"Tenant-scoped governance query completed under RLS.",checkedAt}];return Response.json({roles,services,events},{headers:{"Cache-Control":"private, no-store"}});}catch(error){return authFailure(error);}}
