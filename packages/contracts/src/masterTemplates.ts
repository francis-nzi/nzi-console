// Data-entry templates R1 (0197, ruled 29 Oct 2026) — the organisation's master templates: `Master · Default`,
// `Master · Construction`, `Master · Office`. The shape of a client's reporting template (0159) — scope → category →
// lines — held on the organisation: site-agnostic, no dataset (a line names its factor by identity, resolved to a job's
// editions when it is seeded), and never a quantity.
import type { ReportingTemplateScope } from "./reportingTemplate";

/** One line as `master.template.rows.set` takes it: the whole set is sent, so each line is sent whole. */
export type MasterTemplateRowInput = {
  scope: ReportingTemplateScope;
  /** Required: a master is curated, so nothing in it is "to categorise". */
  categoryCode: string;
  sourceLabel: string;
  reportLabel: string | null;
  /** The activity by its factor's identity (0125), or null for a category shell (a PG&S line). */
  factorId: string | null;
  unit: string | null;
};

export type MasterTemplateRow = MasterTemplateRowInput & {
  rowId: string;
  ordering: number;
  /** Read for display: the category's name and the factor's curated label. */
  categoryName: string | null;
  factorLabel: string | null;
};

export type MasterTemplate = {
  masterId: string;
  /** The `<Type>`; shown through `masterTemplateTitle`. */
  name: string;
  active: boolean;
  archivedReason: string | null;
  /** The version of the lines in force; 0 until lines are first set. */
  rowsVersion: number;
  /** The header's own version — every command's expectedVersion. */
  version: number;
  updatedBy: string;
  updatedAt: string;
  rows: MasterTemplateRow[];
};

/** An activity a master line may name: one factor identity, with the scopes and unit its newest edition gives it. */
export type MasterTemplateFactorOption = { factorId: string; label: string; unit: string | null; scopes: string[] };

/** The admin screen's read: every master (active first), the categories a line is filed under, and the activities on offer. */
export type MasterTemplatesReadModel = {
  masters: MasterTemplate[];
  categories: Array<{ code: string; scope: ReportingTemplateScope; name: string }>;
  factors: MasterTemplateFactorOption[];
};

export const MASTER_TEMPLATE_NAME_MAX = 80;
/** The naming convention (ruled 29 Oct): `Master · <Type>` — on the admin screen, in the seed summary, on the job. */
export const masterTemplateTitle = (name: string): string => `Master · ${name}`;

/**
 * Whether a factor serves a line's category: its scopes carry the category's row scope — `1` or `2` for Scopes 1 and 2,
 * the category's own code (`3.6`) for Scope 3 — the same test the capture accordion's quick-add applies to a job's options.
 */
export function masterFactorServes(option: Pick<MasterTemplateFactorOption, "scopes">, line: { scope: ReportingTemplateScope; categoryCode: string | null }): boolean {
  const rowScope = line.scope === "3" ? line.categoryCode : line.scope;
  return rowScope !== null && option.scopes.includes(rowScope);
}

/** Group the lines by scope, then category, keeping their order within each. */
export function groupMasterTemplateRows(rows: MasterTemplateRow[]): Array<{ scope: ReportingTemplateScope; categories: Array<{ categoryCode: string; categoryName: string | null; rows: MasterTemplateRow[] }> }> {
  const scopes: ReportingTemplateScope[] = ["1", "2", "3"];
  return scopes.map((scope) => {
    const inScope = rows.filter((row) => row.scope === scope).sort((a, b) => a.ordering - b.ordering);
    const keys: string[] = [];
    for (const row of inScope) if (!keys.includes(row.categoryCode)) keys.push(row.categoryCode);
    return {
      scope,
      categories: keys.map((categoryCode) => {
        const categoryRows = inScope.filter((row) => row.categoryCode === categoryCode);
        return { categoryCode, categoryName: categoryRows[0]?.categoryName ?? null, rows: categoryRows };
      }),
    };
  }).filter((group) => group.categories.length > 0);
}
