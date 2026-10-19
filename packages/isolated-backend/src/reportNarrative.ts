import { reportNarrativeBodyIssues, reportNarrativeDrawnKeys, type ReportNarrativeElement, type ReportSectionPlan } from "@nzi/contracts";
import { listReportSections } from "./readModels";
import type { Queryable } from "./postgres";

/**
 * B2-4 (RULING-report-studio-B2-4): the narrative a version will issue — what `report.validate` freezes onto it (0169), and what
 * the Report Studio's draft composes with, so the draft shows exactly what validating would freeze. Read from the job's working
 * sections (a working row, else the catalogue template: the working store is the editable source, the snapshot payload the seal),
 * for each narrative section the plan draws, in catalogue order, each with the section version it was taken at.
 *
 * `issues`: a body that breaks the narrative rule — a typed figure, money, an unknown token — can be held by a section edited
 * before the rule; it is said here, by section, so validate refuses it and the draft shows it as a blocker. It is never issued.
 */
export async function resolveReportNarrative(db: Queryable, jobId: string, plan: ReportSectionPlan): Promise<{
  narrative: ReportNarrativeElement[];
  issues: Array<{ field: string; code: string; message: string }>;
}> {
  const drawn = reportNarrativeDrawnKeys(plan);
  const sections = (await listReportSections(db, jobId)).filter((section) => drawn.has(section.key));
  const narrative = sections.map((section) => ({ key: section.key, bodyHtml: section.bodyHtml, contentSource: section.contentSource, sectionVersion: section.version }));
  const issues = sections.flatMap((section) => reportNarrativeBodyIssues(section.bodyHtml)
    .map((issue) => ({ field: `narrative.${section.key}`, code: issue.code, message: `${section.title}: ${issue.message}` })));
  return { narrative, issues };
}
