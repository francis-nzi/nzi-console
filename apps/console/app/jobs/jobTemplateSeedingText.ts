import type { TemplateSeedResult } from "@nzi/contracts";

/** Why a line was not seeded, in the words the notice uses; a refusal code not named here is shown as itself. */
const SKIP_WORDS: Record<string, (n: number) => string> = {
  toFile: (n) => `${n} not yet filed under a category`,
  duplicate: (n) => `${n} already on the job`,
  FACTOR_REQUIRED: (n) => `${n} with no factor in this job's datasets`,
  UNIT_NOT_ACCEPTED: (n) => `${n} in a unit the category does not take`,
  UNIT_INCOMPATIBLE: (n) => `${n} in a unit its factor cannot take`,
};

/** "Seeded 9 entries from template v3 — skipped 2 not yet filed under a category, 1 already on the job." */
export function seedOutcomeText(result: TemplateSeedResult): string {
  const seeded = `Seeded ${result.seeded} entr${result.seeded === 1 ? "y" : "ies"} from template v${result.templateVersion}`;
  const skipped = Object.entries(result.skipped).filter(([, n]) => n > 0)
    .map(([why, n]) => (SKIP_WORDS[why] ?? ((count: number) => `${count} refused (${why})`))(n));
  const dropped = result.siteDropped > 0 ? [`${result.siteDropped} seeded without a site (archived or left out of this job)`] : [];
  const rest = [...skipped.length ? [`skipped ${skipped.join(", ")}`] : [], ...dropped];
  return rest.length ? `${seeded} — ${rest.join("; ")}.` : `${seeded}.`;
}
