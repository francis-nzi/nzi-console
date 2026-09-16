import { abstain, type GroundedCandidate, type GroundingAbstention } from "./grounding";

/**
 * Grounded answering — turning cited candidates into a cited answer.
 *
 * Phase 0 made an *uncited candidate* unrepresentable. That is not the same guarantee as an
 * uncited **answer**, and the difference is the whole of this file.
 *
 * Retrieval is ours; generation is not. A model is handed candidates and asked which it used,
 * and it can get that wrong in two ways that matter:
 *
 * 1. It can return prose with **no** citation — fluent, plausible, unsourced.
 * 2. It can cite a reference it was **never given** — the harder failure, because the answer
 *    then *looks* grounded. A footnote to a source that does not exist is worse than a missing
 *    footnote: it manufactures the appearance of provenance.
 *
 * So the model's output is treated as a **claim to be checked**, never as a result. Every
 * reference it returns is resolved against the exact candidate set it was given, by index, and
 * an answer survives only if all of them resolve. Nothing here trusts the model's word about
 * where its words came from.
 */

/* ── What the model is allowed to hand back ──────────────────────────────────────────── */

/**
 * A model's *proposal*. Deliberately not named "answer": it is unverified until `groundAnswer`
 * has resolved every reference in it, and the name is there to stop a future caller reaching
 * past the check and using this directly.
 *
 * `cites` are 1-based indices into the candidate list as it was presented. Indices rather than
 * entry ids on purpose — the model never sees an id it could later reproduce from memory
 * instead of from the prompt, so a "citation" it invents cannot accidentally be a real one.
 */
export type ModelDraft =
  | { kind: "draft"; answer: string; cites: readonly number[] }
  | { kind: "abstain"; reason?: string };

/**
 * The model behind answering, as an interface rather than a dependency.
 *
 * Injected so the rules above are testable without a network, a key, or a bill — every test in
 * this repo drives a fake through this shape. The real adapter is a thin edge that implements
 * it and nothing more.
 */
export type AnswerModel = {
  /** Identifies the model in provenance, the way a factor-set version identifies a figure. */
  readonly id: string;
  draft(prompt: string): Promise<ModelDraft>;
};

/* ── The answer ──────────────────────────────────────────────────────────────────────── */

/** A source the answer actually leans on, paired with the reference the reader will see. */
export type AnswerCitation = {
  /** 1-based, matching the marker in the answer text. */
  readonly ref: number;
  readonly candidate: GroundedCandidate;
};

/**
 * An answer, with the sources it stands on.
 *
 * `citations` is a **non-empty tuple type**, not an array. An answer with zero citations is
 * therefore not a thing this type can describe — the same trick as `GroundedCandidate`, applied
 * one level up, so "we forgot to check" cannot compile rather than merely failing a test.
 */
export type GroundedAnswer = {
  readonly state: "answered";
  readonly answer: string;
  readonly citations: readonly [AnswerCitation, ...AnswerCitation[]];
  /** Which model drafted it. Provenance travels with the answer, as it does with every figure. */
  readonly modelId: string;
};

export type AnswerResult = GroundedAnswer | GroundingAbstention;

/* ── The check ───────────────────────────────────────────────────────────────────────── */

/**
 * Said when a draft cites something it was never given. Worded for the person, not the log: it
 * tells them plainly that an answer existed and was withheld, rather than implying their
 * question had no answer — those are different facts and only one of them is true here.
 */
export const UNVERIFIABLE_CITATION_REASON =
  "I drafted an answer but could not match it to the sources I was given, so I am not showing it. " +
  "That is a fault in the answer, not a gap in the knowledge.";

/** Said when a draft came back with no citation at all. */
export const UNCITED_ANSWER_REASON =
  "I could not produce an answer that cites an approved source, so there is no grounded answer to give.";

/**
 * Resolve a model's draft against the candidates it was actually given.
 *
 * **One bad reference refuses the whole answer.** The alternative — dropping the unresolvable
 * citation and keeping the rest — is tempting and wrong: a model that invented a reference has
 * demonstrated it is not tracking its sources, and the prose it produced in that state is
 * exactly the prose whose provenance has just been disproved. Keeping it would leave a claim
 * standing on the strength of the citations that happened to survive.
 *
 * Returns an abstention rather than throwing. A refused answer is a normal outcome of asking a
 * question, not an exceptional condition, and the caller must handle abstention anyway.
 */
export function groundAnswer(
  draft: ModelDraft,
  candidates: readonly GroundedCandidate[],
  modelId: string,
): AnswerResult {
  if (draft.kind === "abstain") return abstain(draft.reason);

  const answer = draft.answer.trim();
  // Citations without prose is not an answer, however well-sourced it claims to be.
  if (answer === "") return abstain(UNCITED_ANSWER_REASON);
  if (draft.cites.length === 0) return abstain(UNCITED_ANSWER_REASON);

  const citations: AnswerCitation[] = [];
  const seen = new Set<number>();
  for (const ref of draft.cites) {
    // A reference that is not a whole number in range was not something we handed it.
    if (!Number.isInteger(ref) || ref < 1 || ref > candidates.length) {
      return abstain(UNVERIFIABLE_CITATION_REASON);
    }
    if (seen.has(ref)) continue; // Citing the same source twice is untidy, not dishonest.
    seen.add(ref);
    citations.push({ ref, candidate: candidates[ref - 1]! });
  }

  const [first, ...rest] = citations;
  // Unreachable given the emptiness check above; narrowing it here is what earns the non-empty
  // tuple type, so the guarantee is carried by the type rather than by this function's comment.
  if (first === undefined) return abstain(UNCITED_ANSWER_REASON);

  return { state: "answered", answer, citations: [first, ...rest], modelId };
}

/**
 * Whether answering is switched on at all.
 *
 * Distinct from "nothing answers this" and said differently, because they are different facts:
 * one is a gap in the knowledge, the other is a capability that is not configured. Collapsing
 * them would tell someone their question is unanswered when nobody has looked.
 */
export const ANSWERING_OFF_REASON =
  "Answering is not switched on here, so I can only show you the sources I found, not write from them.";
