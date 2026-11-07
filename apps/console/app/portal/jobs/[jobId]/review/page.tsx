import {headers} from "next/headers";
import {notFound} from "next/navigation";
import "../../../../reports/[versionId]/report-composed.css";
import "../../../../reports/[versionId]/report-composed5.css";
import {PortalShellClient} from "../../../shell/PortalShellClient";
import {portalFeatureEnabled} from "../../../../lib/portalFlags";
import {PortalReviewReport,type ReviewRound} from "./PortalReviewReport";
export const dynamic="force-dynamic";
/** Client-review loop S4: the report open for the client's review - editable wording, locked figures. Dark until `portal-report-review` is on. */
export default async function PortalReviewRoute({params,searchParams}:{params:Promise<{jobId:string}>;searchParams:Promise<{report?:string}>}){
  if(!portalFeatureEnabled("portal-report-review"))notFound();
  const {jobId}=await params,{report:wanted}=await searchParams,cookie=(await headers()).get("cookie"),base=(process.env.NZI_ISOLATED_API_URL??"").replace(/\/$/,"");
  const response=await fetch(`${base}/api/portal/jobs/${encodeURIComponent(jobId)}/review-report${wanted?`?reportVersionId=${encodeURIComponent(wanted)}`:""}`,{cache:"no-store",headers:cookie?{cookie}:{}}).catch(()=>null);
  if(!response||response.status===404)notFound();
  const page=response.ok?<PortalReviewReport jobId={jobId} initial={(await response.json() as {round:ReviewRound}).round}/>:<main className="nz-portal-report-state" role="alert"><h1>This report could not be opened</h1><p>Please try again, or message the team.</p></main>;
  return portalFeatureEnabled("portal-shell")?<PortalShellClient view="reports" jobId={jobId}>{page}</PortalShellClient>:page;
}
