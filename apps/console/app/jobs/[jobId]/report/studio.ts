import {
  encodeStudioPlan, encodeStudioScope, isMovableReportSection, isOptionalReportSection, isReportDataSection, isReportGap,
  isReportStandaloneNarrativeSection, REPORT_SECTION_EXCLUSION_AVAILABLE, reportComposed4Sections, reportPlanSectionTitle, reportRendererOf,
  reportSectionLayout, reportSectionMetaFor, reportSectionPlanOf,
  type ReportComposition, type ReportCompositionSectionKey, type ReportScope, type ReportSectionPlan, type ReportStage,
} from "@nzi/contracts";
import { COMPOSED5_TITLES, composed5Draws } from "../../../reports/[versionId]/ReportComposedV5";

/**
 * The Report Studio's reads, as pure functions — which of a job's report versions the studio shows (B2-1), the section rail
 * drawn from a plan (B2-1), and what each row lets the rail change (B2-2). Nothing here composes, validates or writes: the
 * rail's changes reach a report only through the governed commands (`report.validate`, `report.sectionPlan.update`).
 */

/** The fields of a register row the studio reads (`ReportVersionRegisterItem`). */
export type StudioRegisterRow = {
  reportVersionId: string; jobId: string; status: "draft" | "validated" | "published" | "superseded";
  createdAt: string; publishedAt: string | null; scopeLabel: string;
  /** The row's version — what `report.sectionPlan.update` and `report.publish` pin. */
  version: number;
};

export type StudioVersion = { reportVersionId: string; status: "validated" | "published"; createdAt: string; publishedAt: string | null; scopeLabel: string; version: number };

/**
 * The job's version the studio opens: its newest validated or published one. A published version is the issued report; a
 * validated one is previewed exactly as publish would freeze it (B0). Superseded and draft versions are never opened — the
 * first is no longer the report, the second has nothing composed. A version asked for by id (the register's row link) is
 * opened when it is one of these and this job's — never another job's. Null: no version yet (the studio then shows a draft).
 */
export function pickStudioVersion(register: readonly StudioRegisterRow[], jobId: string, wanted?: string | null): StudioVersion | null {
  const open = register.filter((row): row is StudioRegisterRow & { status: "validated" | "published" } =>
    row.jobId === jobId && (row.status === "validated" || row.status === "published"));
  const newest = (wanted ? open.find((row) => row.reportVersionId === wanted) : undefined)
    ?? [...open].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.reportVersionId.localeCompare(a.reportVersionId))[0];
  return newest ? { reportVersionId: newest.reportVersionId, status: newest.status, createdAt: newest.createdAt, publishedAt: newest.publishedAt, scopeLabel: newest.scopeLabel, version: newest.version } : null;
}

export type StudioRailRow = {
  key: ReportCompositionSectionKey;
  title: string;
  /** The number the document gives it ("01"); null for the cover, and for a section not drawn. */
  number: string | null;
  /** In the plan the rail shows. */
  included: boolean;
  /** Drawn in this document: included, and with something to draw (a report with no site breakdown has no Sites page). */
  drawn: boolean;
  /** Why an included section is not drawn, or why it is out. */
  note: string | null;
  /** B2-2: the rail may move it (never the cover or methodology) and leave it out (never a mandatory section). */
  movable: boolean;
  optional: boolean;
};

/**
 * The rail: the plan's data sections in its order, numbered exactly as the composed document numbers them — the same
 * `reportSectionLayout` over the same "present" test the renderer uses — so a row and the page it names cannot disagree. By
 * default the plan is the composition's own; B2-2 passes the plan being edited, numbered as it would draw. Narrative sections
 * are not rows yet: no composed renderer draws them (they arrive with composed@4, B2-3/B2-4).
 */
export function studioRail(composition: ReportComposition, plan: ReportSectionPlan = reportSectionPlanOf(composition)): StudioRailRow[] {
  const hasSites = !isReportGap(composition.emissions) && (composition.emissions.sites?.length ?? 0) > 0;
  // The renderer's own "present" test and titles (B2-3): composed@4 draws its further sections by its own headings; earlier
  // renderers never draw them.
  const renderer = reportRendererOf(composition), meta = reportSectionMetaFor(composition);
  const v4 = renderer === "composed@4", v5 = renderer === "composed@5";
  // composed@5 numbers by its own "draws" test and heads by its own titles, its standalone narrative sections included.
  const present = v5
    ? (key: string) => composed5Draws(key) && (key !== "sites" || hasSites)
    : (key: string) => isReportDataSection(key) && (key !== "sites" || hasSites) && (v4 || !reportComposed4Sections.includes(key));
  const numbers = new Map(reportSectionLayout(plan, present).map((entry) => [entry.key, entry.number]));
  return plan.filter((entry) => isReportDataSection(entry.key) || (v5 && isReportStandaloneNarrativeSection(entry.key))).map((entry) => {
    const key = entry.key as ReportCompositionSectionKey;
    const drawn = numbers.has(key);
    return {
      key, title: (v5 ? COMPOSED5_TITLES[key] : undefined) ?? meta[key]?.title ?? reportPlanSectionTitle(entry.key), number: numbers.get(key) ?? null, included: entry.included, drawn,
      note: !entry.included ? "Left out of this report" : drawn ? null : "Nothing to draw: this report has no site breakdown",
      movable: isMovableReportSection(key), optional: REPORT_SECTION_EXCLUSION_AVAILABLE && isOptionalReportSection(key),
    };
  });
}

/** Two plans hold the same sections, in the same order, in or out alike. */
export const samePlan = (a: ReportSectionPlan, b: ReportSectionPlan): boolean =>
  a.length === b.length && a.every((entry, index) => entry.key === b[index]!.key && entry.included === b[index]!.included);

/**
 * B2-2: the draft read with a plan and scope — the rail's choice carried in the URL, so the server composes the draft it shows
 * (`/api/isolated/jobs/{jobId}/report-draft`). An unchanged choice is left out, so validate's own fallbacks apply.
 */
export function studioDraftQuery(choice: { plan?: ReportSectionPlan | null; scope?: ReportScope | null }): string {
  const query = new URLSearchParams();
  if (choice.plan) query.set("plan", encodeStudioPlan(choice.plan));
  if (choice.scope && choice.scope.kind !== "whole") query.set("scope", encodeStudioScope(choice.scope));
  const text = query.toString();
  return text ? `?${text}` : "";
}

/**
 * Whether a job has a report the studio can draw: since B2-2, an approved snapshot with no version yet ("ready to validate" —
 * its draft), a validated version ("ready to publish") or a published one (awaiting the client, changes requested, client
 * approved). Earlier stages have no approved snapshot to compose from.
 */
export const studioHasReport = (stage: ReportStage): boolean =>
  stage === "ready-to-validate" || stage === "ready-to-publish" || stage === "awaiting-client" || stage === "changes-requested" || stage === "client-approved";

/** The rail's legend, as the mockup states it. Every drawn data section's figures are locked to the frozen snapshot. */
export const studioRailLegend = [
  { status: "default", label: "Default template" },
  { status: "edited", label: "Edited by client" },
  { status: "ai", label: "AI-drafted" },
  { status: "locked", label: "Figures locked to data" },
] as const;
