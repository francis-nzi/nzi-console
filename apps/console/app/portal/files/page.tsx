import { redirect } from "next/navigation";
import { portalFeatureEnabled } from "../../lib/portalFlags";
import { FilesPreview } from "./FilesPreview";
import { PortalFilesView } from "./PortalFilesView";
import { PortalShellClient } from "../shell/PortalShellClient";

export const dynamic = "force-dynamic";

/**
 * Files. With `portal-files` on (RULING-portal-files-client-ui) the real view over the audited file commands; off, exactly the labelled design
 * preview it has been (BUILD-portal-shell-lookandfeel R4) - nothing is read or written. A shell view only.
 */
export default function PortalFilesPage() {
  if (!portalFeatureEnabled("portal-shell")) redirect("/portal");
  return <PortalShellClient view="files">{portalFeatureEnabled("portal-files") ? <PortalFilesView /> : <FilesPreview />}</PortalShellClient>;
}
