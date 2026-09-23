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
  // Nothing selected means nothing open.
  //
  // This used to fall back to `visibleRows[0] ?? rows[0]`, which is what put a detail drawer on screen
  // the moment Data entry loaded — a row nobody had clicked, described as if the user had asked for it.
  // The fallback read as helpful and was the long-standing "drawer open at rest" bug.
  //
  // The part worth keeping is the lookup across *all* rows rather than the visible ones: clicking a row
  // that the current lens filters out must still open that row.
  return rows.find((row) => row.id === selectedId);
}

/**
 * The rows one site tab shows.
 *
 * `null` is "all sites" and shows everything. A row with no site is only ever shown under all sites —
 * it belongs to the job rather than to a place, and putting it under a particular site would claim
 * something about it that nobody recorded.
 */
export function filterRowsBySite(
  rows: ScopeRowReadModel[],
  siteId: string | null,
): ScopeRowReadModel[] {
  if (siteId === null) return rows;
  return rows.filter((row) => row.siteId === siteId);
}

export function filterScopeRows(rows: ScopeRowReadModel[], filter: ScopeRegisterFilter): ScopeRowReadModel[] {
  if (filter === "all") return rows;
  if (filter === "attention") return rows.filter(scopeRowNeedsAttention);
  if (filter === "calculation") return rows.filter((row) => row.enabled && row.calculatedTco2e === null && row.overrideTco2e === null);
  if (filter === "quality") return rows.filter((row) => row.enabled && row.qualityTier === null);
  if (filter === "rejected") return rows.filter((row) => row.enabled && row.reviewStatus === "rejected");
  return rows.filter((row) => row.enabled && row.reviewStatus !== "approved");
}

/**
 * What the one detail surface is showing (v2).
 *
 * Extracted so "closed at rest" is a property something asserts rather than a line in a component
 * nobody can test with this harness. The drawer used to be seeded with a row on load, which put a
 * detail panel describing a row the user had never clicked on screen every time Data entry opened.
 */
export type CaptureDrawerState =
  | { kind: "closed" }
  /** The type-aware quick-add for one category, opened by "+ Add entry". */
  | { kind: "quick-add"; categoryCode: string }
  /** One row's detail, opened by clicking it — or left open on a row just created. */
  | { kind: "detail"; row: ScopeRowReadModel };

/**
 * Resolve the drawer from the two deliberate acts that can open it.
 *
 * Adding wins over a selection: if somebody asked to add an entry while a row happened to be selected,
 * the thing they just asked for is the thing to show. Clearing the category after a save therefore falls
 * through to the detail of whatever is selected — which is how the new row's drawer stays open.
 */
export function resolveCaptureDrawer(
  addingCategoryCode: string | null,
  rows: ScopeRowReadModel[],
  selectedId: string,
): CaptureDrawerState {
  if (addingCategoryCode !== null) return { kind: "quick-add", categoryCode: addingCategoryCode };
  const row = resolveSelectedScopeRow(rows, rows, selectedId);
  return row ? { kind: "detail", row } : { kind: "closed" };
}
