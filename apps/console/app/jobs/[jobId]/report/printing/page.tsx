import { notFound } from "next/navigation";
import { hasData, type ReportComposition, type ScreenResult } from "@nzi/contracts";
import { loadScreen } from "../../../../lib/loadScreen";
import { ScreenState } from "../../../../lib/ScreenState";
import { reportFeatureEnabled } from "../../../../lib/reportFlags";
import { ReportStudioEmpty, ReportStudioFrame, ReportStudioPrinting } from "../ReportStudio";
import { pickStudioVersion, type StudioRegisterRow } from "../studio";
import "../../../../reports/[versionId]/report-composed.css";
import "../report-studio.css";

export const dynamic = "force-dynamic";

/**
 * B2-1 (RULING-report-studio-B2): Report Printing for one job — its newest validated or published version, drawn by the composed
 * renderer from what that version froze (published) or would freeze (validated, the B0 preview). It reads the register and the
 * composition, and nothing else; it composes, validates and writes nothing. Behind `report-sections`, the composed report's own
 * flag, so it appears wherever the composed report already does.
 */
export default async function ReportPrintingPage({ params, searchParams }: { params: Promise<{ jobId: string }>; searchParams: Promise<{ version?: string }> }) {
  if (!reportFeatureEnabled("report-sections")) notFound();
  const { jobId } = await params;
  const { version: wanted } = await searchParams;
  const register = await loadScreen<{ reports: StudioRegisterRow[] }>("reports", { reports: [] }, "report-versions");
  // A register that could not be read is said as such, inside the studio — never shown as "nothing to print".
  if (!hasData(register) && register.state !== "empty") return <Unavailable jobId={jobId} result={register} />;
  const version = pickStudioVersion(hasData(register) ? register.data.reports : [], jobId, wanted);
  if (!version) return <ReportStudioEmpty jobId={jobId} />;
  const id = encodeURIComponent(version.reportVersionId);
  // Published: what the version froze. Validated: what publish would freeze (B0's preview, composed READ ONLY, stored nowhere).
  const composition = version.status === "published"
    ? await loadScreen<Composed>("reportComposition", { composition: null }, `report-versions/${id}/composition`)
    : await loadScreen<Composed>("reportCompositionPreview", { preview: null }, `report-versions/${id}/composition/preview`);
  if (!hasData(composition)) return <Unavailable jobId={jobId} result={composition} />;
  const drawn = composition.data.composition ?? composition.data.preview?.composition ?? null;
  return drawn ? <ReportStudioPrinting jobId={jobId} version={version} composition={drawn} /> : <ReportStudioEmpty jobId={jobId} />;
}

/** The one shape both reads answer in: the frozen composition, or the preview of one. */
type Composed = { composition?: ReportComposition | null; preview?: { composition: ReportComposition } | null };

function Unavailable({ jobId, result }: { jobId: string; result: ScreenResult<unknown> }) {
  return <ReportStudioFrame jobId={jobId} page="printing"><ScreenState result={result}>{() => null}</ScreenState></ReportStudioFrame>;
}
