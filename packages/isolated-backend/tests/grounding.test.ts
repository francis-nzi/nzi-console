import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { retrievedText, type GroundingSource } from "@nzi/contracts";
import { knowledgeLibrarySource, productDocsSource, retrieveGrounding, type GroundingContext } from "../src/grounding";

/**
 * Retrieval over the real sources. No model is involved and none should be: what is asserted
 * here is that cited candidates come back for a match, an honest abstention comes back for a
 * miss, and a broken source is never mistaken for an empty one.
 */

type Row = Record<string, unknown>;

const entry = (over: Row = {}): Row => ({
  entry_id: "entry-a",
  canonical_question: "What does reviewed, not assured mean?",
  canonical_key: "what does reviewed not assured mean",
  answer: "Reviewed means checked internally by an NZI reviewer; it is not third-party assurance.",
  status: "internal", category: "", area: "",
  asked_by: "", drafted_by: "m.osei", drafted_by_kind: "human",
  approved_by: "admin", approved_at: "2026-09-16T09:00:00Z", published_by: null, published_at: null,
  possible_duplicate: false, duplicate_of_entry_id: null, revises_entry_id: null,
  version: 2, active: true, created_by: "m.osei",
  created_at: "2026-09-15T09:00:00Z", updated_at: "2026-09-16T09:00:00Z", aliases: [],
  ...over,
});

/** Answers the two statements the library source issues: similarity, then the entry itself. */
const dbWith = (entries: Row[], score = 0.8) => ({
  async query(sql: string) {
    if (sql.includes("WITH scored AS")) {
      return { rows: entries.map((row) => ({
        entry_id: row.entry_id, question: row.canonical_question, status: row.status,
        matched_on: "canonical", score, drafted_by: null,
      })) };
    }
    if (sql.includes("FROM nzi_console.knowledge_entries e WHERE e.entry_id")) {
      return { rows: entries };
    }
    return { rows: [] };
  },
});

const context = (db: unknown): GroundingContext => ({ db: db as GroundingContext["db"] });

describe("a match comes back cited", () => {
  it("returns the entry, its answer, and where it came from", async () => {
    const result = await retrieveGrounding("what does reviewed not assured mean", context(dbWith([entry()])));
    assert.equal(result.state, "grounded");
    if (result.state !== "grounded") return;
    const [first] = result.candidates;
    assert.ok(first);
    assert.equal(first.citation.source, "knowledge-library");
    if (first.citation.source !== "knowledge-library") return;
    assert.equal(first.citation.entryId, "entry-a");
    assert.equal(first.citation.question, "What does reviewed, not assured mean?");
    assert.equal(first.citation.tier, "internal");
    assert.match(retrievedText(first.content), /not third-party assurance/);
  });

  it("carries the content as data rather than as a string", async () => {
    const result = await retrieveGrounding("reviewed not assured", context(dbWith([entry()])));
    if (result.state !== "grounded") return assert.fail("expected a grounded result");
    assert.equal(result.candidates[0]!.content.kind, "retrieved-data");
  });

  it("says which sources it consulted, so a person can check the claim", async () => {
    const result = await retrieveGrounding("reviewed not assured", context(dbWith([entry()])));
    assert.ok(result.consulted.includes("Approved knowledge library"));
    assert.deepEqual(result.failed, []);
  });
});

describe("a miss abstains honestly", () => {
  it("abstains when the library holds nothing similar", async () => {
    const result = await retrieveGrounding("how do I reset the coffee machine", context(dbWith([])));
    assert.equal(result.state, "abstained");
    if (result.state !== "abstained") return;
    assert.match(result.reason, /no grounded answer/);
    assert.equal(result.offerCapture, true, "and offers to capture it for the team");
  });

  it("abstains on a weak match rather than offering its best guess", async () => {
    const result = await retrieveGrounding("something vaguely related", context(dbWith([entry()], 0.2)));
    assert.equal(result.state, "abstained");
  });

  it("asks for a question rather than abstaining at an empty one", async () => {
    const result = await retrieveGrounding("   ", context(dbWith([entry()])));
    assert.equal(result.state, "abstained");
    if (result.state !== "abstained") return;
    assert.equal(result.offerCapture, false, "there is nothing to capture");
    assert.match(result.reason, /Ask a question/);
  });
});

describe("only ratified knowledge grounds an answer", () => {
  it("never cites a draft", async () => {
    // The integrity argument for citing the library at all is that a person stood behind the
    // answer. Grounding on drafts would let an unreviewed answer — including one the
    // assistant proposed itself — come back as though it were established.
    const result = await retrieveGrounding("reviewed not assured", context(dbWith([entry({ status: "draft" })])));
    assert.equal(result.state, "abstained");
  });

  it("never cites a withdrawn entry", async () => {
    const result = await retrieveGrounding("reviewed not assured", context(dbWith([entry({ active: false })])));
    assert.equal(result.state, "abstained");
  });
});

describe("the sources behind the contract", () => {
  it("declares product docs but indexes no corpus yet, rather than inventing one", async () => {
    // An empty source is honest. One that fabricated citations to documents that do not exist
    // would be the exact failure this design exists to prevent.
    assert.deepEqual(await productDocsSource.retrieve("anything", context(dbWith([]))), []);
    assert.match(productDocsSource.label, /no corpus indexed yet/);
  });

  it("does not re-serve library entries as documents", async () => {
    // The tempting shortcut. It would return one answer under two citations and make a single
    // source look like two corroborating ones.
    assert.equal(knowledgeLibrarySource.id, "knowledge-library");
    assert.equal(productDocsSource.id, "product-docs");
    assert.deepEqual(await productDocsSource.retrieve("reviewed not assured", context(dbWith([entry()]))), []);
  });

  it("reports a broken source instead of calling it an absence", async () => {
    // "We could not read the library" and "the library has nothing on this" are opposite
    // claims, and abstaining on the first would tell someone their question is unanswered.
    const broken: GroundingSource<GroundingContext> = {
      id: "broken", label: "the knowledge library",
      async retrieve() { throw new Error("relation does not exist"); },
    };
    const result = await retrieveGrounding("anything", context(dbWith([])), [broken]);
    assert.equal(result.state, "abstained");
    if (result.state !== "abstained") return;
    assert.match(result.reason, /This is a fault, not an absence/);
    assert.equal(result.offerCapture, false, "capturing a question that may be answered would duplicate it");
    assert.deepEqual(result.failed, ["the knowledge library"]);
  });

  it("still answers from the sources that worked", async () => {
    const broken: GroundingSource<GroundingContext> = {
      id: "broken", label: "docs", async retrieve() { throw new Error("nope"); },
    };
    const result = await retrieveGrounding("reviewed not assured", context(dbWith([entry()])), [knowledgeLibrarySource, broken]);
    assert.equal(result.state, "grounded");
    assert.deepEqual(result.failed, ["docs"]);
  });
});
