import { PortalWorkspace } from "./PortalWorkspace";
import { portalAccessSample, portalBucketsSample, publishedReportSample } from "@nzi/mock-data";
import { loadFixtureScreen } from "@nzi/api-client";
import { ScreenState } from "../lib/ScreenState";
import {loadScreen} from "../lib/loadScreen";
import type {PublishedCrpReportReadModel} from "@nzi/contracts";

export default async function PortalPreviewPage({searchParams}:{searchParams:Promise<{jobId?:string}>}) {
  const {jobId}=await searchParams;
  if(jobId){const result=await loadScreen<{report:PublishedCrpReportReadModel}>("portal",{},`jobs/${jobId}/published-report`);return <ScreenState result={result}>{data=><PortalWorkspace report={data.report}/>}</ScreenState>;}
  const result = loadFixtureScreen("portal", { access: portalAccessSample, buckets: portalBucketsSample, report: publishedReportSample });
  return <ScreenState result={result}>{() => <PortalWorkspace />}</ScreenState>;
}
