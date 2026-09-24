/**
 * Whether a factor may be the primary factor of a scope row, as one SQL predicate (NZC-160 H1).
 *
 * The portal checked this once — when a bucket was granted — and never again. A bucket granted on a 3.3 row
 * whose scope was later edited to 2 kept offering, accepting and landing the T&D factor on what was now a
 * Scope 2 electricity row. So the same predicate is asked at every point a factor passes through: the grant,
 * the listing, a draft, its submission, and the acceptance that writes it onto the scope row. One definition,
 * so the five cannot drift apart.
 *
 * Three clauses:
 *   - the factor is **active**;
 *   - its scopes include the row's **scope root** (`3` for `3.3`) — the check the grant already made;
 *   - it is **not a companion declared for the row's category**. A companion is another row's factor: T&D
 *     belongs beside electricity, never as its primary. Without this clause a library that tags T&D `{2,3}`
 *     passes the scope check. Scoped to the declaring category on purpose — capturing T&D directly in 3.3 is
 *     still an ordinary entry while manual coexistence is undecided (NZC-160 H4).
 *
 * `f` and `r` are the aliases the caller gave `emission_factors` and `job_scope_rows`.
 */
export const primaryFactorFor = (f: string, r: string): string =>
  `${f}.active=true AND split_part(${r}.scope,'.',1)=ANY(${f}.scopes) AND NOT EXISTS (SELECT 1 FROM nzi_console.input_spec_companion_rules cr WHERE cr.active AND cr.category_code=${r}.category_code AND cr.factor_base=${f}.factor_id)`;
