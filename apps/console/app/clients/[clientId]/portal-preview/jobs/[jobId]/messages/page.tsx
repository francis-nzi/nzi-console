import { PreviewFrame } from "../../../PreviewFrame";
import { PortalMessages } from "../../../../../../portal/messages/PortalMessages";

export const dynamic = "force-dynamic";

/** Messages as the client sees them — the report threads, read only through the preview's GET-only mirror (no reply, no read receipt). */
export default async function PortalPreviewMessagesPage({ params }: { params: Promise<{ clientId: string; jobId: string }> }) {
  const { clientId, jobId } = await params;
  return <PreviewFrame clientId={clientId} jobId={jobId} surface="messages">
    {() => <PortalMessages jobId={jobId} />}
  </PreviewFrame>;
}
