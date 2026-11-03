/**
 * Text a person reads must not carry the name of an internal system. "v7" / "NZ Insights Pro v7" is what the platform was called before the
 * console: a developer's word, meaningless to a client or to staff, and it must not appear on any screen.
 *
 * Copy written in code is simply worded without it (and `check:terminology` refuses it coming back). Some text, though, was **written into
 * records years of rows ago** - a lineage line "Re-ingested from NZ Insights Pro v7", a factor label, an override reason - and those rows are
 * history that is never rewritten. So where such stored text is shown, it is passed through here first: the same facts, in the words a
 * person can read. A display step only: nothing stored is changed, and no code matches on the result.
 */

const PREVIOUS = "the previous system";

/** "NZ Insights Pro v7" and a bare "v7" (also "v7's"), when it stands alone as a word - never inside an identifier such as `v7-import` or `nzi-pro-v7`. */
export function plainInternalNames(text: string): string {
  return text
    .replace(/NZ Insights Pro v7(?![\w-])/g, PREVIOUS)
    .replace(/(?<![\w-])(the\s+)?v7[’']s(?![\w-])/gi, `${PREVIOUS}’s`)
    .replace(/(?<![\w-])(the\s+)?v7(?![\w-])(?!\.[A-Za-z])/gi, PREVIOUS);
}

/**
 * The same, through a value shaped like stored lineage or provenance: prose at any depth (a string with a space in it). Keys are left exactly as they
 * are, and so are codes - a lone `"v7"` value is a code something may match on, not a sentence.
 */
export function plainInternalNamesDeep<T>(value: T): T {
  if (typeof value === "string") return (/\s/.test(value) ? plainInternalNames(value) : value) as unknown as T;
  if (Array.isArray(value)) return value.map(plainInternalNamesDeep) as unknown as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, inner]) => [key, plainInternalNamesDeep(inner)])) as T;
  return value;
}
