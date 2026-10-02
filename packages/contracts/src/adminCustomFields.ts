import { defineListSpec, type ListQuery } from "./listQuery";

/**
 * Custom field definitions (admin Phase F3; ruled plan `phaseF-comms-crm-plan.md`, F-Q5): the extra fields an
 * organisation adds to its clients, jobs, contacts, quotes or suppliers. **F builds the definitions only**; the values
 * belong to each entity's own workstream, under the contract in `docs/CUSTOM_FIELD_VALUES_CONTRACT.md`.
 *
 * - **Set once:** the entity a field belongs to, its key (the identity a value is stored against), and its type — a
 *   value held as a date cannot become a number. v7 let all three change, and orphaned values when they did.
 * - **Options are never removed.** A select's options can be added, relabelled and deactivated; an option's value is set
 *   once, so every value already held still resolves (R3).
 * - **A default is valid for its type** (and, for a select, an active option).
 * - Capability `admin.settings` (F-Q5): a definition shapes other entities' data.
 */
export const CUSTOM_FIELD_ENTITY_TYPES = ["client", "job", "contact", "quote", "supplier"] as const;
export type CustomFieldEntityType = (typeof CUSTOM_FIELD_ENTITY_TYPES)[number];
export const CUSTOM_FIELD_ENTITY_LABELS: Record<CustomFieldEntityType, string> = { client: "Clients", job: "Jobs", contact: "Contacts", quote: "Quotes", supplier: "Suppliers" };

export const CUSTOM_FIELD_TYPES = ["text", "long_text", "number", "decimal", "date", "checkbox", "select"] as const;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];
export const CUSTOM_FIELD_TYPE_LABELS: Record<CustomFieldType, string> = {
  text: "Text", long_text: "Long text", number: "Whole number", decimal: "Decimal", date: "Date", checkbox: "Yes / no", select: "Choice from a list",
};

export const CUSTOM_FIELD_KEY_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
export const CUSTOM_FIELD_LABEL_MAX = 120;
export const CUSTOM_FIELD_OPTIONS_MAX = 100;
export const CUSTOM_FIELD_OPTION_VALUE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _.&/()+-]{0,79}$/;
export const CUSTOM_FIELD_OPTION_LABEL_MAX = 120;
export const CUSTOM_FIELD_DEFAULT_MAX = 500;

export type CustomFieldOption = { value: string; label: string; active: boolean };
/** What a definition's editable part carries — never its entity, key or type once made. */
export type CustomFieldEditableFields = {
  label: string;
  required: boolean;
  sortOrder: number;
  /** A select's options, in display order; null for any other type. */
  options: CustomFieldOption[] | null;
  defaultValue: string | null;
};

export const isCustomFieldEntityType = (value: unknown): value is CustomFieldEntityType =>
  typeof value === "string" && (CUSTOM_FIELD_ENTITY_TYPES as readonly string[]).includes(value);
export const isCustomFieldType = (value: unknown): value is CustomFieldType =>
  typeof value === "string" && (CUSTOM_FIELD_TYPES as readonly string[]).includes(value);

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const isCalendarDay = (value: string) =>
  ISO_DAY.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value); // date-helper-exempt: validating a plain date round-trips, it is not reading an instant

/**
 * Whether `value` is a valid stored value of this type — the one rule a default here and a value downstream are both held
 * to. Values are stored as text: a whole number, a decimal (`.` separated), `YYYY-MM-DD`, `true`/`false`, or — for a select
 * — one of its option values (active, for anything newly chosen).
 */
export function customFieldValueIssue(type: CustomFieldType, value: string, options: readonly CustomFieldOption[] | null): string | null {
  switch (type) {
    case "text": return value.length > 500 ? "Text is at most 500 characters." : value.includes("\n") ? "Text is one line — use long text for more." : null;
    case "long_text": return value.length > 10_000 ? "Long text is at most 10,000 characters." : null;
    case "number": return /^-?\d{1,15}$/.test(value) ? null : "A whole number, e.g. 12.";
    case "decimal": return /^-?\d{1,15}(\.\d{1,6})?$/.test(value) ? null : "A number, using . for decimals, e.g. 12.5.";
    case "date": return isCalendarDay(value) ? null : "A date as YYYY-MM-DD.";
    case "checkbox": return value === "true" || value === "false" ? null : "Yes or no: true or false.";
    case "select": return options?.some((option) => option.active && option.value === value) ? null : "One of the field's active options.";
  }
}

/** What is wrong with a definition's options for its type. Empty when sound. */
export function customFieldOptionIssues(type: CustomFieldType, options: readonly CustomFieldOption[] | null): string[] {
  if (type !== "select") return options === null || options.length === 0 ? [] : ["Only a choice-from-a-list field has options."];
  if (!options || !options.some((option) => option.active)) return ["A choice-from-a-list field needs at least one active option."];
  const issues: string[] = [];
  if (options.length > CUSTOM_FIELD_OPTIONS_MAX) issues.push(`At most ${CUSTOM_FIELD_OPTIONS_MAX} options.`);
  const values = new Set<string>();
  for (const option of options) {
    if (typeof option.value !== "string" || !CUSTOM_FIELD_OPTION_VALUE_PATTERN.test(option.value)) issues.push(`Option value "${String(option.value)}" is not a valid value (letters, digits and simple punctuation, up to 80).`);
    else if (values.has(option.value.toLowerCase())) issues.push(`Option value "${option.value}" appears twice.`);
    else values.add(option.value.toLowerCase());
    if (typeof option.label !== "string" || !option.label.trim() || option.label.trim().length > CUSTOM_FIELD_OPTION_LABEL_MAX) issues.push(`Option "${String(option.value)}" needs a label of up to ${CUSTOM_FIELD_OPTION_LABEL_MAX} characters.`);
    if (typeof option.active !== "boolean") issues.push(`Option "${String(option.value)}" must say whether it is active.`);
  }
  return issues;
}

/** The definitions list: search (key, label), the entity, All / Active / Inactive; in each entity's own order. */
export const customFieldListSpec = defineListSpec({
  sortKeys: ["sortOrder", "label", "key", "type", "status"] as const,
  defaultSort: { key: "sortOrder", dir: "asc" },
  filters: { entity: "value", status: "value" },
});
export type CustomFieldListSortKey = (typeof customFieldListSpec.sortKeys)[number];
export type CustomFieldListFilterKey = keyof typeof customFieldListSpec.filters;
export type CustomFieldListQuery = ListQuery<CustomFieldListSortKey, CustomFieldListFilterKey>;

/** v7's field types onto the console's (load:v7-custom-fields). v7's "option" (radio buttons) it rendered as a select. */
export const V7_CUSTOM_FIELD_TYPE_MAP: Readonly<Record<string, CustomFieldType>> = {
  text: "text", multiline_text: "long_text", number: "number", decimal: "decimal", date: "date", checkbox: "checkbox", dropdown: "select", option: "select",
};
