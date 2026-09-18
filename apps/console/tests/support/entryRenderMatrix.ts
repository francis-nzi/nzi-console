import { emissionCategoryTaxonomy, type EmissionCategory } from "@nzi/contracts";
import { buildEmissionEntryFields, emissionEntryActions, entryUnitsForCategory, manualEntryHint, type EntryAudience, type EntryMode } from "../../app/jobs/emissionEntryModel";

/**
 * Every render the entry model can produce, as one deterministic structure.
 *
 * The governed input spec (NZC-102) moves this model out of TypeScript and into rows. The only way
 * to know the move changed nothing is to write down everything it currently produces *before*
 * touching it, and compare afterwards — so this enumerates the whole matrix rather than sampling
 * it: every category, both audiences, both modes, lean on and off.
 *
 * **What the golden file is authority for.** It records what the application does today, not what
 * is correct. If a render in it is wrong, it is wrong in the running product too, and changing it
 * is a separate decision with its own reasoning — not something to fix quietly inside a migration.
 */

export type RenderKey = `${string}|${EntryAudience}|${EntryMode}|${"lean" | "full"}`;

export type RenderedField = {
  key: string;
  label: string;
  control: string;
  hint?: string;
  optional?: boolean;
};

export type RenderedEntry = {
  fields: RenderedField[];
  actions: Array<{ key: string; label: string; variant: string }>;
  units: string[];
  manualHint: string;
};

const AUDIENCES: EntryAudience[] = ["crm", "portal"];
const MODES: EntryMode[] = ["new", "existing"];

/** Undefined keys are dropped rather than serialised, so the golden has no `"hint": null` noise. */
const compact = (field: RenderedField): RenderedField => ({
  key: field.key, label: field.label, control: field.control,
  ...(field.hint === undefined ? {} : { hint: field.hint }),
  ...(field.optional === undefined ? {} : { optional: field.optional }),
});

export function renderMatrix(): Record<RenderKey, RenderedEntry> {
  const out: Record<string, RenderedEntry> = {};
  for (const category of emissionCategoryTaxonomy) {
    for (const audience of AUDIENCES) {
      for (const mode of MODES) {
        for (const lean of [false, true]) {
          const key: RenderKey = `${category.code}|${audience}|${mode}|${lean ? "lean" : "full"}`;
          out[key] = {
            fields: buildEmissionEntryFields(category, audience, mode, lean).map(compact),
            actions: emissionEntryActions(audience, mode).map((action) => ({
              key: action.key, label: action.label, variant: action.variant,
            })),
            units: entryUnitsForCategory(category),
            manualHint: manualEntryHint(category),
          };
        }
      }
    }
  }
  return out as Record<RenderKey, RenderedEntry>;
}

/** The two exemplars the brief asks to be scrutinised hardest, resolved from the taxonomy. */
export const ELECTRICITY: EmissionCategory =
  emissionCategoryTaxonomy.find((category) => category.code === "2.purchased-electricity")!;
export const COMPANY_VEHICLE: EmissionCategory =
  emissionCategoryTaxonomy.find((category) => category.code === "1.company-vehicles")!;
