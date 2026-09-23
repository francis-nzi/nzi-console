/**
 * The interpreter for the governed input spec (NZC-102).
 *
 * The spec is data: rows describing a category's fields, their order, controls, labels, hints and
 * the conditions under which each appears. This turns those rows back into the field list a surface
 * renders. It is the *only* code that knows how to read the spec, and it is deliberately small —
 * everything it does is either substituting a placeholder or evaluating a stated condition.
 *
 * ## What is data and what is here
 *
 * **Here, because storing it would duplicate another governed source:** the two placeholders.
 * `{scopedTo}` becomes "Scope 1 · Company Vehicles" and `{manualHint}` becomes the category's
 * manual-entry wording. Writing those out per category would copy the taxonomy into the spec and
 * let the two drift apart.
 *
 * **Here, because it is a computed guard rather than content:** `lean`. Lean capture applies only
 * to a *new* entry by a *consultant*, so whether a render is lean is derived from three inputs.
 * The spec says which fields survive it; deciding it is not the spec's business.
 *
 * **Data, everything else:** order, control, labels, hints, optionality, the reveal conditions, and
 * the per-render variants of label / hint / control.
 *
 * ## Variants carry `lean` too
 *
 * The brief keyed variants on audience and mode. One field needs more: under lean capture the
 * factor field changes both its control (`factor-select` → `factor-review`) and its hint, because
 * it stops being a required pick and becomes a shown result. That is content, not a guard, so it
 * belongs in the data — and the variant key therefore includes `lean`. Kind and spend are absent
 * from the key because they are resolved when the spec is seeded: each category owns its own rows.
 */

export type InputSpecAudience = "crm" | "portal";
export type InputSpecMode = "new" | "existing";

/** A render's three axes, after `lean` has been computed. */
export type InputSpecRender = {
  audience: InputSpecAudience;
  mode: InputSpecMode;
  lean: boolean;
};

export type InputSpecVariant = {
  /** null on an axis means "whatever it is" — the variant does not constrain it. */
  audience?: InputSpecAudience | null;
  mode?: InputSpecMode | null;
  lean?: boolean | null;
  label?: string | null;
  hint?: string | null;
  control?: string | null;
  optional?: boolean | null;
};

export type InputSpecField = {
  fieldKey: string;
  ordering: number;
  control: string;
  label: string;
  hint: string | null;
  /** null = the field says nothing about optionality; false = it says explicitly not optional. */
  optional: boolean | null;
  whenAudiences: InputSpecAudience[] | null;
  whenModes: InputSpecMode[] | null;
  whenLean: boolean | null;
  labelVariants: InputSpecVariant[];
  /**
   * The units this field accepts, or null when it does not constrain them (NZC-146).
   *
   * Per field rather than per category, because a category can collect a distance and a volume while its
   * spend variant collects neither — and because 0093's per-category list was the same global list on
   * every one of the twenty categories, so Refrigerants offered kilowatt-hours.
   *
   * Null is the behaviour every spec had before the column existed, which is what makes declaring units
   * additive: a field that declares them is checked, a field that does not is not.
   */
  acceptedUnits: string[] | null;
};

export type InputSpecCategory = {
  categoryCode: string;
  scope: "1" | "2" | "3";
  name: string;
  kind: string;
  units: string[];
  manualEntryHint: string;
  fields: InputSpecField[];
};

/** A field as a surface renders it. Mirrors the shape the hand-written model produced. */
export type RenderedSpecField = {
  key: string;
  label: string;
  control: string;
  hint?: string;
  optional?: boolean;
};

/**
 * Lean capture applies to a new consultant entry and nothing else — asked for on the portal, or on
 * an existing row, it is simply not lean. Computed rather than stored so no row can disagree.
 */
export const isLeanRender = (audience: InputSpecAudience, mode: InputSpecMode, leanCapture: boolean): boolean =>
  leanCapture && audience === "crm" && mode === "new";

const substitute = (text: string, category: InputSpecCategory): string =>
  text
    .replace(/\{scopedTo\}/g, `Scope ${category.scope} · ${category.name}`)
    .replace(/\{manualHint\}/g, category.manualEntryHint);

/** A variant applies when every axis it constrains matches the render. */
const variantApplies = (variant: InputSpecVariant, render: InputSpecRender): boolean =>
  (variant.audience == null || variant.audience === render.audience)
  && (variant.mode == null || variant.mode === render.mode)
  && (variant.lean == null || variant.lean === render.lean);

/** How many axes a variant pins — the more specific variant wins a tie. */
const specificity = (variant: InputSpecVariant): number =>
  (variant.audience == null ? 0 : 1) + (variant.mode == null ? 0 : 1) + (variant.lean == null ? 0 : 1);

const fieldApplies = (field: InputSpecField, render: InputSpecRender): boolean =>
  (field.whenAudiences === null || field.whenAudiences.includes(render.audience))
  && (field.whenModes === null || field.whenModes.includes(render.mode))
  && (field.whenLean === null || field.whenLean === render.lean);

/**
 * The fields one surface renders for one category, in order.
 *
 * `leanCapture` is the caller's flag — whether the lean-capture feature is on — not whether this
 * render is lean; that is decided here.
 */
export function renderInputSpec(
  category: InputSpecCategory,
  audience: InputSpecAudience,
  mode: InputSpecMode,
  leanCapture = false,
): RenderedSpecField[] {
  const render: InputSpecRender = { audience, mode, lean: isLeanRender(audience, mode, leanCapture) };

  return category.fields
    .filter((field) => fieldApplies(field, render))
    .sort((a, b) => a.ordering - b.ordering)
    .map((field) => {
      const applicable = field.labelVariants
        .filter((variant) => variantApplies(variant, render))
        .sort((a, b) => specificity(a) - specificity(b));
      // Later (more specific) variants override earlier ones, field by field, so a variant may
      // change only the hint and leave the label alone.
      const resolved = applicable.reduce<InputSpecVariant>((carried, variant) => ({
        label: variant.label ?? carried.label,
        hint: variant.hint === undefined ? carried.hint : variant.hint,
        control: variant.control ?? carried.control,
        optional: variant.optional ?? carried.optional,
      }), {});

      const label = substitute(resolved.label ?? field.label, category);
      const hintSource = resolved.hint === undefined || resolved.hint === null ? field.hint : resolved.hint;
      const control = resolved.control ?? field.control;
      const optional = resolved.optional === undefined ? field.optional : resolved.optional;

      return {
        key: field.fieldKey,
        label,
        control,
        ...(hintSource === null ? {} : { hint: substitute(hintSource, category) }),
        // Absent stays absent; an explicit false is rendered as false, because the hand-written
        // model distinguished them and a surface may key on the difference.
        ...(optional === null || optional === undefined ? {} : { optional }),
      };
    });
}

/** The units a category offers, first being the default. Ordered in the spec, not derived here. */
export const inputSpecUnits = (category: InputSpecCategory): string[] => [...category.units];
