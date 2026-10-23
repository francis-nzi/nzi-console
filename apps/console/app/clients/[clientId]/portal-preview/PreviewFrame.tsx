import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import type { PortalPreviewReadModel, PortalPreviewSurface } from "@nzi/isolated-backend";
import { loadScreen } from "../../../lib/loadScreen";
import { ScreenState } from "../../../lib/ScreenState";
import { WithOrganisationName } from "../../../lib/organisationBrand";
import { WithCurrencyDirectory } from "../../../lib/currencyDirectory";
import { PreviewSurfaceProvider } from "../../../portal/portalSurface";
import { PreviewBar } from "./PreviewBar";

const NO_PREVIEW = null as unknown as PortalPreviewReadModel;

/**
 * Every previewed surface opens through `getPortalPreview`: `support.portal_impersonate` on the client, the job checked to be the
 * client's, and one `portal.preview.open` audit row naming the job and the surface (R1) — audited on open, not per fetch. The
 * client's components then read through the preview's mirror of their routes (`PreviewSurfaceProvider`), read-only (R5).
 *
 * A failed load renders as failed: a read that did not work must never render as a client with nothing to see.
 */
export async function PreviewFrame({ clientId, jobId, surface, children }: {
  clientId: string; jobId?: string; surface: PortalPreviewSurface;
  children: (preview: PortalPreviewReadModel) => ReactNode;
}) {
  const query = new URLSearchParams({ surface, ...(jobId ? { jobId } : {}) });
  const result = await loadScreen<PortalPreviewReadModel>(
    "portalPreview", NO_PREVIEW, `clients/${encodeURIComponent(clientId)}/portal-preview?${query}`);
  if (result.state === "failed" && result.error.code === "HTTP_404") notFound();

  return <ScreenState result={result}>
    {(preview: PortalPreviewReadModel) => (
      <WithOrganisationName>
        <WithCurrencyDirectory>
          <div className="nz-portal-preview">
            <PreviewBar preview={preview} surface={surface} />
            <PreviewSurfaceProvider clientId={preview.client.id}>{children(preview)}</PreviewSurfaceProvider>
          </div>
        </WithCurrencyDirectory>
      </WithOrganisationName>
    )}
  </ScreenState>;
}
