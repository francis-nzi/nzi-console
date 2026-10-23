import { redirect } from "next/navigation";
import { portalFeatureEnabled } from "../../lib/portalFlags";
import { PortalReadiness } from "../PortalReadiness";
import { PortalShellClient } from "../shell/PortalShellClient";

export const dynamic = "force-dynamic";

/** SRS Readiness (BUILD-portal-shell-lookandfeel R2): the client's readiness statement, in the shell. A shell view only. */
export default function PortalSrsPage() {
  if (!portalFeatureEnabled("portal-shell") || !portalFeatureEnabled("portal-readiness")) redirect("/portal");
  return <PortalShellClient view="srs"><PortalReadiness /></PortalShellClient>;
}
