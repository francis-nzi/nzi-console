import { PreviewFrame } from "../PreviewFrame";
import { FilesPreview } from "../../../../portal/files/FilesPreview";

export const dynamic = "force-dynamic";

/** Files as the client will see it — the labelled design preview (no file store yet). */
export default async function PortalPreviewFilesPage({ params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = await params;
  return <PreviewFrame clientId={clientId} surface="files">{() => <FilesPreview />}</PreviewFrame>;
}
