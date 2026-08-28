import {listAuditEvents,listStaffRoleGovernance,withTenantRead,type AuditEventReadModel,type StaffRoleReadModel} from "@nzi/isolated-backend";
import type {ScreenResult} from "@nzi/contracts";
import {headers} from "next/headers";
import {isolatedPool} from "../lib/isolatedDatabase";
import {loadScreen} from "../lib/loadScreen";
import { ScreenState } from "../lib/ScreenState";
import {currentStaff} from "../lib/staffSession";
import { PlatformBoard } from "./PlatformBoard";

type PlatformPayload={services:Array<{id:string;name:string;area:string;state:"success"|"degraded"|"failed"|"loading"|"empty";detail:string;checkedAt:string;latencyMs?:number}>;events:AuditEventReadModel[];roles:StaffRoleReadModel[]};
export const dynamic="force-dynamic";

async function loadPlatformDirect():Promise<ScreenResult<PlatformPayload>>{
  const requestId=crypto.randomUUID(),receivedAt=new Date().toISOString(),meta={contract:"platform" as const,source:"api" as const,requestId,receivedAt};
  try{
    const incoming=await headers(),cookie=incoming.get("cookie")??"",base=process.env.NZI_ISOLATED_API_URL??"https://nzi-pro-api-prod.onrender.com",principal=await currentStaff(new Request(`${base.replace(/\/$/,"")}/platform`,{headers:{cookie}}));
    const {roles,events}=await withTenantRead(isolatedPool(),principal.organisationId,async db=>({roles:await listStaffRoleGovernance(db),events:await listAuditEvents(db)})),checkedAt=new Date().toISOString(),services:PlatformPayload["services"]=[{id:"console",name:"Console web",area:"Application",state:"success",detail:"Authenticated application route is responding.",checkedAt},{id:"database",name:"Tenant database",area:"Data",state:"success",detail:"Tenant-scoped governance query completed under RLS.",checkedAt}];
    return{state:"success",meta,data:{roles,services,events}};
  }catch{return{state:"failed",meta,error:{code:"PLATFORM_GOVERNANCE_FAILED",message:"The authenticated platform governance query could not be completed.",retryable:true,correlationId:requestId}}}
}

export default async function PlatformPage() {
  const result=process.env.NZI_DATA_MODE==="isolated-api"?await loadPlatformDirect():await loadScreen<PlatformPayload>("platform",{services:[],events:[],roles:[]},"platform-governance");
  return <ScreenState result={result}>{(data) => <PlatformBoard services={data.services} events={data.events} roles={data.roles} />}</ScreenState>;
}
