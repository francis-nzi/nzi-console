import { notFound } from "next/navigation";
import type { PortalPreviewReadModel } from "@nzi/isolated-backend";
import { loadScreen } from "../../../lib/loadScreen";
import { ScreenState } from "../../../lib/ScreenState";
import { PortalPreview } from "./PortalPreview";

export const dynamic = "force-dynamic";

/**
 * `/clients/{id}/portal-preview` — the staff view of a client's portal.
 *
 * Authorisation is the API's, not this page's: `support.portal_impersonate` plus the client-scope
 * check, both resolved against the database in `getPortalPreview`. A staff member without the
 * capability gets a 403 here even if they type the URL, and the entry point they never saw is a
 * convenience rather than the control.
 *
 * A failed load renders as failed. The portal's own rule applies to its preview: a read that did
 * not work must never render as a client with nothing planned.
 */
const NO_PREVIEW = null as unknown as PortalPreviewReadModel;

export default async function PortalPreviewPage({ params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = await params;
  const result = await loadScreen<PortalPreviewReadModel>(
    "portalPreview", NO_PREVIEW, `clients/${encodeURIComponent(clientId)}/portal-preview`);
  if (result.state === "failed" && result.error.code === "HTTP_404") notFound();

  return <ScreenState result={result}>
    {(preview: PortalPreviewReadModel) => <PortalPreview preview={preview} />}
  </ScreenState>;
}
