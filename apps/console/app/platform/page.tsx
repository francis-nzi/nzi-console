import type {AuditEventReadModel,StaffRoleReadModel} from "@nzi/isolated-backend";
import {loadScreen} from "../lib/loadScreen";
import { ScreenState } from "../lib/ScreenState";
import { PlatformBoard } from "./PlatformBoard";

type PlatformPayload={services:Array<{id:string;name:string;area:string;state:"success"|"degraded"|"failed"|"loading"|"empty";detail:string;checkedAt:string;latencyMs?:number}>;events:AuditEventReadModel[];roles:StaffRoleReadModel[]};
export const dynamic="force-dynamic";
export default async function PlatformPage() {
  const result=await loadScreen<PlatformPayload>("platform",{services:[],events:[],roles:[]},"platform-governance");
  return <ScreenState result={result}>{(data) => <PlatformBoard services={data.services} events={data.events} roles={data.roles} />}</ScreenState>;
}
