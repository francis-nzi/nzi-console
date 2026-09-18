import type { InputSpecCategory, InputSpecField, InputSpecVariant } from "@nzi/contracts";
import type { Queryable } from "./postgres";

/**
 * Reading the governed input spec (NZC-102).
 *
 * Active categories and their active fields, in order. Deactivated rows are filtered here rather
 * than deleted anywhere: a retired category stays resolvable for every row that was recorded
 * against it, which is the whole reason the spec deactivates instead of deleting.
 *
 * Two queries rather than a join with a jsonb aggregate: the spec is small, read once per screen,
 * and a shape a person can read beats one a person has to decode. §13 — one query at a time on a
 * pooled client.
 */

type CategoryRow = {
  category_code: string;
  scope: "1" | "2" | "3";
  name: string;
  kind: string;
  units: string[];
  manual_entry_hint: string;
};

type FieldRow = {
  category_code: string;
  field_key: string;
  ordering: number;
  control: string;
  label: string;
  hint: string | null;
  optional: boolean | null;
  when_audiences: string[] | null;
  when_modes: string[] | null;
  when_lean: boolean | null;
  label_variants: InputSpecVariant[];
};

export async function listInputSpec(db: Queryable): Promise<InputSpecCategory[]> {
  const categories = await db.query<CategoryRow>(
    `SELECT category_code, scope, name, kind, units, manual_entry_hint
       FROM nzi_console.input_spec_categories
      WHERE active
      ORDER BY scope, category_code`);

  const fields = await db.query<FieldRow>(
    `SELECT category_code, field_key, ordering, control, label, hint, optional,
            when_audiences, when_modes, when_lean, label_variants
       FROM nzi_console.input_spec_fields
      WHERE active
      ORDER BY category_code, ordering`);

  const byCategory = new Map<string, InputSpecField[]>();
  for (const row of fields.rows) {
    const list = byCategory.get(row.category_code) ?? [];
    list.push({
      fieldKey: row.field_key,
      ordering: row.ordering,
      control: row.control,
      label: row.label,
      hint: row.hint,
      optional: row.optional,
      whenAudiences: row.when_audiences as InputSpecField["whenAudiences"],
      whenModes: row.when_modes as InputSpecField["whenModes"],
      whenLean: row.when_lean,
      labelVariants: row.label_variants ?? [],
    });
    byCategory.set(row.category_code, list);
  }

  return categories.rows.map((row) => ({
    categoryCode: row.category_code,
    scope: row.scope,
    name: row.name,
    kind: row.kind,
    units: row.units,
    manualEntryHint: row.manual_entry_hint,
    fields: byCategory.get(row.category_code) ?? [],
  }));
}

/** One category's spec, or null when it is unknown or retired. */
export async function getInputSpec(db: Queryable, categoryCode: string): Promise<InputSpecCategory | null> {
  const all = await listInputSpec(db);
  return all.find((category) => category.categoryCode === categoryCode) ?? null;
}
