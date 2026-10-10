import { PortalWorkspace } from "./PortalWorkspace";
// F-4b: the issued document's own stylesheet, for the composed report the workspace draws.
import "../reports/[versionId]/report-composed.css";
import { portalAccessSample, portalBucketsSample, publishedReportSample } from "@nzi/mock-data";
import { loadFixtureScreen } from "@nzi/api-client";
import { ScreenState } from "../lib/ScreenState";
import {loadScreen} from "../lib/loadScreen";
import {WithOrganisationName} from "../lib/organisationBrand";
import {clientFacingComposition,clientFacingPublishedReport,type InputSpecCategory,type PublishedCrpReportReadModel,type ReportComposition} from "@nzi/contracts";
import type {PortalReportView} from "../portal/portalReportView";

export default async function PortalPreviewPage({searchParams}:{searchParams:Promise<{jobId?:string}>}) {
  const {jobId}=await searchParams;
  // The same server path as the CRM: the spec is read here and passed down, so the staff preview
  // renders from the governed spec exactly as the client's own portal does (NZC-102).
  const specResult = await loadScreen<{spec:InputSpecCategory[]}>("inputSpec",{spec:[]},"input-spec");
  const specs: Record<string,InputSpecCategory> = Object.fromEntries(
    (specResult.state==="success"||specResult.state==="degraded" ? specResult.data.spec : [])
      .map((category)=>[category.categoryCode,category]));
  if(jobId){
    const result=await loadScreen<{report:PublishedCrpReportReadModel}>("portal",{},`jobs/${jobId}/published-report`);
    const view=result.state==="success"||result.state==="degraded"?await previewView(result.data.report):undefined;
    // F-4b: the preview is the client's view — the client's copy of the report and of the issued document, stripped alike.
    return <WithOrganisationName><ScreenState result={result}>{data=><PortalWorkspace specs={specs} report={clientFacingPublishedReport(data.report)} view={view}/>}</ScreenState></WithOrganisationName>;
  }
  const result = loadFixtureScreen("portal", { access: portalAccessSample, buckets: portalBucketsSample, report: publishedReportSample });
  return <WithOrganisationName><ScreenState result={result}>{() => <PortalWorkspace specs={specs} />}</ScreenState></WithOrganisationName>;
}

/** F-4b: the issued document the client sees for this version — the frozen composition, or `pre-composition` (D1). */
async function previewView(report:PublishedCrpReportReadModel):Promise<PortalReportView>{
  const composed=await loadScreen<{composition:ReportComposition|null}>("reportComposition",{composition:null},`report-versions/${report.reportVersionId}/composition`);
  if(composed.state!=="success"&&composed.state!=="degraded")return {state:"failed",message:"The issued report could not be loaded."};
  const composition=composed.data.composition;
  if(!composition)return {state:"pre-composition"};
  if(composition.reportVersionId!==report.reportVersionId||composition.jobId!==report.snapshot.jobId)return {state:"failed",message:"The issued report could not be verified."};
  return {state:"composed",composition:clientFacingComposition(composition)};
}
