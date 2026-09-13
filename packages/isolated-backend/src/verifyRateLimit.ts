import { createHash } from "node:crypto";
import type { Queryable } from "./postgres";

/**
 * Rate limiting the public certificate verification endpoint.
 *
 * `verify_training_certificate` bounds what one request can read. This bounds how many
 * requests a caller gets to make — which is the half that matters for a 40-bit code on an
 * unauthenticated page, where the exposure is in the aggregate rather than in any single
 * hit.
 *
 * Two budgets, because enumeration and use look nothing alike:
 *
 *   * A **miss** budget, which is the one that actually bites. A sweep is ~100% misses; a
 *     person checking a certificate they were handed is ~100% hits. Counting misses
 *     separately lets the limit be tight where it matters without getting in the way of
 *     someone verifying a team's worth of certificates.
 *   * An **overall** budget, so a caller cannot sit on the endpoint at any volume they like
 *     purely because their guesses happen to land.
 *
 * Neither stops a genuinely distributed attacker — per-IP limiting never does, and saying
 * otherwise would be overselling it. What it does is end trivial single-host enumeration
 * and make the distributed version expensive and conspicuous.
 */

export type VerifyRateLimitDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number };

/** Generous: a recruiter checking a shortlist should never see this. */
export const VERIFY_OVERALL_LIMIT = 60;
/** Tight: this is the enumeration budget. */
export const VERIFY_MISS_LIMIT = 10;
export const VERIFY_WINDOW_MINUTES = 10;

const WINDOW = `${VERIFY_WINDOW_MINUTES} minutes`;

/**
 * The caller's address, derived from `X-Forwarded-For` — and derived carefully, because the
 * obvious reading of that header is the wrong one.
 *
 * A proxy APPENDS the address it saw. A client that sends its own `X-Forwarded-For` gets it
 * kept, with the real address appended after it. So the leftmost entry is attacker-supplied
 * and the rightmost is the one our own trusted proxy observed. Taking the leftmost — which
 * is the common mistake, because it reads as "the original client" — would let anyone
 * defeat this limiter by varying a header.
 *
 * `trustedHops` is how many proxies of our own sit in front; with one, the real client is
 * the last entry. A missing header means nothing trustworthy to key on, so those callers
 * share one bucket: stricter than letting them through, which is the right way to fail.
 */
export function clientAddressFrom(forwardedFor: string | null, trustedHops = 1): string {
  const hops = Number.isFinite(trustedHops) && trustedHops >= 1 ? Math.floor(trustedHops) : 1;
  const entries = (forwardedFor ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
  if (entries.length === 0) return "unknown";
  // Drop the hops our own proxies added beyond the first, then take what is left.
  const index = entries.length - hops;
  return entries[index >= 0 ? index : 0] ?? "unknown";
}

/**
 * The bucket key: a salted hash, never the address.
 *
 * Someone verifying a certificate before a job interview should not leave their IP address
 * in our database so that a counter can work. The salt means the stored keys are not a
 * rainbow-table away from the addresses either — IPv4 is a small enough space that an
 * unsalted hash would be reversible by anyone who could read the table.
 */
export const verifyBucketKey = (address: string, kind: "all" | "miss", salt: string) =>
  `${kind}:${createHash("sha256").update(`${salt}:${address}`).digest("hex").slice(0, 32)}`;

async function claim(db: Queryable, bucketKey: string, limit: number): Promise<boolean> {
  const result = await db.query<{ allowed: boolean }>(
    `SELECT nzi_console.claim_verify_attempt($1, $2, $3::interval) AS allowed`,
    [bucketKey, limit, WINDOW],
  );
  // A limiter that fails open is decoration. If the check itself cannot be completed we
  // refuse, because the alternative is that breaking this query is how you turn it off.
  return result.rows[0]?.allowed === true;
}

/** Claimed before the lookup runs: the budget is spent on asking, not on being right. */
export function claimVerifyAttempt(db: Queryable, address: string, salt: string): Promise<boolean> {
  return claim(db, verifyBucketKey(address, "all", salt), VERIFY_OVERALL_LIMIT);
}

/** Claimed after a lookup that found nothing — the signal that distinguishes a sweep. */
export function claimVerifyMiss(db: Queryable, address: string, salt: string): Promise<boolean> {
  return claim(db, verifyBucketKey(address, "miss", salt), VERIFY_MISS_LIMIT);
}
