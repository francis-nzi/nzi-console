import { headers } from "next/headers";
import { PreviewFrame } from "../../PreviewFrame";
import { PortalReportPage } from "../../../../../portal/jobs/[jobId]/PortalReportPage";
import { portalPreviewApi, portalPreviewBase } from "../../../../../portal/portalPreviewLinks";
import { deploymentNames } from "../../../../../lib/organisationBrand";
import { organisationCopy } from "../../../../../lib/organisationName";

export const dynamic = "force-dynamic";

/**
 * The job's published report as the client sees it (`/portal/jobs/{jobId}`) — the client's own page (`PortalReportPage`), read
 * through the preview's mirror of the client's routes. No approval can be made (R5): the card is drawn disabled.
 */
export default async function PortalPreviewReportPage({ params, searchParams }: { params: Promise<{ clientId: string; jobId: string }>; searchParams: Promise<{ report?: string }> }) {
  const { clientId, jobId } = await params;
  const { report: wanted } = await searchParams;
  const org = organisationCopy(await deploymentNames());
  const cookie = (await headers()).get("cookie");
  const base = (process.env.NZI_ISOLATED_API_URL ?? "").replace(/\/$/, "");
  return <PreviewFrame clientId={clientId} jobId={jobId} surface="report">
    {() => <PortalReportPage source={{ api: `${base}${portalPreviewApi(clientId)}`, pages: portalPreviewBase(clientId), cookie, org, sessionEndedNext: null }} jobId={jobId} wanted={wanted} />}
  </PreviewFrame>;
}
