/**
 * How an entry came to be: by what route, and from whom (NZC-111).
 *
 * A scope row's `provenance_json` has always said what the measurement rests on — the factor, its
 * version, the quality tier, who committed it and when. It has not said how the figure reached the
 * commit. These two keys close that, and they are deliberately separate questions:
 *
 * - **`capturedVia`** — was this typed by a person, or proposed by the assistant and confirmed by
 *   one? The assistant never writes; a proposal becomes an entry only when a human accepts it at
 *   the confirm boundary, and this records that that is what happened.
 * - **`capturedAs`** — where the figure came from: a member of staff working in the console, or a
 *   client submitting through their portal and a reviewer accepting it.
 *
 * ## Absence means different things, and that is the point
 *
 * `capturedVia` absent reads as **manual**, because that is a known fact rather than a guess: the
 * assisted path did not exist when those rows were written, so nothing could have used it. Exactly
 * the status of `activity_distributed` being backfilled false in 0094.
 *
 * `capturedAs` absent reads as **unknown**, and is not guessed. A console-origin row genuinely
 * could have been either, and writing "staff" across every historic row would turn an assumption
 * into a fact the moment something read it. The status of `activity_frequency` left null in 0094.
 *
 * Both are keys in an unconstrained `jsonb` object, so this is a contract change and not a
 * migration — old rows simply lack them, and the two rules above say how to read that.
 *
 * ## Why `capturedAs` is not derived from the command's principal
 *
 * `CommandContext.principal` is the literal `"staff"`: the governed commit is reachable only by a
 * staff principal, so asking it would always answer "staff" and record nothing. A client's figures
 * reach the store by a different route — submitted in the portal, then accepted by a reviewer
 * through `decidePortalDataEntryReview`, which commits as staff on the client's behalf. The origin
 * is known *there*, and that path has recorded it since it was written, under the older spelling
 * `source: "client-portal"` in the same blob. `capturedAs` is the key both paths now write, so the
 * question has one answer in one place rather than one path knowing and the other staying silent.
 */

/** Whether a person typed the figure, or confirmed one the assistant proposed. */
export type CapturedVia = "manual" | "ai-assisted";

/** Where a figure came from. Only the origins that actually occur. */
export type CapturedAs = "staff" | "client-portal";

export const capturedViaValues: readonly CapturedVia[] = ["manual", "ai-assisted"] as const;
export const capturedAsValues: readonly CapturedAs[] = ["staff", "client-portal"] as const;

export const isCapturedVia = (value: unknown): value is CapturedVia =>
  typeof value === "string" && (capturedViaValues as readonly string[]).includes(value);

/** The provenance keys this adds. Everything else in the blob is untouched. */
export type EntryOriginProvenance = {
  capturedVia?: CapturedVia;
  capturedAs?: CapturedAs;
};

/**
 * How a stored row was captured. Absence is interpreted here, once, so no reader has to remember
 * which of the two keys means "known false" and which means "not recorded".
 */
export function readEntryOrigin(provenance: unknown): { via: CapturedVia; as: CapturedAs | null } {
  const blob = (provenance ?? {}) as Record<string, unknown>;
  const via = blob.capturedVia;
  const as = blob.capturedAs;
  return {
    // Absent is manual, and that is a fact about the code that wrote the row rather than a guess.
    via: via === "ai-assisted" ? "ai-assisted" : "manual",
    // Absent is unknown, and stays unknown. The older `source` spelling on the portal-acceptance
    // path is read too, so a row written before this key existed still answers when it can.
    as: as === "staff" || as === "client-portal" ? as
      : blob.source === "client-portal" ? "client-portal"
        : null,
  };
}
