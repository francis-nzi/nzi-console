import { PortalWorkspace } from "./PortalWorkspace";
import { portalAccessSample, portalBucketsSample, publishedReportSample } from "@nzi/mock-data";
import { loadFixtureScreen } from "@nzi/api-client";
import { ScreenState } from "../lib/ScreenState";

export default function PortalPreviewPage() {
  const result = loadFixtureScreen("portal", { access: portalAccessSample, buckets: portalBucketsSample, report: publishedReportSample });
  return <ScreenState result={result}>{() => <PortalWorkspace />}</ScreenState>;
}
