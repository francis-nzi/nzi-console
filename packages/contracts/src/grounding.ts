/**
 * The grounding contract — what the help assistant is allowed to answer from.
 *
 * Phase 0 builds the plumbing and no more: retrieval, citation, and honest abstention, all
 * testable before a single model call exists. Phase 1 adds generation **on top of this**, and
 * Phase 2 adds permission-checked live-data tools as another source behind the same contract.
 *
 * Three rules are enforced by the types rather than by discipline, because discipline is what
 * fails at 2am in a prompt template:
 *
 * 1. **A candidate cannot exist without its citation.** `citation` is required, and the only
 *    way to build one is `groundedCandidate()`, which takes the citation as an argument. A
 *    future generation step physically cannot hand back a claim with nothing behind it.
 * 2. **Retrieved content is data, not instructions.** Every retrieved string is wrapped in
 *    `RetrievedText` — a tagged value, not a bare string — so text from the library (and
 *    later from a client's own records) cannot be spliced into a prompt as though it were
 *    part of the system's own voice. Unwrapping is explicit and greppable.
 * 3. **Abstention is a result, not an error.** "Nothing here answers this" is a first-class
 *    outcome the caller must handle, so the only way to say nothing is to say so.
 */

/* ── The injection boundary ──────────────────────────────────────────────────────────── */

/**
 * Text that came from somewhere else — a library entry, a document, later a client's own
 * data. Tagged rather than bare so it cannot be mistaken for the system's own words.
 *
 * An approved entry is trusted *content*; it is still not an *instruction*. The boundary
 * holds for trusted sources too, because "approved" describes who ratified the answer, not
 * what a person might have typed inside it.
 */
export type RetrievedText = { readonly kind: "retrieved-data"; readonly text: string };

export const asRetrieved = (text: string): RetrievedText => ({ kind: "retrieved-data", text });

/**
 * Read the text back out. Deliberately a named function: a generation step that wants the raw
 * string has to call this, which makes every such place findable by grep and reviewable as a
 * decision rather than an accident of string concatenation.
 */
export const retrievedText = (value: RetrievedText): string => value.text;

/* ── Citations ───────────────────────────────────────────────────────────────────────── */

/**
 * Where a candidate came from, in a shape that can be shown to a person.
 *
 * A union rather than a loose `{ source, id }` so each kind carries what it actually needs to
 * be checkable — a library citation names the entry and the question it answers; a document
 * citation names the document and the section.
 */
export type GroundingCitation =
  | {
    source: "knowledge-library";
    entryId: string;
    /** The entry's canonical question, so a reader can judge whether it is the right one. */
    question: string;
    /** `internal` grounds staff answers; `public` is additionally client-facing. */
    tier: "internal" | "public";
  }
  | {
    source: "product-docs";
    /** The document this came from, as a path or stable slug. */
    docRef: string;
    section: string;
  }
  | {
    source: "live-data";
    /**
     * Phase 2. Which read model produced the figure, so an answer about a client's own data
     * can be traced to the same resolver the screen used — one source of truth, not a second
     * path that quietly disagrees with the UI.
     */
    readModel: string;
    subject: string;
  };

/** A one-line, human-readable rendering of a citation. */
export function citationLabel(citation: GroundingCitation): string {
  switch (citation.source) {
    case "knowledge-library": return `Knowledge library · ${citation.question}`;
    case "product-docs": return `${citation.docRef} · ${citation.section}`;
    case "live-data": return `${citation.subject} · from ${citation.readModel}`;
  }
}

/* ── Candidates ──────────────────────────────────────────────────────────────────────── */

/**
 * Something that might answer the question, and where it came from.
 *
 * Both fields are required and neither is optional, so there is no shape of this type that
 * represents "an answer with no source".
 */
export type GroundedCandidate = {
  readonly citation: GroundingCitation;
  readonly content: RetrievedText;
  /** How well it matched. Ranks candidates for a reader; it never decides anything alone. */
  readonly score: number;
};

/**
 * The only constructor. Taking the citation as a parameter is what makes an uncited candidate
 * unrepresentable rather than merely discouraged.
 */
export function groundedCandidate(citation: GroundingCitation, content: string, score: number): GroundedCandidate {
  return { citation, content: asRetrieved(content), score };
}

/* ── The result ──────────────────────────────────────────────────────────────────────── */

/**
 * What retrieval returns. A caller must handle both arms, which is the point: there is no way
 * to fall through to "answer anyway".
 */
export type GroundingAbstention = {
  state: "abstained";
  /** Said to the person, in their terms. Never "no results". */
  reason: string;
  /** Whether capturing the question is worth offering — it is, unless they asked nothing. */
  offerCapture: boolean;
};

export type GroundingResult =
  | { state: "grounded"; candidates: GroundedCandidate[] }
  | GroundingAbstention;

/** Below this, a match is noise and pretending otherwise would be the first step to guessing. */
export const GROUNDING_FLOOR = 0.35;

/**
 * The honest abstention.
 *
 * Worded as a statement about the sources, not as a failure of the asker: "nothing in the
 * library covers this" is true and useful; "I couldn't find anything" sounds like the
 * question was wrong.
 */
export function abstain(reason?: string): GroundingAbstention {
  return {
    state: "abstained",
    reason: reason ?? "Nothing in the approved knowledge answers this yet, so there is no grounded answer to give.",
    offerCapture: true,
  };
}

/**
 * Assemble a result from whatever the sources returned.
 *
 * Everything below the floor is dropped **before** the decision, so a page of weak matches
 * abstains rather than presenting its best guess. Ranked highest first; ties are left in
 * source order, which keeps the result deterministic and therefore testable.
 */
export function groundingResult(candidates: readonly GroundedCandidate[], floor = GROUNDING_FLOOR): GroundingResult {
  const worth = candidates.filter((candidate) => candidate.score >= floor);
  if (worth.length === 0) return abstain();
  return { state: "grounded", candidates: [...worth].sort((a, b) => b.score - a.score) };
}

/**
 * A place the assistant may ground an answer.
 *
 * The contract is source-agnostic on purpose: Phase 1 registers the knowledge library (and,
 * when there is one, the product-doc corpus); Phase 2 registers permission-checked read-model
 * tools for a user's own data. A new source is a new implementation of this, not a change to
 * anything above.
 *
 * A source that cannot answer returns `[]`. It never throws to mean "nothing" — an empty
 * result and a broken source are different facts, and only one of them should be silent.
 */
export type GroundingSource<Context = unknown> = {
  readonly id: string;
  /** What it is, for the "sources consulted" line a person can check. */
  readonly label: string;
  /**
   * The one kind of citation this source may produce.
   *
   * **Each corpus is distinct, and a source may only cite its own.** This is the mechanical half
   * of the rule in NZC-084: one approved entry must never reach a reader as two citations. A
   * candidate whose citation kind does not match its source's `emits` is dropped by
   * `retrieveGrounding` and reported, rather than being counted as evidence.
   *
   * The rule exists because corroboration is something a reader *counts*. Two citations look
   * like two independent sources agreeing; if both are the same library entry wearing different
   * hats, the answer has manufactured confidence out of nothing. That is a subtler version of
   * the fabrication this whole design prevents, and harder to spot precisely because every
   * individual citation is real.
   */
  readonly emits: GroundingCitation["source"];
  retrieve(question: string, context: Context): Promise<GroundedCandidate[]>;
};
