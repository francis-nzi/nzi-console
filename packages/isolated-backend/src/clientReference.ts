/**
 * Reading a client's identity references (NZC-090).
 *
 * ## The fallback is the path, not the exception
 *
 * Every one of these four fields resolves in three steps: the curated label if the client holds an
 * id, else the text the client already held, else nothing. That is unconditional, and it is a
 * designed path rather than a safety net, for reasons that do not go away:
 *
 * - **Archived values.** Archive is deactivation, so a client keeps pointing at an industry that
 *   has left the search. Its label still resolves — the record stays explicable — and that is the
 *   whole reason `DELETE` is revoked on `reference_values`.
 * - **History.** Every client predating the lookups holds free text typed against nothing. The
 *   first dry run put a number on it: nearly every sector, owner and manager was unmatched, and
 *   staging is smaller and more synthetic than live.
 * - **Naming variants.** "Food & beverage" and "Food and Drink" are the same industry to a person
 *   and different strings to a matcher. Aliases will shrink that population; they will not empty
 *   it.
 *
 * So a reader never has to ask whether a value resolved before it can show one, and `source` says
 * which of the three it got — enough for a surface to flag an unresolved value without any surface
 * having to handle its absence.
 */

export type ReferenceSource =
  /** Resolved from the curated list — the value and its label move together from here on. */
  | "reference"
  /** The client's own text, kept because no id matched it. Renaming the lookup will not touch it. */
  | "legacy"
  /** Nothing recorded at all. */
  | "none";

export type ResolvedReference = {
  /** The id, when the client holds one. Null for legacy text and for nothing. */
  id: string | null;
  /** What to show. Empty only when `source` is "none". */
  label: string;
  source: ReferenceSource;
};

/**
 * Three steps, in order, once — so no call site can implement two of them and forget the third.
 *
 * `curated` is null when the client holds no id **or** holds one that no longer resolves; both
 * fall through to the text, which is why a deleted reference could not silently blank a client and
 * why deletion is revoked rather than merely discouraged.
 */
export function resolveReference(
  id: string | null | undefined,
  curated: string | null | undefined,
  stored: string | null | undefined,
): ResolvedReference {
  const label = curated?.trim();
  if (id && label) return { id, label, source: "reference" };
  const text = stored?.trim();
  if (text) return { id: null, label: text, source: "legacy" };
  return { id: null, label: "", source: "none" };
}

export type ClientReferences = {
  sector: ResolvedReference;
  referral: ResolvedReference;
  owner: ResolvedReference;
  clientManager: ResolvedReference;
};

type ReferenceRow = {
  sector_value_id?: string | null; sector_label?: string | null; sector: string | null;
  referral_value_id?: string | null; referral_label?: string | null; referral: string | null;
  owner_user_id?: string | null; owner_label?: string | null; owner_name: string | null;
  client_manager_user_id?: string | null; client_manager_label?: string | null; client_manager: string | null;
};

export function clientReferences(row: ReferenceRow): ClientReferences {
  return {
    sector: resolveReference(row.sector_value_id, row.sector_label, row.sector),
    referral: resolveReference(row.referral_value_id, row.referral_label, row.referral),
    owner: resolveReference(row.owner_user_id, row.owner_label, row.owner_name),
    clientManager: resolveReference(row.client_manager_user_id, row.client_manager_label, row.client_manager),
  };
}
