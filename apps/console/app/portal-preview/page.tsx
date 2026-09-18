import { PortalWorkspace } from "./PortalWorkspace";
import { portalAccessSample, portalBucketsSample, publishedReportSample } from "@nzi/mock-data";
import { loadFixtureScreen } from "@nzi/api-client";
import { ScreenState } from "../lib/ScreenState";
import {loadScreen} from "../lib/loadScreen";
import type {InputSpecCategory,PublishedCrpReportReadModel} from "@nzi/contracts";

export default async function PortalPreviewPage({searchParams}:{searchParams:Promise<{jobId?:string}>}) {
  const {jobId}=await searchParams;
  // The same server path as the CRM: the spec is read here and passed down, so the staff preview
  // renders from the governed spec exactly as the client's own portal does (NZC-102).
  const specResult = await loadScreen<{spec:InputSpecCategory[]}>("inputSpec",{spec:[]},"input-spec");
  const specs: Record<string,InputSpecCategory> = Object.fromEntries(
    (specResult.state==="success"||specResult.state==="degraded" ? specResult.data.spec : [])
      .map((category)=>[category.categoryCode,category]));
  if(jobId){const result=await loadScreen<{report:PublishedCrpReportReadModel}>("portal",{},`jobs/${jobId}/published-report`);return <ScreenState result={result}>{data=><PortalWorkspace specs={specs} report={data.report}/>}</ScreenState>;}
  const result = loadFixtureScreen("portal", { access: portalAccessSample, buckets: portalBucketsSample, report: publishedReportSample });
  return <ScreenState result={result}>{() => <PortalWorkspace specs={specs} />}</ScreenState>;
}
