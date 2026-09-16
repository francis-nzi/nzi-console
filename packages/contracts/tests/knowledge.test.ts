import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  KNOWLEDGE_DUPLICATE_FLAG, KNOWLEDGE_SIMILARITY_FLOOR, canTransition, captureOffer,
  flagsAsDuplicate, knowledgeKey, knowledgeTransitions, transitionRefusal,
  type KnowledgeSimilarCandidate,
} from "../src/knowledge";
import { ROLE_CAPABILITY_MATRIX, PERMISSION_MATRIX_VERSION } from "../src/permissions";

/**
 * The knowledge library's rules. The ones that matter: nothing reaches the client-facing
 * tier without an internal approval behind it, and duplicate handling surfaces rather than
 * decides.
 */

const candidate = (over: Partial<KnowledgeSimilarCandidate> = {}): KnowledgeSimilarCandidate => ({
  entryId: "entry-a", question: "What does reviewed not assured mean?", status: "internal",
  matchedOn: "canonical", score: 0.8, draftedBy: null, ...over,
});

describe("normalising a question", () => {
  it("resolves the same question asked differently to one key", () => {
    // The canonical key, aliases and similarity lookup all use this one function — if they
    // normalised differently an entry could fail to match its own alias.
    assert.equal(knowledgeKey("What does 'reviewed, not assured' mean?"), "what does reviewed not assured mean");
    assert.equal(knowledgeKey("  WHAT   does REVIEWED, not ASSURED mean??  "), "what does reviewed not assured mean");
  });

  it("keeps genuinely different questions apart", () => {
    assert.notEqual(knowledgeKey("How do I publish a report?"), knowledgeKey("How do I approve a report?"));
  });
});

describe("the two tiers", () => {
  it("lets a draft be approved to internal", () => {
    assert.equal(canTransition("draft", "approve"), true);
    assert.equal(transitionRefusal("draft", "approve"), null);
  });

  it("refuses to publish a draft that was never approved internally", () => {
    // The firewall: nothing becomes client-facing without a human having ratified it first.
    assert.equal(canTransition("draft", "publish"), false);
    assert.match(transitionRefusal("draft", "publish")!, /Approve this for internal use first/);
  });

  it("lets an internal entry be published", () => {
    assert.equal(canTransition("internal", "publish"), true);
  });

  it("says which problem it is rather than refusing generically", () => {
    // "Already published" and "not approved yet" need different next steps.
    assert.match(transitionRefusal("internal", "approve")!, /already approved for internal use/);
    assert.match(transitionRefusal("public", "approve")!, /already published/);
    assert.match(transitionRefusal("public", "publish")!, /already public/);
  });

  it("binds each tier to its own capability", () => {
    assert.equal(knowledgeTransitions.approve.capability, "knowledge.approve");
    assert.equal(knowledgeTransitions.publish.capability, "knowledge.publish");
  });
});

describe("who holds what", () => {
  it("puts publication with Admin alone, which is what gives the tiers teeth", () => {
    assert.equal(ROLE_CAPABILITY_MATRIX.admin["knowledge.publish"], "all");
    for (const role of ["consultant", "reviewer", "finance", "viewer"] as const) {
      assert.equal(ROLE_CAPABILITY_MATRIX[role]["knowledge.publish"], undefined, `${role} must not publish`);
    }
  });

  it("lets a Consultant approve to internal but go no further", () => {
    assert.equal(ROLE_CAPABILITY_MATRIX.consultant["knowledge.approve"], "all");
    assert.equal(ROLE_CAPABILITY_MATRIX.consultant["knowledge.publish"], undefined);
  });

  it("opens capture to every role — anyone who answers a question can offer it", () => {
    for (const role of ["admin", "consultant", "reviewer", "finance", "viewer"] as const) {
      assert.equal(ROLE_CAPABILITY_MATRIX[role]["knowledge.capture"], "all", role);
    }
  });

  it("ships as a new matrix version rather than an edit to the last one", () => {
    assert.equal(PERMISSION_MATRIX_VERSION, 4);
  });
});

describe("duplicate handling surfaces, it never decides", () => {
  it("offers the close ones, best first", () => {
    const offer = captureOffer([candidate({ entryId: "b", score: 0.45 }), candidate({ entryId: "a", score: 0.9 })]);
    assert.equal(offer.kind, "candidates");
    if (offer.kind !== "candidates") return;
    assert.deepEqual(offer.candidates.map((entry) => entry.entryId), ["a", "b"]);
    assert.match(offer.detail, /add your wording to it as an alias/);
  });

  it("drops noise below the floor rather than offering everything", () => {
    const offer = captureOffer([candidate({ score: KNOWLEDGE_SIMILARITY_FLOOR - 0.01 })]);
    assert.equal(offer.kind, "none");
    assert.match(offer.detail, /Nothing similar is in the library yet/);
  });

  it("flags a close match for the approver without blocking the draft", () => {
    // Surfaced, not refused: the person asking may genuinely mean something different, and
    // the approver is the one who adjudicates.
    assert.equal(flagsAsDuplicate([candidate({ score: KNOWLEDGE_DUPLICATE_FLAG })]), true);
    assert.equal(flagsAsDuplicate([candidate({ score: KNOWLEDGE_DUPLICATE_FLAG - 0.01 })]), false);
    const offer = captureOffer([candidate({ score: 0.95 })]);
    assert.equal(offer.kind, "candidates", "a near-certain duplicate is still only an offer");
  });

  it("matches on an alias as readily as on the canonical question", () => {
    // The point of aliases: a rephrasing should find the entry that already answers it.
    const offer = captureOffer([candidate({ matchedOn: "alias", score: 0.7 })]);
    assert.equal(offer.kind, "candidates");
    if (offer.kind !== "candidates") return;
    assert.equal(offer.candidates[0]!.matchedOn, "alias");
  });
});
