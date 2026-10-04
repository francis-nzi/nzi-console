/**
 * Asserting that a value never reached a payload (an audit row, an idempotency record, an outbox event, an outcome) —
 * structurally, not by substring over the serialised blob.
 *
 * Why: every such payload carries random UUIDs, hex refs and microsecond timestamps, whose characters contain any
 * short run of digits or of `a`–`f` by chance. A sweep like `!/dee/i.test(JSON.stringify(audit))` or
 * `!json.includes("4321")` therefore fails at random (serviceCatalogueReal #390, suppliersReal #396, staffAdminReal).
 *
 * - `plaintextIn` looks for words (names, emails, bank values) inside the payload's text **values**, skipping the ones
 *   that are ids or timestamps — which no person's name or a leaked value can hide in. Field names are not searched.
 * - `figuresIn` looks for amounts as **whole** values (a number, or a numeric string), never as digits inside another
 *   value.
 *
 * Both return the paths where they found something, so `assert.deepEqual(…, [])` prints exactly what leaked.
 */

type Leaf = { path: string; value: string | number };

/**
 * A UUID anywhere in it (also `prefix:uuid`), a bare hex token of 8 or more **with at least one letter** (so an
 * all-digit value — an account number, a phone number — is always searched), or an ISO timestamp / date.
 */
const ID_LIKE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|^(?=[0-9]*[a-f])[0-9a-f]{8,}$|^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}(:?\d{2})?)?)?$/i;

/** Every text or number value in a payload, with its path; JSON held in a string is parsed and walked too. */
export function leavesOf(value: unknown, path = "$"): Leaf[] {
  if (value === null || value === undefined || typeof value === "boolean") return [];
  if (value instanceof Date) return [{ path, value: value.toISOString() }];
  if (typeof value === "number") return [{ path, value }];
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^[[{]/.test(trimmed)) { try { return leavesOf(JSON.parse(trimmed), path); } catch { /* text that only looks like JSON */ } }
    return [{ path, value }];
  }
  if (Array.isArray(value)) return value.flatMap((entry, index) => leavesOf(entry, `${path}[${index}]`));
  if (typeof value === "object") return Object.entries(value).flatMap(([key, entry]) => leavesOf(entry, `${path}.${key}`));
  return [];
}

/**
 * Where any of `needles` occurs in the payload's text — a string matched case-insensitively as a substring, or a
 * RegExp — skipping values that are ids or timestamps. `[]` means none.
 */
export function plaintextIn(payload: unknown, needles: ReadonlyArray<string | RegExp>): string[] {
  const found: string[] = [];
  for (const { path, value } of leavesOf(payload)) {
    const text = String(value);
    if (typeof value === "string" && ID_LIKE.test(text.trim())) continue;
    for (const needle of needles) {
      const hit = typeof needle === "string" ? text.toLowerCase().includes(needle.toLowerCase()) : needle.test(text);
      if (hit) found.push(`${path} = ${JSON.stringify(text)} (matches ${String(needle)})`);
    }
  }
  return found;
}

/** Where any of `figures` occurs as a whole value — a number, or a string that is exactly that number. `[]` means none. */
export function figuresIn(payload: unknown, figures: readonly number[]): string[] {
  return leavesOf(payload).flatMap(({ path, value }) => {
    const text = String(value).trim();
    return text !== "" && figures.some((figure) => Number(text) === figure) ? [`${path} = ${text}`] : [];
  });
}
