// Client portal — the Reports view (BUILD-client-portal-reports; MOCKUP-client-portal.html is the layout spec). The client's index
// of their published disclosures, grouped by state, each entry routing into what already exists: the job's published report (the
// composed document and its approval card), the version-bound PDF, the report's evidence. Kept pure so every grouping, label,
// route and guard is tested without a browser. It reads only the client's copy of each report (`/published-report`, which
// applies `clientFacingPublishedReport`) and the composition route's verdict (`portalReportViewOf`); no money reaches it (NZC-120).
import type { ClientFacingPublishedCrpReport } from "@nzi/contracts";
import type { PortalReportApproval } from "@nzi/isolated-backend";
import { isPortalReportApproval, isPublishedCrpReport } from "./jobs/[jobId]/publishedReportValidation";
import type { PortalReportView } from "./portalReportView";

/** What the issued document is, as the composition route says — the same three states the report page draws. */
export type ReportDocument = { kind: "composed"; renderer: string } | { kind: "pre-composition" } | { kind: "unreadable" };

/** One published report version, as the client may see it. */
export type PortalReportEntry = {
  jobId: string;
  jobNumber: string;
  reportingYear: number;
  reportVersionId: string;
  /** The scope this version was issued at, when the job has more than one published scope; else null. */
  scopeLabel: string | null;
  publishedAt: string;
  snapshotId: string;
  evidenceHash: string;
  /** Whether the client's own logo was frozen onto this version (composed@5's cover draws it). */
  clientLogoOnCover: boolean;
  /** This user's approval of this exact version, or null. */
  approvedAt: string | null;
  document: ReportDocument;
};

/** The composition route's verdict, as a document kind. `failed` is unreadable: nothing is drawn and nothing can be approved unseen. */
export function documentOf(view: PortalReportView): ReportDocument {
  if (view.state === "composed") return { kind: "composed", renderer: view.composition.renderer?.trim() || "composed@1" };
  if (view.state === "pre-composition") return { kind: "pre-composition" };
  return { kind: "unreadable" };
}

/** `/published-report?reportVersionId=` — the client copy and this user's approval of it, verified as the report page verifies them. */
export function readPublishedReport(body: unknown, expected: { jobId: string; reportVersionId: string }): { report: ClientFacingPublishedCrpReport; approval: PortalReportApproval | null } | null {
  if (!body || typeof body !== "object") return null;
  const value = body as { report?: unknown; approval?: unknown };
  if (!isPublishedCrpReport(value.report, expected.jobId) || value.report.reportVersionId !== expected.reportVersionId) return null;
  if (value.approval !== null && !isPortalReportApproval(value.approval, expected.reportVersionId)) return null;
  return { report: value.report, approval: value.approval as PortalReportApproval | null };
}

/** The job's published scopes, as `/published-report` lists them for its switcher (`reports`). */
export function publishedScopesOf(body: unknown): Array<{ reportVersionId: string; scopeLabel: string }> | null {
  const reports = body && typeof body === "object" ? (body as { reports?: unknown }).reports : undefined;
  if (!Array.isArray(reports) || reports.length === 0) return null;
  const valid = reports.every((entry) => entry && typeof entry === "object" && typeof entry.reportVersionId === "string" && entry.reportVersionId !== "" && typeof entry.scopeLabel === "string");
  return valid ? reports.map((entry) => ({ reportVersionId: entry.reportVersionId, scopeLabel: entry.scopeLabel })) : null;
}

export function reportEntry(input: { report: ClientFacingPublishedCrpReport; approval: PortalReportApproval | null; view: PortalReportView; scopeLabel: string | null }): PortalReportEntry {
  const { report } = input;
  return {
    jobId: report.snapshot.jobId, jobNumber: report.snapshot.jobNumber, reportingYear: report.snapshot.reportingYear,
    reportVersionId: report.reportVersionId, scopeLabel: input.scopeLabel, publishedAt: report.publishedAt,
    snapshotId: report.snapshot.id, evidenceHash: report.dataHash, clientLogoOnCover: Boolean(report.clientLogoAssetId),
    approvedAt: input.approval?.approvedAt ?? null, document: documentOf(input.view),
  };
}

/** A job whose report could not be read: said by name, never left out silently. */
export type UnreadJob = { jobId: string; jobNumber: string; reportingYear: number | null };

/**
 * The mockup's groups: awaiting this user's approval, and issued (approved). Newest reporting year first, then the most recently
 * published. "Uploaded · previous system" is not here: no portal surface lists NZI-added legacy files yet (raised in the PR).
 */
export function reportGroups(entries: readonly PortalReportEntry[]): { awaiting: PortalReportEntry[]; issued: PortalReportEntry[] } {
  const order = [...entries].sort((a, b) => b.reportingYear - a.reportingYear || b.publishedAt.localeCompare(a.publishedAt) || a.reportVersionId.localeCompare(b.reportVersionId));
  return { awaiting: order.filter((entry) => entry.approvedAt === null), issued: order.filter((entry) => entry.approvedAt !== null) };
}

/** The existing guards, read through this entry point: an unreadable report cannot be approved unseen. */
export const approvable = (entry: PortalReportEntry) => entry.approvedAt === null && entry.document.kind !== "unreadable";

const job = (entry: PortalReportEntry) => `/portal/jobs/${encodeURIComponent(entry.jobId)}`;
const version = (entry: PortalReportEntry) => `reportVersionId=${encodeURIComponent(entry.reportVersionId)}`;
/** The job's published report, the version in view — where the composed document and its approval card are. */
export const reportHref = (entry: PortalReportEntry) => `${job(entry)}?report=${encodeURIComponent(entry.reportVersionId)}`;
/** Review & approve: the same page, at the existing approval card (`#client-approval`). No approval is made from the index. */
export const approveHref = (entry: PortalReportEntry) => `${reportHref(entry)}#client-approval`;
/** The version-bound PDF the deliverables route serves. */
export const pdfHref = (entry: PortalReportEntry) => `/api/portal/jobs/${encodeURIComponent(entry.jobId)}/deliverables/report?${version(entry)}`;

/** The line under the title: the year, the document, and what is on its cover. */
export function documentLine(entry: PortalReportEntry): string {
  const parts = [`FY${entry.reportingYear}`];
  if (entry.scopeLabel) parts.push(entry.scopeLabel);
  if (entry.document.kind === "composed") parts.push(`${entry.document.renderer} document`, ...(entry.clientLogoOnCover ? ["your logo on the cover"] : []));
  else if (entry.document.kind === "pre-composition") parts.push("issued before reports were frozen in full");
  else parts.push("this report could not be loaded");
  if (entry.approvedAt !== null) parts.push("approved & issued");
  return parts.join(" · ");
}
