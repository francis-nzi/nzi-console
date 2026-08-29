import type { ScopeRowReadModel } from "@nzi/contracts";

export type ScopeRegisterFilter = "attention" | "calculation" | "quality" | "review" | "rejected" | "all";

export function scopeRowNeedsAttention(row: ScopeRowReadModel): boolean {
  return row.enabled && ((row.calculatedTco2e === null && row.overrideTco2e === null) || row.qualityTier === null || row.reviewStatus !== "approved");
}

export function filterScopeRows(rows: ScopeRowReadModel[], filter: ScopeRegisterFilter): ScopeRowReadModel[] {
  if (filter === "all") return rows;
  if (filter === "attention") return rows.filter(scopeRowNeedsAttention);
  if (filter === "calculation") return rows.filter((row) => row.enabled && row.calculatedTco2e === null && row.overrideTco2e === null);
  if (filter === "quality") return rows.filter((row) => row.enabled && row.qualityTier === null);
  if (filter === "rejected") return rows.filter((row) => row.enabled && row.reviewStatus === "rejected");
  return rows.filter((row) => row.enabled && row.reviewStatus !== "approved");
}
