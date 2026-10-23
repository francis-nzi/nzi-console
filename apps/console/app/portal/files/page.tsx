import { redirect } from "next/navigation";
import { portalFeatureEnabled } from "../../lib/portalFlags";
import { FilesPreview } from "./FilesPreview";
import { PortalShellClient } from "../shell/PortalShellClient";

export const dynamic = "force-dynamic";

/** Files (BUILD-portal-shell-lookandfeel R4): a labelled design preview — no file store yet. A shell view only. */
export default function PortalFilesPage() {
  if (!portalFeatureEnabled("portal-shell")) redirect("/portal");
  return <PortalShellClient view="files"><FilesPreview /></PortalShellClient>;
}
