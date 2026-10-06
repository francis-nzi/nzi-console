// Redesign Phase 1c (0159) — the client's reporting template: what the client reports, year to year, held on the
// Client. A version is the whole template — header and lines together. A line is the activity a job captures, never a
// quantity; a line with no category is "to file" (imported from v7's history, which carries none) and is never guessed.

export type ReportingTemplateScope = "1" | "2" | "3";
export type ReportingTemplateOrigin = "manual" | "job" | "v7-import";

/** One line as the command takes it: the whole template is sent, so each line is sent whole. */
export type ReportingTemplateLineInput = {
  scope: ReportingTemplateScope;
  categoryCode: string | null;
  sourceLabel: string;
  reportLabel: string | null;
  siteId: string | null;
  datasetId: string | null;
  factorId: string | null;
  unit: string | null;
};

export type ReportingTemplateLine = ReportingTemplateLineInput & {
  lineId: string;
  ordering: number;
  /** Read for display: the category's name, the site's name and the factor's label, when there is one. */
  categoryName: string | null;
  siteName: string | null;
  factorLabel: string | null;
};

/** The template in force: the highest active version, with its lines in order. Null when none is set or it is withdrawn. */
export type ClientReportingTemplate = {
  version: number;
  origin: ReportingTemplateOrigin;
  /** The job a derived version was built from, by number, for the card's "Initialised from J000612". */
  originJobNumber: string | null;
  setBy: string;
  setAt: string;
  lines: ReportingTemplateLine[];
};

/** The Client's view: the template in force (or null), and the latest version so a write can pass expectedVersion. */
export type ClientReportingTemplateReadModel = {
  current: ClientReportingTemplate | null;
  latestVersion: number;
};

/** The most lines a template may hold — a client's whole reporting structure, with room to spare. */
export const REPORTING_TEMPLATE_MAX_LINES = 500;
export const REPORTING_TEMPLATE_LABEL_MAX = 200;

/** A line's scope, from a category code: `1.natural-gas` → `1`, `3.1` → `3`. */
export const reportingTemplateCategoryScope = (categoryCode: string): string => categoryCode.split(".")[0] ?? "";

/** Group the lines by scope, then by category (uncategorised last, as "to file"), keeping their order within each. */
export function groupReportingTemplateLines(lines: ReportingTemplateLine[]): Array<{ scope: ReportingTemplateScope; categories: Array<{ categoryCode: string | null; categoryName: string | null; lines: ReportingTemplateLine[] }> }> {
  const scopes: ReportingTemplateScope[] = ["1", "2", "3"];
  return scopes.map((scope) => {
    const inScope = lines.filter((line) => line.scope === scope).sort((a, b) => a.ordering - b.ordering);
    const keys: Array<string | null> = [];
    for (const line of inScope) if (!keys.includes(line.categoryCode)) keys.push(line.categoryCode);
    keys.sort((a, b) => (a === null ? 1 : 0) - (b === null ? 1 : 0));
    return {
      scope,
      categories: keys.map((categoryCode) => {
        const categoryLines = inScope.filter((line) => line.categoryCode === categoryCode);
        return { categoryCode, categoryName: categoryLines[0]?.categoryName ?? null, lines: categoryLines };
      }),
    };
  }).filter((group) => group.categories.length > 0);
}
