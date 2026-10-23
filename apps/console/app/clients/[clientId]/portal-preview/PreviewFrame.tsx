import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import type { PortalPreviewReadModel, PortalPreviewSurface } from "@nzi/isolated-backend";
import { loadScreen } from "../../../lib/loadScreen";
import { ScreenState } from "../../../lib/ScreenState";
import { WithOrganisationName } from "../../../lib/organisationBrand";
import { WithCurrencyDirectory } from "../../../lib/currencyDirectory";
import { PreviewSurfaceProvider } from "../../../portal/portalSurface";
import { PreviewBar } from "./PreviewBar";
import { ProfileDifferences } from "./PortalPreview";
import { PortalShell } from "../../../portal/shell/PortalShell";
import "../../../portal/shell/portal-shell.css";
import { defaultShellJob, type ShellView } from "../../../portal/shell/shellNav";
import { portalFeatureEnabled } from "../../../lib/portalFlags";

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

  const shell = portalFeatureEnabled("portal-shell");
  return <ScreenState result={result}>
    {(preview: PortalPreviewReadModel) => (
      <WithOrganisationName>
        <WithCurrencyDirectory>
          <div className="nz-portal-preview">
            <PreviewBar preview={preview} surface={surface} nav={!shell} />
            <PreviewSurfaceProvider clientId={preview.client.id}>
              {shell ? (
                // BUILD-portal-shell-lookandfeel R5: the client's shell, around the client's own views, under the staff banner.
                <PortalShell client={{ name: preview.client.name, logoSrc: null }} jobs={preview.jobs} jobId={preview.job?.id ?? defaultShellJob(preview.jobs)?.id ?? null} view={SHELL_VIEW[surface]} person={{ kind: "preview" }}>
                  {/* Staff-only, on the landing: why this client's portal may differ from the default (NZC-087). */}
                  {surface === "dashboard" ? <ProfileDifferences preview={preview} /> : null}
                  {children(preview)}
                </PortalShell>
              ) : children(preview)}
            </PreviewSurfaceProvider>
          </div>
        </WithCurrencyDirectory>
      </WithOrganisationName>
    )}
  </ScreenState>;
}

/** The preview surface a page opened, as the shell view it is. The job's report sits under Reports, as in the mockup. */
const SHELL_VIEW: Record<PortalPreviewSurface, ShellView> = { home: "dashboard", dashboard: "dashboard", data: "data", report: "reports", reports: "reports", actions: "actions", srs: "srs", metrics: "metrics", messages: "messages", files: "files", insights: "insights" };
