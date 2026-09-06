import type { ScopeRowReadModel } from "@nzi/contracts";

export type ScopeRegisterFilter = "attention" | "calculation" | "quality" | "review" | "rejected" | "all";

export function scopeRowNeedsAttention(row: ScopeRowReadModel): boolean {
  return row.enabled && ((row.calculatedTco2e === null && row.overrideTco2e === null) || row.qualityTier === null || row.reviewStatus !== "approved");
}

/**
 * The row the detail drawer shows. Resolved against the WHOLE register first —
 * a row opened from the category accordion or a re-homed adapter is frequently
 * not in the flat register's current filter, and must still open, never snap to
 * `visibleRows[0]` (data-entry UX review, item 1). Falls back to the first
 * visible row, then the first row overall, so an empty selection still lands
 * somewhere sensible.
 */
export function resolveSelectedScopeRow(
  rows: ScopeRowReadModel[],
  visibleRows: ScopeRowReadModel[],
  selectedId: string,
): ScopeRowReadModel | undefined {
  return rows.find((row) => row.id === selectedId) ?? visibleRows[0] ?? rows[0];
}

export function filterScopeRows(rows: ScopeRowReadModel[], filter: ScopeRegisterFilter): ScopeRowReadModel[] {
  if (filter === "all") return rows;
  if (filter === "attention") return rows.filter(scopeRowNeedsAttention);
  if (filter === "calculation") return rows.filter((row) => row.enabled && row.calculatedTco2e === null && row.overrideTco2e === null);
  if (filter === "quality") return rows.filter((row) => row.enabled && row.qualityTier === null);
  if (filter === "rejected") return rows.filter((row) => row.enabled && row.reviewStatus === "rejected");
  return rows.filter((row) => row.enabled && row.reviewStatus !== "approved");
}
