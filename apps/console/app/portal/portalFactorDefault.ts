/**
 * The factor a portal entry starts with (NZC-160 H1).
 *
 * One authorised factor is a choice staff already made, so it is pre-selected. Several are not: the order they
 * arrive in is `lower(label)` under the database's collation, and under byte order the T&D factor sorts ahead of
 * the grid factor it accompanies. So with more than one the control starts empty, and the entry cannot be sent
 * until somebody picks — a number nobody chose is the one thing this must not produce.
 */
export function defaultPortalFactorId(factors: ReadonlyArray<{ id: string }>, declaredFactorId?: string | null): string {
  // The category's declared factor, when the bucket authorises it, is a determined choice — the durable end of H1:
  // the default is what the category resolves to, never what the collation happens to sort first (Stop 2d, P4).
  if (declaredFactorId && factors.some((factor) => factor.id === declaredFactorId)) return declaredFactorId;
  return factors.length === 1 ? factors[0]!.id : "";
}
