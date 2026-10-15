import {
  isReportDataSection, isReportGap, reportCompositionSectionMeta, reportSectionLayout, reportSectionPlanOf,
  type ReportComposition, type ReportCompositionSectionKey, type ReportStage,
} from "@nzi/contracts";

/**
 * B2-1 (RULING-report-studio-B2): the Report Studio's reads, as pure functions — which of a job's report versions the studio
 * shows, and the section rail drawn from that version's own plan. Display only: nothing here composes, validates or writes.
 */

/** The fields of a register row the studio reads (`ReportVersionRegisterItem`). */
export type StudioRegisterRow = {
  reportVersionId: string; jobId: string; status: "draft" | "validated" | "published" | "superseded";
  createdAt: string; publishedAt: string | null; scopeLabel: string;
};

export type StudioVersion = { reportVersionId: string; status: "validated" | "published"; createdAt: string; publishedAt: string | null; scopeLabel: string };

/**
 * The job's version the studio opens: its newest validated or published one. A published version is the issued report; a
 * validated one is previewed exactly as publish would freeze it (B0). Superseded and draft versions are never opened — the
 * first is no longer the report, the second has nothing composed. A version asked for by id (the register's row link) is
 * opened when it is one of these and this job's — never another job's. Null: nothing to show yet (preparation comes first).
 */
export function pickStudioVersion(register: readonly StudioRegisterRow[], jobId: string, wanted?: string | null): StudioVersion | null {
  const open = register.filter((row): row is StudioRegisterRow & { status: "validated" | "published" } =>
    row.jobId === jobId && (row.status === "validated" || row.status === "published"));
  const newest = (wanted ? open.find((row) => row.reportVersionId === wanted) : undefined)
    ?? [...open].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.reportVersionId.localeCompare(a.reportVersionId))[0];
  return newest ? { reportVersionId: newest.reportVersionId, status: newest.status, createdAt: newest.createdAt, publishedAt: newest.publishedAt, scopeLabel: newest.scopeLabel } : null;
}

export type StudioRailRow = {
  key: ReportCompositionSectionKey;
  title: string;
  /** The number the document gives it ("01"); null for the cover, and for a section not drawn. */
  number: string | null;
  /** In the version's plan. */
  included: boolean;
  /** Drawn in this document: included, and with something to draw (a report with no site breakdown has no Sites page). */
  drawn: boolean;
  /** Why an included section is not drawn, or why it is out. */
  note: string | null;
};

/**
 * The rail: the version's data sections in its plan's order, numbered exactly as the composed document numbers them — the same
 * `reportSectionLayout` over the same "present" test the renderer uses — so a row and the page it names cannot disagree.
 * Narrative sections are not rows yet: no composed renderer draws them (RULING-report-studio-B2, F1 pending).
 */
export function studioRail(composition: ReportComposition): StudioRailRow[] {
  const plan = reportSectionPlanOf(composition);
  const hasSites = !isReportGap(composition.emissions) && (composition.emissions.sites?.length ?? 0) > 0;
  const present = (key: string) => isReportDataSection(key) && (key !== "sites" || hasSites);
  const numbers = new Map(reportSectionLayout(plan, present).map((entry) => [entry.key, entry.number]));
  return plan.filter((entry) => isReportDataSection(entry.key)).map((entry) => {
    const key = entry.key as ReportCompositionSectionKey;
    const drawn = numbers.has(key);
    return {
      key, title: reportCompositionSectionMeta[key].title, number: numbers.get(key) ?? null, included: entry.included, drawn,
      note: !entry.included ? "Left out of this report" : drawn ? null : "Nothing to draw: this report has no site breakdown",
    };
  });
}

/**
 * Whether a job has a report the studio can draw: a validated version ("ready to publish") or a published one (awaiting the
 * client, changes requested, client approved). Earlier stages have nothing composed to print yet.
 */
export const studioHasReport = (stage: ReportStage): boolean =>
  stage === "ready-to-publish" || stage === "awaiting-client" || stage === "changes-requested" || stage === "client-approved";

/** The rail's legend, as the mockup states it. Under B2-1 every drawn section's figures are locked to the frozen snapshot. */
export const studioRailLegend = [
  { status: "default", label: "Default template" },
  { status: "edited", label: "Edited by client" },
  { status: "ai", label: "AI-drafted" },
  { status: "locked", label: "Figures locked to data" },
] as const;

