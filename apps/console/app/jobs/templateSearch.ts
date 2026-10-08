// NZC-062 — the forgiving fuzzy match first written for "Add rows from template". That search and its whole-library index
// were retired in Phase 3b (template seeding puts the rows there); the match stays, because the LCA inventory's quick-add
// ranks its candidates with it. Pure so the matching is unit-testable without a DOM.

/**
 * A cheap, forgiving fuzzy match: an exact substring hit ranks highest (by
 * how early it appears); failing that, every query character must appear in
 * order somewhere in the target (a subsequence match, like a quick-open file
 * picker), scored higher for consecutive / early hits. Returns null for no
 * match at all.
 */
export function fuzzyScore(query: string, target: string): number | null {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const t = target.toLowerCase();
  const substringIndex = t.indexOf(q);
  if (substringIndex !== -1) return 10_000 - substringIndex;

  let cursor = 0;
  let score = 0;
  let streak = 0;
  for (const char of q) {
    const found = t.indexOf(char, cursor);
    if (found === -1) return null;
    score += found === cursor ? 3 + streak : 1;
    streak = found === cursor ? streak + 1 : 0;
    cursor = found + 1;
  }
  return score;
}
