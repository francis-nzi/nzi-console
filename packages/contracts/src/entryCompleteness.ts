import { renderInputSpec, type InputSpecAudience, type InputSpecCategory, type InputSpecMode, type RenderedSpecField } from "./inputSpec";

/**
 * What a complete entry needs — decided by the governed spec, never by the model (NZC-112).
 *
 * The assistant extracts values. It does not get an opinion about whether it has extracted enough,
 * because that is the same class of decision as whether a figure may be committed: governed, stated
 * once, and the same for every surface. A model asked "what's missing?" would be answering from its
 * own idea of a complete entry, and two runs could disagree about it. The spec already says what a
 * category requires and under what conditions (NZC-102), so a gap is a *derived* fact: a field the
 * spec renders for this surface, that carries a value, that is not optional, and that is still
 * empty.
 *
 * The model may later phrase the question that fills a gap. It never decides that the gap exists.
 *
 * ## Conditional requirements are the whole point
 *
 * The spec renders different fields for different surfaces, and that does real work here: the
 * factor, the quality tier, the data confidence and the lineage are consultant-only, so a client
 * is never asked for them and their absence is never a gap on the portal. That falls out of
 * `renderInputSpec` rather than being restated, which is what keeps the two from drifting.
 *
 * ## Not every field is a value
 *
 * A banner explains; a lineage panel displays. Neither can be filled in, so neither can be missing.
 * They are excluded by their control rather than by a list of field names, because the spec is
 * data and a new banner should not have to be remembered here.
 */

/** Controls that show something rather than collect it. They can never constitute a gap. */
export const DISPLAY_ONLY_CONTROLS: readonly string[] = ["banner", "lineage"] as const;

/** A value the spec expects for this render, in spec field-key terms. */
export type EntryDraft = Record<string, unknown>;

const isEmpty = (value: unknown): boolean =>
  value === null || value === undefined
  || (typeof value === "string" && value.trim() === "")
  || (Array.isArray(value) && value.length === 0);

/**
 * The fields this render must have a value for.
 *
 * `optional` is three-valued in the spec: absent says nothing, `false` says explicitly required,
 * `true` says explicitly optional. Only an explicit `true` excuses a field — a field that says
 * nothing about itself is required, which is the reading that fails closed.
 */
export function requiredFieldsFor(
  category: InputSpecCategory,
  audience: InputSpecAudience,
  mode: InputSpecMode,
  leanCapture = false,
): RenderedSpecField[] {
  return renderInputSpec(category, audience, mode, leanCapture)
    .filter((field) => !DISPLAY_ONLY_CONTROLS.includes(field.control))
    .filter((field) => field.optional !== true);
}

/** A gap, with the spec's own words for it — so a surface can ask without inventing wording. */
export type EntryGap = {
  fieldKey: string;
  label: string;
  hint?: string;
  control: string;
};

/**
 * What this draft is still missing, in the spec's order.
 *
 * Order matters: asking in the order the form presents the fields keeps a conversation and a form
 * describing the same entry in the same sequence.
 */
export function entryGaps(
  category: InputSpecCategory,
  audience: InputSpecAudience,
  mode: InputSpecMode,
  draft: EntryDraft,
  leanCapture = false,
): EntryGap[] {
  return requiredFieldsFor(category, audience, mode, leanCapture)
    .filter((field) => isEmpty(draft[field.key]))
    .map((field) => ({
      fieldKey: field.key,
      label: field.label,
      ...(field.hint === undefined ? {} : { hint: field.hint }),
      control: field.control,
    }));
}

/** Whether the spec considers this draft complete. The only definition of complete there is. */
export const draftIsComplete = (
  category: InputSpecCategory,
  audience: InputSpecAudience,
  mode: InputSpecMode,
  draft: EntryDraft,
  leanCapture = false,
): boolean => entryGaps(category, audience, mode, draft, leanCapture).length === 0;
