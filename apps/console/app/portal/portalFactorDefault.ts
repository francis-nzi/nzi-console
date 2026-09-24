/**
 * The factor a portal entry starts with (NZC-160 H1).
 *
 * One authorised factor is a choice staff already made, so it is pre-selected. Several are not: the order they
 * arrive in is `lower(label)` under the database's collation, and under byte order the T&D factor sorts ahead of
 * the grid factor it accompanies. So with more than one the control starts empty, and the entry cannot be sent
 * until somebody picks — a number nobody chose is the one thing this must not produce.
 */
export function defaultPortalFactorId(factors: ReadonlyArray<{ id: string }>): string {
  return factors.length === 1 ? factors[0]!.id : "";
}
