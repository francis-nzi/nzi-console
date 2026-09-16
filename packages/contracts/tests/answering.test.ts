import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import {
  ANSWERING_OFF_REASON, UNCITED_ANSWER_REASON, UNVERIFIABLE_CITATION_REASON, groundAnswer,
  type ModelDraft,
} from "../src/answering";
import {
  groundedCandidate, retrievedText, type GroundedCandidate, type GroundingCitation,
} from "../src/grounding";

/**
 * The check between a model's draft and an answer.
 *
 * Phase 0 made an uncited *candidate* impossible. These tests are about the harder case one
 * level up: a model that writes fluent prose and footnotes it to something it was never given.
 */

const citation = (n: number): GroundingCitation => ({
  source: "knowledge-library", entryId: `entry-${n}`,
  question: `Question ${n}?`, tier: "internal",
});

const candidates: GroundedCandidate[] = [
  groundedCandidate(citation(1), "Reviewed means checked internally by an NZI reviewer.", 0.9),
  groundedCandidate(citation(2), "Assurance is a third-party engagement to a recognised standard.", 0.7),
];

const draft = (over: Partial<{ answer: string; cites: readonly number[] }> = {}): ModelDraft =>
  ({ kind: "draft", answer: "Reviewed is internal; assured is third-party.", cites: [1, 2], ...over });

describe("an answer stands on sources it was actually given", () => {
  it("resolves each reference to the candidate behind it", () => {
    const result = groundAnswer(draft(), candidates, "test-model");
    assert.equal(result.state, "answered");
    if (result.state !== "answered") return;
    assert.equal(result.citations.length, 2);
    assert.deepEqual(result.citations.map((c) => c.ref), [1, 2]);
    assert.equal(retrievedText(result.citations[0]!.candidate.content), candidates[0]!.content.text);
  });

  it("carries the model's identity as provenance, like a factor-set version", () => {
    const result = groundAnswer(draft(), candidates, "claude-sonnet-5");
    if (result.state !== "answered") return assert.fail("expected an answer");
    assert.equal(result.modelId, "claude-sonnet-5");
  });

  it("trims the prose but does not otherwise rewrite it", () => {
    const result = groundAnswer(draft({ answer: "  Reviewed is internal.  " }), candidates, "m");
    if (result.state !== "answered") return assert.fail("expected an answer");
    assert.equal(result.answer, "Reviewed is internal.");
  });

  it("tolerates the same source cited twice", () => {
    // Untidy, not dishonest — both references resolve to something real.
    const result = groundAnswer(draft({ cites: [1, 1, 2] }), candidates, "m");
    if (result.state !== "answered") return assert.fail("expected an answer");
    assert.deepEqual(result.citations.map((c) => c.ref), [1, 2]);
  });
});

describe("a fabricated citation refuses the whole answer", () => {
  it("refuses when a reference was never in the candidate set", () => {
    // The failure this file exists for. A footnote to a source that does not exist is worse
    // than a missing footnote: it manufactures the appearance of provenance.
    const result = groundAnswer(draft({ cites: [1, 9] }), candidates, "m");
    assert.equal(result.state, "abstained");
    if (result.state !== "abstained") return;
    assert.equal(result.reason, UNVERIFIABLE_CITATION_REASON);
  });

  it("does not keep the part that happened to resolve", () => {
    // The tempting salvage. A model that invented a reference has shown it is not tracking its
    // sources, and the prose it wrote in that state is the prose whose provenance just failed.
    const result = groundAnswer(draft({ cites: [1, 9] }), candidates, "m");
    assert.equal(result.state, "abstained", "no partial answer survives a bad reference");
  });

  it("refuses a reference that is not a whole number in range", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = groundAnswer(draft({ cites: [bad] }), candidates, "m");
      assert.equal(result.state, "abstained", `cite ${bad} must not resolve`);
    }
  });

  it("refuses against an empty candidate set, however confident the draft", () => {
    const result = groundAnswer(draft({ cites: [1] }), [], "m");
    assert.equal(result.state, "abstained");
  });

  it("says a withheld answer is a fault, not a gap in the knowledge", () => {
    // Different facts. Telling someone their question is unanswered, when in truth an answer was
    // drafted and refused, would send them off to write a library entry that already exists.
    assert.notEqual(UNVERIFIABLE_CITATION_REASON, UNCITED_ANSWER_REASON);
    assert.match(UNVERIFIABLE_CITATION_REASON, /not a gap in the knowledge/);
  });
});

describe("prose without a citation is not an answer", () => {
  it("refuses a draft that cites nothing", () => {
    const result = groundAnswer(draft({ cites: [] }), candidates, "m");
    assert.equal(result.state, "abstained");
    if (result.state !== "abstained") return;
    assert.equal(result.reason, UNCITED_ANSWER_REASON);
  });

  it("refuses citations with no prose behind them", () => {
    const result = groundAnswer(draft({ answer: "   " }), candidates, "m");
    assert.equal(result.state, "abstained");
  });

  it("makes a zero-citation answer unrepresentable in the type", () => {
    // Enforced by the shape — a non-empty tuple, not an array — so "we forgot to check" fails to
    // compile rather than failing a test somebody might delete.
    const source = readFileSync(new URL("../src/answering.ts", import.meta.url), "utf8");
    assert.match(source, /readonly citations: readonly \[AnswerCitation, \.\.\.AnswerCitation\[\]\];/);
  });
});

describe("abstention travels intact", () => {
  it("passes a model's own abstention through with its reason", () => {
    const result = groundAnswer({ kind: "abstain", reason: "The sources cover assurance, not this." }, candidates, "m");
    assert.equal(result.state, "abstained");
    if (result.state !== "abstained") return;
    assert.match(result.reason, /cover assurance/);
  });

  it("falls back to the standard wording when the model gives no reason", () => {
    const result = groundAnswer({ kind: "abstain" }, candidates, "m");
    if (result.state !== "abstained") return assert.fail("expected an abstention");
    assert.match(result.reason, /Nothing in the approved knowledge/);
  });

  it("offers to capture the question, whichever way it abstained", () => {
    for (const d of [{ kind: "abstain" } as const, draft({ cites: [] }), draft({ cites: [9] })]) {
      const result = groundAnswer(d, candidates, "m");
      if (result.state !== "abstained") return assert.fail("expected an abstention");
      assert.equal(result.offerCapture, true);
    }
  });

  it("distinguishes 'not switched on' from 'nothing answers this'", () => {
    // One is a gap in the knowledge; the other is a capability nobody has configured. Collapsing
    // them would tell someone their question is unanswered when nobody has looked.
    assert.match(ANSWERING_OFF_REASON, /not switched on/);
    assert.notEqual(ANSWERING_OFF_REASON, UNCITED_ANSWER_REASON);
  });
});
