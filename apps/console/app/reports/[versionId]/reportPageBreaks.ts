// R5b — Continuous view's page-break markers: a lightweight, no-dependency
// measure-and-bucket approximation. Advisory editing guides only, not a
// fidelity claim — Page view · A4 (Paged.js) is the high-fidelity preview;
// the server/browser print engine is the actual source of truth. Pure so the
// bucketing rule itself is unit-testable without a DOM.
export const MM_TO_PX = 96 / 25.4;
/** A4 content height in px for the report's own `@page{margin:14mm 12mm}`. */
export const REPORT_A4_CONTENT_HEIGHT_PX = (297 - 14 * 2) * MM_TO_PX;

/**
 * Given each top-level block's rendered height (in document order), return
 * the indices *before which* a page break falls — i.e. `2` means "a new page
 * starts before block 2". Greedy first-fit: a block starts a new page only
 * when it would overflow the current one; a single block taller than a page
 * never forces two breaks around it (it simply overflows onto the next page
 * on its own, same as content genuinely too tall for one page).
 */
export function computePageBreakIndices(
  heights: readonly number[],
  contentHeightPx: number = REPORT_A4_CONTENT_HEIGHT_PX,
): number[] {
  const breaks: number[] = [];
  let used = 0;
  for (const [index, height] of heights.entries()) {
    if (used > 0 && used + height > contentHeightPx) {
      breaks.push(index);
      used = height;
    } else {
      used += height;
    }
  }
  return breaks;
}
