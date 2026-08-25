import {headers} from "next/headers";
import type {PublishedCrpReportReadModel} from "@nzi/contracts";
import {PortalWorkspace} from "../../../portal-preview/PortalWorkspace";
export const dynamic="force-dynamic";
export default async function PortalReportPage({params}:{params:Promise<{jobId:string}>}){const {jobId}=await params,cookie=(await headers()).get("cookie"),base=(process.env.NZI_ISOLATED_API_URL??"").replace(/\/$/,""),response=await fetch(`${base}/api/portal/jobs/${jobId}/published-report`,{cache:"no-store",headers:cookie?{cookie}:{}});if(!response.ok)return <main className="nz-body"><div className="nz-banner warn"><b>Published report unavailable</b><div>This job is not granted to your account or has no published report.</div></div></main>;const body=await response.json() as {report:PublishedCrpReportReadModel};return <PortalWorkspace report={body.report} clientMode/>}
