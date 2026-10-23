import { redirect } from "next/navigation";
import type { PortalPreviewReadModel } from "@nzi/isolated-backend";
import { PreviewFrame } from "../PreviewFrame";
import { PortalReadiness } from "../../../../portal/PortalReadiness";
import { portalPreviewBase } from "../../../../portal/portalPreviewLinks";
import { portalFeatureEnabled } from "../../../../lib/portalFlags";

export const dynamic = "force-dynamic";

/** SRS Readiness as the client sees it, from the preview's own read of the client's resolver. */
export default async function PortalPreviewSrsPage({ params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = await params;
  if (!portalFeatureEnabled("portal-readiness")) redirect(portalPreviewBase(clientId));
  return <PreviewFrame clientId={clientId} surface="srs">
    {(preview: PortalPreviewReadModel) => <PortalReadiness model={preview.readiness} />}
  </PreviewFrame>;
}
