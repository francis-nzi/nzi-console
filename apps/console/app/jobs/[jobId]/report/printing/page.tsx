import { notFound } from "next/navigation";
import { decodeStudioPlan, decodeStudioScope, hasData, type ReportComposition, type ScreenResult } from "@nzi/contracts";
import type { ReportDraftComposition } from "@nzi/isolated-backend";
import { loadScreen } from "../../../../lib/loadScreen";
import { ScreenState } from "../../../../lib/ScreenState";
import { reportFeatureEnabled } from "../../../../lib/reportFlags";
import { ReportStudioEmpty, ReportStudioFrame, ReportStudioPrinting } from "../ReportStudio";
import { pickStudioVersion, studioDraftQuery, type StudioRegisterRow } from "../studio";
import "../../../../reports/[versionId]/report-composed.css";
import "../../../../reports/[versionId]/report-composed5.css";
import "../report-studio.css";

export const dynamic = "force-dynamic";

/**
 * Report Printing for one job (B2-1; RULING-report-studio-B2). Its newest validated or published version, drawn by the composed
 * renderer from what that version froze (published) or would freeze (validated, the B0 preview). With neither, the job's
 * **draft** (B2-2): what validate would hold for its latest approved snapshot with the plan and scope in the URL, composed READ
 * ONLY and stored nowhere. The page itself only reads; the rail's changes go through the governed commands. Behind
 * `report-sections`, the composed report's own flag, so it appears wherever the composed report already does.
 */
export default async function ReportPrintingPage({ params, searchParams }: {
  params: Promise<{ jobId: string }>; searchParams: Promise<{ version?: string; plan?: string; scope?: string }>;
}) {
  if (!reportFeatureEnabled("report-sections")) notFound();
  const { jobId } = await params;
  const { version: wanted, plan, scope } = await searchParams;
  const register = await loadScreen<{ reports: StudioRegisterRow[] }>("reports", { reports: [] }, "report-versions");
  // A register that could not be read is said as such, inside the studio — never shown as "nothing to print".
  if (!hasData(register) && register.state !== "empty") return <Unavailable jobId={jobId} result={register} />;
  const version = pickStudioVersion(hasData(register) ? register.data.reports : [], jobId, wanted);
  if (!version) {
    // No version yet: the draft, re-encoded so only a well-formed plan and scope reach the read.
    const query = studioDraftQuery({ plan: decodeStudioPlan(plan), scope: decodeStudioScope(scope) });
    const drafted = await loadScreen<{ draft: ReportDraftComposition | null }>("reportDraft", { draft: null }, `jobs/${encodeURIComponent(jobId)}/report-draft${query}`);
    if (!hasData(drafted)) return <Unavailable jobId={jobId} result={drafted} />;
    if (!drafted.data.draft) return <ReportStudioEmpty jobId={jobId} />;
    const { composition, ...draft } = drafted.data.draft;
    return <ReportStudioPrinting jobId={jobId} version={null} composition={composition} draft={draft} />;
  }
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
