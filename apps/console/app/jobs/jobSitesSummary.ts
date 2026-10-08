import type { SiteOption } from "@nzi/contracts";

/** The Sites chip (Phase 3a): "6 sites · all included", or "5 of 6 included" once the job leaves any out. */
export function sitesSummary(sites: readonly Pick<SiteOption, "included">[]): string {
  if (sites.length === 0) return "No sites";
  const included = sites.filter((site) => site.included !== false).length;
  return included === sites.length ? `${sites.length} site${sites.length === 1 ? "" : "s"} · all included` : `${included} of ${sites.length} included`;
}
