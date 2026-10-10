// Reporting F-4b (RULING-reporting-F4): what the portal draws for a published report.
//   composed        — the frozen composition (every version issued since 0077): the client sees exactly what was issued,
//                     sections left out are absent, and the Methodology says which.
//   pre-composition — a version issued before compositions were frozen (D1): its snapshot render, labelled, never backfilled.
//   failed          — the composition could not be read or verified. Nothing is drawn in its place: falling back to the
//                     snapshot would show sections the report left out (the honesty trap the exclusion interlock exists for).
import type { ReportComposition } from "@nzi/contracts";

export type PortalReportView =
  | { state: "composed"; composition: ReportComposition }
  | { state: "pre-composition" }
  | { state: "failed"; message: string };

export const PRE_COMPOSITION_LABEL = "Issued before reports were frozen in full";

/** The composition route's answer, checked against the report it was asked for — or `failed`, never a guess. */
export function portalReportViewOf(body: unknown, expected: { reportVersionId: string; jobId: string }): PortalReportView {
  const failed: PortalReportView = { state: "failed", message: "The issued report could not be verified." };
  if (!body || typeof body !== "object") return failed;
  const value = body as { state?: unknown; reportVersionId?: unknown; composition?: unknown };
  if (value.reportVersionId !== expected.reportVersionId) return failed;
  if (value.state === "pre-composition") return { state: "pre-composition" };
  if (value.state !== "composed" || !value.composition || typeof value.composition !== "object") return failed;
  const composition = value.composition as Partial<ReportComposition>;
  if (composition.reportVersionId !== expected.reportVersionId || composition.jobId !== expected.jobId) return failed;
  return { state: "composed", composition: composition as ReportComposition };
}

/** The issuer logo a portal user may load: the grant-checked portal route (D4), never the staff one. */
export const portalIssuerLogoSrc = (jobId: string) => (assetId: string) =>
  `/api/portal/jobs/${encodeURIComponent(jobId)}/published-report/issuer-logo?asset=${encodeURIComponent(assetId)}`;
