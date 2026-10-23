import { redirect } from "next/navigation";
import { portalFeatureEnabled } from "../../../../lib/portalFlags";
import { PortalMessages } from "../../../messages/PortalMessages";
import { PortalShellClient } from "../../../shell/PortalShellClient";

export const dynamic = "force-dynamic";

/** Messages (BUILD-portal-shell-lookandfeel R7) — the existing report thread, an early version. A shell view only. */
export default async function PortalMessagesPage({ params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  if (!portalFeatureEnabled("portal-shell")) redirect("/portal");
  return <PortalShellClient view="messages" jobId={jobId}><PortalMessages jobId={jobId} /></PortalShellClient>;
}
