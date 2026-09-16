/**
 * The knowledge library — capture → approve → publish.
 *
 * NZI's own shared knowledge, not per-client data: an answer written while working on one
 * client is visible to every NZI staff member. Nothing here is scoped by client, and nothing
 * should become so.
 *
 * Two tiers with different meanings. **internal** makes an entry live for staff and lets the
 * help AI cite it; **public** makes it client-facing and website-bound. They are separate
 * capabilities because they are separate risks.
 *
 * The integrity guarantee the whole help system rests on: **an AI-drafted answer is a draft
 * and nothing else** until a person ratifies it. The AI proposes; a human approves. That is
 * what makes a cited entry worth citing.
 */

export const knowledgeStatuses = ["draft", "internal", "public"] as const;
export type KnowledgeStatus = (typeof knowledgeStatuses)[number];

export const knowledgeStatusLabels: Record<KnowledgeStatus, string> = {
  draft: "Draft",
  internal: "Internal",
  public: "Public",
};

/** Who wrote the answer. An `ai` draft never reaches a reader without approval. */
export const knowledgeDrafters = ["human", "ai"] as const;
export type KnowledgeDrafter = (typeof knowledgeDrafters)[number];

/** What a version row records, so the history reads without diffing two snapshots. */
export const knowledgeChanges = [
  "captured", "edited", "approved", "published", "rejected", "merged", "deactivated", "revision-applied",
] as const;
export type KnowledgeChange = (typeof knowledgeChanges)[number];

export type KnowledgeEntry = {
  id: string;
  canonicalQuestion: string;
  canonicalKey: string;
  answer: string;
  status: KnowledgeStatus;
  category: string;
  area: string;
  /** Alternative phrasings that resolve to this entry. */
  aliases: Array<{ key: string; question: string }>;
  askedBy: string;
  draftedBy: string;
  draftedByKind: KnowledgeDrafter;
  approvedBy: string | null;
  approvedAt: string | null;
  publishedBy: string | null;
  publishedAt: string | null;
  possibleDuplicate: boolean;
  duplicateOfEntryId: string | null;
  /** Set when this draft is a pending edit to an already-approved entry. */
  revisesEntryId: string | null;
  version: number;
  active: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

/**
 * The normalised form of a question: lowercased, punctuation stripped, whitespace collapsed.
 *
 * One function, used for the canonical key, for aliases, and for similarity lookup — if the
 * three normalised differently, an entry could fail to match its own alias.
 */
export function knowledgeKey(question: string): string {
  return question
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/* ── The lifecycle ───────────────────────────────────────────────────────────────────── */

/**
 * Which transitions exist, and what each one needs.
 *
 * Expressed as data rather than as a chain of `if`s in the command, so the rule can be read
 * in one place and asserted directly. `publish` is deliberately not reachable from `draft`:
 * nothing becomes client-facing without first having been approved internally.
 */
export const knowledgeTransitions = {
  approve: { from: "draft", to: "internal", capability: "knowledge.approve" },
  publish: { from: "internal", to: "public", capability: "knowledge.publish" },
} as const satisfies Record<string, { from: KnowledgeStatus; to: KnowledgeStatus; capability: string }>;

export type KnowledgeTransition = keyof typeof knowledgeTransitions;

/** Whether an entry in `status` may take `transition` — the status rule, not the permission. */
export function canTransition(status: KnowledgeStatus, transition: KnowledgeTransition): boolean {
  return knowledgeTransitions[transition].from === status;
}

/**
 * Why a transition is refused, in the words the person needs.
 *
 * `null` when it is allowed. Deliberately specific about the two-tier rule: "already
 * published" and "not approved yet" are different problems with different next steps.
 */
export function transitionRefusal(status: KnowledgeStatus, transition: KnowledgeTransition): string | null {
  if (canTransition(status, transition)) return null;
  if (transition === "approve") {
    return status === "internal"
      ? "This entry is already approved for internal use."
      : "This entry is already published, so there is nothing to approve.";
  }
  return status === "draft"
    ? "Approve this for internal use first — nothing goes client-facing without an internal approval behind it."
    : "This entry is already public.";
}

/* ── Duplicate handling ──────────────────────────────────────────────────────────────── */

/**
 * A candidate the asker is shown *before* their draft is created.
 *
 * `score` is a trigram similarity in 0–1. It ranks; it never decides. The whole dedup design
 * is that a person adjudicates — which is also why a weak lexical match is acceptable here
 * and a silent auto-merge would not be.
 */
export type KnowledgeSimilarCandidate = {
  entryId: string;
  question: string;
  status: KnowledgeStatus;
  /** Whether the match was against the canonical question or one of its aliases. */
  matchedOn: "canonical" | "alias";
  score: number;
  /** Set for a pending draft, so the UI can say "someone is already asking this". */
  draftedBy: string | null;
};

/**
 * What the capture UI offers, given what similarity found.
 *
 * Three outcomes, and the wording of each matters: a person deciding between "this is my
 * question" and "this is close but different" is the step that stops the library filling
 * with near-duplicates.
 */
export type KnowledgeCaptureOffer =
  | { kind: "none"; detail: string }
  | { kind: "candidates"; detail: string; candidates: KnowledgeSimilarCandidate[] };

/** The threshold below which a trigram match is noise rather than a candidate. */
export const KNOWLEDGE_SIMILARITY_FLOOR = 0.3;

/** Above this, a new draft is flagged `possible_duplicate` for the approver. */
export const KNOWLEDGE_DUPLICATE_FLAG = 0.6;

export function captureOffer(candidates: readonly KnowledgeSimilarCandidate[]): KnowledgeCaptureOffer {
  const worth = candidates.filter((entry) => entry.score >= KNOWLEDGE_SIMILARITY_FLOOR);
  if (worth.length === 0) {
    return { kind: "none", detail: "Nothing similar is in the library yet, so this will start a new draft." };
  }
  return {
    kind: "candidates",
    detail: "These look close. Open one to read its answer, add your wording to it as an alias, or carry on with a new draft.",
    candidates: [...worth].sort((a, b) => b.score - a.score),
  };
}

/** Whether a new draft should carry the possible-duplicate flag into the review queue. */
export const flagsAsDuplicate = (candidates: readonly KnowledgeSimilarCandidate[]): boolean =>
  candidates.some((entry) => entry.score >= KNOWLEDGE_DUPLICATE_FLAG);
