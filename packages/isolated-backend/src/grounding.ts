import {
  GROUNDING_FLOOR, groundedCandidate, groundingResult,
  type GroundedCandidate, type GroundingResult, type GroundingSource,
} from "@nzi/contracts";
import { findSimilarKnowledge, getKnowledgeEntry } from "./knowledgeRecords";
import type { Queryable } from "./postgres";

/**
 * Retrieval over the governed sources — the plumbing Phase 1 generates on top of.
 *
 * There is **no model call here and there is not meant to be**. What this produces is a set of
 * cited candidates or an explicit abstention; turning those into prose is Phase 1's job, and
 * keeping the two apart is what makes the citation rule testable before any of it exists.
 */

export type GroundingContext = { db: Queryable };

/**
 * The knowledge library as a grounding source.
 *
 * **Approved entries only.** A draft is, by definition, something no one has ratified — the
 * whole integrity argument for citing the library is that a person stood behind the answer.
 * Grounding on drafts would let an unreviewed answer (including one the assistant itself
 * proposed) come back as though it were established, which is exactly the loop the two-tier
 * approval exists to break.
 *
 * Reuses 0a's `findSimilarKnowledge`, so the same matching that stops duplicate capture also
 * decides what grounds an answer — one notion of "this question is that question", not two
 * that can disagree.
 */
export const knowledgeLibrarySource: GroundingSource<GroundingContext> = {
  id: "knowledge-library",
  label: "Approved knowledge library",
  async retrieve(question, { db }) {
    const similar = await findSimilarKnowledge(db, question);
    const approved = similar.filter((candidate) => candidate.status !== "draft");

    const candidates: GroundedCandidate[] = [];
    for (const match of approved) {
      const entry = await getKnowledgeEntry(db, match.entryId);
      // Gone or withdrawn between the match and the read: silently dropping it is right —
      // an entry that no longer exists cannot be cited, and half-citing it would be worse.
      if (entry === null || !entry.active || entry.status === "draft") continue;
      candidates.push(groundedCandidate(
        { source: "knowledge-library", entryId: entry.id, question: entry.canonicalQuestion, tier: entry.status },
        entry.answer,
        match.score,
      ));
    }
    return candidates;
  },
};

/**
 * Product documentation — declared, deliberately empty.
 *
 * The design names docs as a grounding source and they will be one. **There is no doc corpus
 * to index yet**, so this returns nothing rather than pretending: an empty source is honest,
 * and a source that fabricated citations to documents that do not exist would be the exact
 * failure this whole design is built to avoid.
 *
 * It is registered anyway so the shape is exercised and Phase 1 has somewhere to plug a
 * corpus into without changing the contract.
 *
 * **Not backed by public library entries**, which was the alternative. Those are already
 * returned by the library source above, so re-serving them here would return one answer under
 * two citations — making a single source look like two corroborating ones. Apparent
 * corroboration that is really one entry counted twice is precisely the kind of false
 * confidence a grounded system must not manufacture.
 */
export const productDocsSource: GroundingSource<GroundingContext> = {
  id: "product-docs",
  label: "Product documentation (no corpus indexed yet)",
  async retrieve() {
    return [];
  },
};

/** The sources consulted today. Phase 2 adds permission-checked live-data tools here. */
export const GROUNDING_SOURCES: Array<GroundingSource<GroundingContext>> = [
  knowledgeLibrarySource,
  productDocsSource,
];

/**
 * Ask every source, and return cited candidates or an honest abstention.
 *
 * A source that throws is **reported, not swallowed**: "we could not read the library" and
 * "the library has nothing on this" are opposite claims, and abstaining on a broken source
 * would tell someone their question is unanswered when it may well be answered.
 */
export async function retrieveGrounding(
  question: string,
  context: GroundingContext,
  sources: ReadonlyArray<GroundingSource<GroundingContext>> = GROUNDING_SOURCES,
): Promise<GroundingResult & { consulted: string[]; failed: string[] }> {
  const trimmed = question.trim();
  if (trimmed === "") {
    return { state: "abstained", reason: "Ask a question and I will look for a grounded answer.", offerCapture: false, consulted: [], failed: [] };
  }

  const consulted: string[] = [];
  const failed: string[] = [];
  const candidates: GroundedCandidate[] = [];

  for (const source of sources) {
    try {
      candidates.push(...await source.retrieve(trimmed, context));
      consulted.push(source.label);
    } catch {
      failed.push(source.label);
    }
  }

  if (failed.length > 0 && candidates.length === 0) {
    // Degraded, not empty. Offering to capture a question that may already be answered would
    // fill the library with duplicates of things it already holds.
    return {
      state: "abstained",
      reason: `I could not read ${failed.join(" or ")}, so I cannot tell you whether this is answered. This is a fault, not an absence — try again shortly.`,
      offerCapture: false,
      consulted, failed,
    };
  }

  return { ...groundingResult(candidates, GROUNDING_FLOOR), consulted, failed };
}
