// The import's label rule (R-1, BRIEF-v7-import-server-side; NOTE-v7-import-server-side-phase-a §3, ruled 13 Nov 2026).
//
// One rule, written twice: in SQL inside the view (`v7-source/v7_import_views.sql`, `v7_import.sanitise_label` and
// `v7_import.label_has_pii`), so a label leaves the source database already clean, and here, so the server-side diff can put
// the console's own stored label through the same rule before comparing it with the view's. A shared-fixture test runs both
// and requires identical output; another requires every pattern below to appear verbatim in the SQL.
//
// The rule, per label value, in order:
//   1. Taxonomy allow-list: the exact text of a factor's taxonomy field (or a fixed system default) is kept, if clean.
//   2. Person-linked rows (commuting, homeworking, grey fleet): the factor's own taxonomy text, if clean.
//   3. Everything else: `<category> — site <site id>` (`<category>` alone when there is no site, or when that would not be
//      clean). Free text is replaced, never edited.
//   4. Belt and braces: no output of 1–3 matches a PII pattern; `<category>` (the view's `label_base`) is always clean.
// An empty value stays as it is: the planner's own fallbacks then fill the row's label, never with nothing.

/** The system's own fixed labels, allow-listed beside the factor taxonomy. The SQL lists the same strings. */
export const V7_IMPORT_LABEL_DEFAULTS = [
  "Employee Commuting", "Imported Totals", "Business travel", "Asset register", "Uncategorised", "Scope 1", "Scope 2", "Scope 3",
] as const;

/**
 * The belt-and-braces patterns. Each source is written in the subset where PostgreSQL's regular expressions and JavaScript's
 * agree (no `\b`, explicit character classes), and appears verbatim in the SQL; `insensitive` is `~*` there and `i` here.
 */
export const V7_IMPORT_LABEL_PII_PATTERNS = [
  { name: "email", source: "[^\\s@]+@[^\\s@]+\\.[A-Za-z]{2,}", insensitive: false },
  { name: "postcode", source: "(^|[^A-Za-z0-9])[A-Za-z]{1,2}[0-9][A-Za-z0-9]? ?[0-9][A-Za-z]{2}($|[^A-Za-z0-9])", insensitive: true },
  { name: "plate-current", source: "(^|[^A-Za-z0-9])[A-Z]{2}[0-9]{2} ?[A-Z]{3}($|[^A-Za-z0-9])", insensitive: false },
  { name: "plate-prefix", source: "(^|[^A-Za-z0-9])[A-Z][0-9]{1,3} ?[A-Z]{3}($|[^A-Za-z0-9])", insensitive: false },
  { name: "plate-suffix", source: "(^|[^A-Za-z0-9])[A-Z]{3} ?[0-9]{1,3}[A-Z]($|[^A-Za-z0-9])", insensitive: false },
  { name: "long-number", source: "[0-9]{6,}", insensitive: false },
  { name: "sort-code", source: "[0-9]{2}-[0-9]{2}-[0-9]{2}", insensitive: false },
  { name: "phone", source: "(^|[^0-9])(\\+44 ?|0)[0-9]{2,4} ?[0-9]{3,4} ?[0-9]{3,4}", insensitive: false },
  { name: "titled-name", source: "(^|[^A-Za-z])(Mr|Mrs|Ms|Miss|Mx|Dr)\\.? +[A-Z][a-z]+", insensitive: false },
] as const;
export type V7ImportLabelPattern = (typeof V7_IMPORT_LABEL_PII_PATTERNS)[number]["name"];

const COMPILED = V7_IMPORT_LABEL_PII_PATTERNS.map((pattern) => ({ name: pattern.name, regex: new RegExp(pattern.source, pattern.insensitive ? "i" : "") }));

/** Which patterns a value matches: none, for a clean value. */
export function v7ImportLabelPiiHits(value: string | null | undefined): V7ImportLabelPattern[] {
  if (value === null || value === undefined) return [];
  return COMPILED.filter((pattern) => pattern.regex.test(value)).map((pattern) => pattern.name);
}
export const v7ImportLabelHasPii = (value: string | null | undefined) => v7ImportLabelPiiHits(value).length > 0;

/** The row's own context for the rule, as the view computes it (`label_person_linked`, `label_factor`, `label_base`, `site_id`). */
export type V7ImportLabelContext = { personLinked: boolean; factorLabel: string | null; base: string; siteId: string | null };

/** PostgreSQL's one-argument `btrim`: spaces only (JavaScript's `trim` also takes tabs and newlines). */
export const btrimV7ImportLabel = (value: string) => value.replace(/^ +| +$/g, "");

/** The rule, as `v7_import.sanitise_label(value, allowed, person_linked, factor_label, base, site_id)`. */
export function sanitiseV7ImportLabel(value: string | null, allowed: boolean, context: V7ImportLabelContext): string | null {
  if (value === null || btrimV7ImportLabel(value) === "") return value;
  if (allowed && !v7ImportLabelHasPii(value)) return value;
  if (context.personLinked && context.factorLabel !== null && !v7ImportLabelHasPii(context.factorLabel)) return context.factorLabel;
  if (context.siteId !== null) {
    const scrubbed = `${context.base} — site ${context.siteId}`;
    if (!v7ImportLabelHasPii(scrubbed)) return scrubbed;
  }
  return context.base;
}
