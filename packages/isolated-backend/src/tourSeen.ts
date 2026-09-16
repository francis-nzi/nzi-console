import type { TourSeen } from "@nzi/contracts";
import type { Queryable } from "./postgres";

/**
 * A person's record of the tours they have been shown.
 *
 * Deliberately **not** a command. Every mutation in this app is a permission-checked,
 * audited command — this is the one documented exception (NZC-082), because it is not a
 * change to anything the business owns. It is a person's own UI state, the server-side
 * equivalent of a remembered collapsed panel, kept here only so it follows them between
 * devices. Auditing "was shown a tour" would be noise in a log that exists to answer who
 * changed a client's data.
 *
 * The safety comes from shape rather than from a capability: `userId` is taken from the
 * verified session by the caller and is never read from a request body, so a person can only
 * ever record their own. The tenant policy does the rest.
 */

export async function listTourSeen(db: Queryable, userId: string): Promise<TourSeen[]> {
  const result = await db.query<{ tour_id: string; tour_version: number; dismissed: boolean; seen_at: Date | string }>(
    `SELECT tour_id, tour_version, dismissed, seen_at FROM nzi_console.help_tour_seen
     WHERE user_id = $1`,
    [userId]);
  return result.rows.map((row) => ({
    tourId: row.tour_id,
    tourVersion: row.tour_version,
    dismissed: row.dismissed,
    seenAt: row.seen_at instanceof Date ? row.seen_at.toISOString() : String(row.seen_at),
  }));
}

/**
 * Record that this person has been shown a tour.
 *
 * Idempotent on (user, tour, version): finishing a tour you had previously dismissed, or
 * dismissing one you had finished, updates the same row rather than adding a second. Once
 * `dismissed` is true it stays true — reaching the end of a tour you asked never to see
 * again is not a request to start seeing it again.
 */
export async function recordTourSeen(
  db: Queryable,
  input: { organisationId: string; userId: string; tourId: string; tourVersion: number; dismissed: boolean },
): Promise<void> {
  await db.query(
    `INSERT INTO nzi_console.help_tour_seen (organisation_id, user_id, tour_id, tour_version, dismissed)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (organisation_id, user_id, tour_id, tour_version)
     DO UPDATE SET dismissed = nzi_console.help_tour_seen.dismissed OR EXCLUDED.dismissed,
                   seen_at = now()`,
    [input.organisationId, input.userId, input.tourId, input.tourVersion, input.dismissed]);
}
