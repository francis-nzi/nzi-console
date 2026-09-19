import { entryGaps, type EntryDraft, type EntryGap } from "./entryCompleteness";
import type { InputSpecAudience, InputSpecCategory, InputSpecMode } from "./inputSpec";

/**
 * Asking about the gaps, and knowing when to stop asking (NZC-112).
 *
 * The loop is: the spec says what is still missing, the surface asks about the first of those, the
 * person answers, repeat. Two properties make it safe to put in front of a client.
 *
 * **The spec decides, not the model.** Every question here comes from a gap `entryGaps` computed,
 * and its wording comes from the spec's own label and hint — governed data, the same words the form
 * uses. A model may later rephrase a question; it will still be answering a gap the spec found, not
 * proposing one of its own.
 *
 * **It always terminates.** A confused extractor that keeps failing to understand an answer could
 * otherwise ask forever, and a client cannot tell "one more question" from "this thing is broken".
 * After a fixed number of rounds the loop stops and hands over to the ordinary form, which always
 * works and which the person can complete without help. Falling back is a normal outcome, not an
 * error: the assistant is a shortcut, and a shortcut that is not working should get out of the way.
 */

/** Rounds of questions before the loop gives up and shows the form. */
export const MAX_ASSIST_ROUNDS = 3;

export type AssistTurn =
  /** Ask about this gap. `remaining` is how many rounds are left after this one. */
  | { kind: "ask"; gap: EntryGap; question: string; remaining: number }
  /** Nothing is missing: the spec is satisfied and the draft may go to the confirm boundary. */
  | { kind: "ready" }
  /**
   * Stop asking. The person completes the entry on the ordinary form, pre-filled with whatever was
   * gathered — nothing is thrown away, and nothing is committed either.
   */
  | { kind: "fallback"; reason: "rounds-exhausted"; remainingGaps: EntryGap[] };

/** The spec's own words for a gap, which is what a surface shows when it asks. */
export const questionFor = (gap: EntryGap): string =>
  gap.hint ? `${gap.label} — ${gap.hint}` : gap.label;

/**
 * The next turn, given what has been gathered and how many rounds have already been spent.
 *
 * Pure and re-derived each time rather than held as conversation state: the draft and the round
 * count are the whole of it, so a refresh, a retry or a second tab cannot leave a dialogue in a
 * state nothing can explain.
 */
export function nextAssistTurn(
  category: InputSpecCategory,
  audience: InputSpecAudience,
  mode: InputSpecMode,
  draft: EntryDraft,
  roundsSpent: number,
  leanCapture = false,
): AssistTurn {
  const gaps = entryGaps(category, audience, mode, draft, leanCapture);
  if (gaps.length === 0) return { kind: "ready" };
  if (roundsSpent >= MAX_ASSIST_ROUNDS) {
    return { kind: "fallback", reason: "rounds-exhausted", remainingGaps: gaps };
  }
  const gap = gaps[0]!;
  return { kind: "ask", gap, question: questionFor(gap), remaining: MAX_ASSIST_ROUNDS - roundsSpent - 1 };
}
