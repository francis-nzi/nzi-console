import {headers} from "next/headers";
import Link from "next/link";
import {PortalReportPage} from "./PortalReportPage";
import {PortalShellClient} from "../../shell/PortalShellClient";
import {deploymentNames} from "../../../lib/organisationBrand";
import {organisationCopy} from "../../../lib/organisationName";
import {portalFeatureEnabled} from "../../../lib/portalFlags";
export const dynamic="force-dynamic";
/** The client's published report for a job — the page the staff preview shares (`PortalReportPage`), on the client's own routes; under Reports in the shell. */
export default async function PortalReportRoute({params,searchParams}:{params:Promise<{jobId:string}>;searchParams:Promise<{report?:string}>}){const {jobId}=await params,{report:wanted}=await searchParams,org=organisationCopy(await deploymentNames()),cookie=(await headers()).get("cookie"),base=(process.env.NZI_ISOLATED_API_URL??"").replace(/\/$/,"");const review=portalFeatureEnabled("portal-report-review")&&(await fetch(`${base}/api/portal/jobs/${encodeURIComponent(jobId)}/review-report`,{cache:"no-store",headers:cookie?{cookie}:{}}).catch(()=>null))?.ok===true;
  const page=<>{review?<p className="nz-hint" role="note" data-portal-review-banner style={{margin:"8px 0"}}>A report is open for your review. <Link href={`/portal/jobs/${jobId}/review`}>Review and edit the wording</Link></p>:null}<PortalReportPage source={{api:`${base}/api/portal`,pages:"/portal",cookie,org,sessionEndedNext:`/portal/jobs/${jobId}`}} jobId={jobId} wanted={wanted}/></>;return portalFeatureEnabled("portal-shell")?<PortalShellClient view="reports" jobId={jobId}>{page}</PortalShellClient>:page}
