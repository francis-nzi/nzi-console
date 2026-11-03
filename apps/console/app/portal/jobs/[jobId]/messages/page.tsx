import { redirect } from "next/navigation";
import { portalFeatureEnabled } from "../../../../lib/portalFlags";
import { MessagesView } from "../../../messages/MessagesView";
import { PortalShellClient } from "../../../shell/PortalShellClient";

export const dynamic = "force-dynamic";

/** Messages (BUILD-portal-shell-lookandfeel R7; RULING-portal-messages): the Conversations lane behind `portal-conversations`, else the report thread it has been. A shell view only. */
export default async function PortalMessagesPage({ params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  if (!portalFeatureEnabled("portal-shell")) redirect("/portal");
  return <PortalShellClient view="messages" jobId={jobId}><MessagesView jobId={jobId} /></PortalShellClient>;
}
