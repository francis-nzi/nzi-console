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
  emits: "knowledge-library",
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
 * It is registered anyway so the shape is exercised and a corpus has somewhere to plug in
 * without changing the contract.
 *
 * ## The rule this source exists under — NZC-084
 *
 * **Product docs are a distinct corpus. They must never be re-served from public-tier library
 * entries, and one approved entry must never appear as two corroborating citations.**
 *
 * This binds whoever populates the corpus later, not just this stub. Serving public-tier
 * entries here is the obvious shortcut — the content is already written, already approved,
 * already public — and it is forbidden, because those entries are *already* returned by the
 * library source above. Re-serving them would put one answer in front of a reader under two
 * citations.
 *
 * That matters more than it first appears. Corroboration is something a reader **counts**: two
 * citations read as two sources that independently agree, and a person weighs an answer more
 * heavily for it. If both are the same entry wearing different hats, the extra confidence is
 * manufactured out of nothing. Every individual citation is real, which is exactly why it would
 * survive review — it is a harder failure to catch than an invented citation, and it corrupts
 * the one signal this design asks people to trust.
 *
 * When a real corpus arrives it must be documents in their own right — a doc, a section, text
 * that exists in that document — and where a document and a library entry genuinely say the
 * same thing, that is two sources agreeing and both may be cited. The prohibition is on one
 * source being **dressed as two**, not on genuine agreement.
 *
 * The mechanical half of the rule lives in `emits` and is enforced in `retrieveGrounding`: a
 * source may only produce citations of its own kind, so a doc source cannot hand back
 * `knowledge-library` citations. The rest is this comment and the decision record, because a
 * doc source that re-served entry text under a fabricated `docRef` would be indistinguishable
 * from a real corpus to any check we could write.
 */
export const productDocsSource: GroundingSource<GroundingContext> = {
  id: "product-docs",
  label: "Product documentation (no corpus indexed yet)",
  emits: "product-docs",
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
      const produced = await source.retrieve(trimmed, context);
      // NZC-084: a source may only cite its own corpus. A candidate citing someone else's is
      // dropped rather than counted — the failure it guards against is one approved entry
      // reaching a reader as two citations, which reads as two sources agreeing when it is one
      // source wearing two hats. Reported as a failed source, because a source returning
      // citations that are not its own is malfunctioning, and silence would hide that.
      const own = produced.filter((candidate) => candidate.citation.source === source.emits);
      if (own.length !== produced.length) failed.push(source.label);
      candidates.push(...own);
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
