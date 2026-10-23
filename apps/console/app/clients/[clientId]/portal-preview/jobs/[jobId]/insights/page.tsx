import { PreviewFrame } from "../../../PreviewFrame";
import { PortalInsights } from "../../../../../../portal/insights/PortalInsights";

export const dynamic = "force-dynamic";

/** Insights & Help as the client sees them — through the preview's mirror of the dashboard read (#506). */
export default async function PortalPreviewInsightsPage({ params }: { params: Promise<{ clientId: string; jobId: string }> }) {
  const { clientId, jobId } = await params;
  return <PreviewFrame clientId={clientId} jobId={jobId} surface="insights">{() => <PortalInsights jobId={jobId} />}</PreviewFrame>;
}
