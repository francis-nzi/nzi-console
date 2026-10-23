import Link from "next/link";
import {redirect} from "next/navigation";
import type {ClientFacingPublishedCrpReport,InputSpecCategory} from "@nzi/contracts";
import type {PortalReportApproval} from "@nzi/isolated-backend";
import {PortalWorkspace} from "../../../portal-preview/PortalWorkspace";
// F-4b: the issued document's own stylesheet, for the composed report the workspace draws.
import "../../../reports/[versionId]/report-composed.css";
import "../../../reports/[versionId]/report-composed5.css";
import {isPortalReportApproval,isPublishedCrpReport} from "./publishedReportValidation";
import {portalReportViewOf,type PortalReportView} from "../../portalReportView";
import type {OrganisationCopy} from "../../../lib/organisationName";

/**
 * The client's published-report page for a job, drawn for a signed-in client (`/portal/jobs/{jobId}`) or for the staff preview
 * (`/clients/{clientId}/portal-preview/jobs/{jobId}`) — one page, so the preview cannot draw a report the client would not see.
 * `api` is where it reads (the client's routes, or the preview's mirror of them) and `pages` where its links go (`/portal`, or
 * the preview's base); only the client is sent to sign in again when their session ends (`sessionEndedNext`).
 */
export type PortalReportPageSource={api:string;pages:string;cookie:string|null;org:OrganisationCopy;sessionEndedNext:string|null};

export async function PortalReportPage({source,jobId,wanted}:{source:PortalReportPageSource;jobId:string;wanted?:string}){const {api,pages,cookie,org}=source,query=wanted?`?reportVersionId=${encodeURIComponent(wanted)}`:"",headers:Record<string,string>=cookie?{cookie}:{};const specs=await (async():Promise<Record<string,InputSpecCategory>>=>{try{const r=await fetch(`${api}/input-spec`,{cache:"no-store",headers});if(!r.ok)return {};const body=await r.json() as {spec?:InputSpecCategory[]};return Object.fromEntries((body.spec??[]).map(c=>[c.categoryCode,c]));}catch{return {};}})();let response:Response;try{response=await fetch(`${api}/jobs/${jobId}/published-report${query}`,{cache:"no-store",headers})}catch{return <ReportState org={org} pages={pages} jobId={jobId} state="failed"/>}if(response.status===401&&source.sessionEndedNext)redirect(`/portal/session-ended?next=${encodeURIComponent(source.sessionEndedNext)}`);if(!response.ok)return <ReportState org={org} pages={pages} jobId={jobId} state={response.status===403?"denied":response.status===404?"missing":"failed"}/>;let body:unknown;try{body=await response.json()}catch{return <ReportState org={org} pages={pages} jobId={jobId} state="failed"/>}if(!isReportBody(body,jobId))return <ReportState org={org} pages={pages} jobId={jobId} state="failed"/>;const view=await reportViewFor(api,cookie,jobId,body.report.reportVersionId);return <>{body.reports&&body.reports.length>1?<ScopeSwitcher pages={pages} jobId={jobId} reports={body.reports} current={body.report.reportVersionId}/>:null}<PortalWorkspace specs={specs} report={body.report} approval={body.approval} view={view} clientMode/></>}

/**
 * F-4b: the issued document for the report in view — its frozen composition (F-4a's grant-checked read), or, for a version
 * issued before compositions were frozen, `pre-composition`. Any failure is `failed`: the snapshot is never drawn in a
 * composed report's place, because it does not honour a section the report left out.
 */
async function reportViewFor(api:string,cookie:string|null,jobId:string,reportVersionId:string):Promise<PortalReportView>{try{const response=await fetch(`${api}/jobs/${jobId}/published-report/composition?reportVersionId=${encodeURIComponent(reportVersionId)}`,{cache:"no-store",headers:cookie?{cookie}:{}});if(!response.ok)return {state:"failed",message:"The issued report could not be loaded."};return portalReportViewOf(await response.json(),{reportVersionId,jobId})}catch{return {state:"failed",message:"The issued report could not be loaded."}}}

function isReportBody(value:unknown,expectedJobId:string):value is {report:ClientFacingPublishedCrpReport;approval:PortalReportApproval|null;reports?:ScopeEntry[]}{if(!value||typeof value!=="object")return false;const candidate=value as {report?:unknown;approval?:unknown};if(!isPublishedCrpReport(candidate.report,expectedJobId))return false;const reports=(value as {reports?:unknown}).reports;if(reports!==undefined&&!(Array.isArray(reports)&&reports.every(entry=>entry&&typeof entry==="object"&&typeof (entry as ScopeEntry).reportVersionId==="string"&&typeof (entry as ScopeEntry).scopeLabel==="string")))return false;return candidate.approval===null||isPortalReportApproval(candidate.approval,candidate.report.reportVersionId)}
type ScopeEntry={reportVersionId:string;scopeLabel:string};
/** S-1 (portal v1, ruled): every published scope of the job, the one in view marked; approval and comments act on the report in view. */
function ScopeSwitcher({pages,jobId,reports,current}:{pages:string;jobId:string;reports:ScopeEntry[];current:string}){return <nav className="nz-portal-scope-switch" aria-label="Published reports for this job"><span className="nz-eyebrow">Published reports</span><div className="nz-filters">{reports.map(entry=><Link key={entry.reportVersionId} href={`${pages}/jobs/${jobId}?report=${encodeURIComponent(entry.reportVersionId)}`} className={entry.reportVersionId===current?"on":undefined} aria-current={entry.reportVersionId===current?"page":undefined}>{entry.scopeLabel}</Link>)}</div></nav>}
function ReportState({org,pages,jobId,state}:{org:OrganisationCopy;pages:string;jobId:string;state:"denied"|"missing"|"failed"}){const denied=state==="denied",missing=state==="missing";return <main className="nz-portal-report-state"><section className={denied||missing?"unavailable":"failed"} role={denied||missing?"status":"alert"}><i>{denied?"×":missing?"—":"!"}</i><div><span className="nz-eyebrow">Published report</span><h1>{denied?"This report is not granted to your account.":missing?"No published report is available yet.":"The published report could not be loaded."}</h1><p>{denied?`Ask ${org.your("adviser")} to review your job-level access.`:missing?`${org.Your("team")} will release the verified version when assurance is complete.`:"No conclusion has been made about your access or the report’s publication state."}</p><div><Link className="nz-btn" href={pages}>Back to reporting jobs</Link>{!denied&&!missing?<Link className="nz-btn pri" href={`${pages}/jobs/${jobId}`}>Try again</Link>:null}</div></div></section></main>}
