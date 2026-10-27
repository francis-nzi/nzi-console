import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import { SPEND_SUGGESTION_SCHEMA, spendSuggestionInputFor } from "@nzi/contracts";
import { anthropicSpendSuggestionModel, DEFAULT_ANSWER_MODEL, generateSpendSuggestion } from "../src/index";

/**
 * Data entry D2 (R5): the allocation suggestion uses S3's adapter — the same Sonnet as help→ask, structured output against this
 * task's schema, low effort, the fixed instructions as a cached system block and the line as data, no server-side fallback on a
 * model it is not documented for — and a refusal is no suggestion, never a guess.
 */
describe("the D2 suggestion adapter", () => {
  const input = spendSuggestionInputFor({ glCode: "6100", description: "Rail fares" })!;

  it("asks claude-sonnet-5, at low effort, for this task's schema, with the cached system block and the line as data", async () => {
    const sent: Array<Record<string, any>> = [];
    const client = { beta: { messages: { create: async (body: Record<string, any>) => { sent.push(body); return { stop_reason: "end_turn", content: [{ type: "text", text: "{\"categoryCode\":\"3.6\",\"reason\":\"Rail fares are business travel.\"}" }] }; } } } } as unknown as Anthropic;
    const run = await generateSpendSuggestion(anthropicSpendSuggestionModel({ apiKey: "unused", client }), input);
    assert.deepEqual(run.suggestion, { categoryCode: "3.6", reason: "Rail fares are business travel." });
    const body = sent[0]!;
    assert.equal(body.model, "claude-sonnet-5");
    assert.equal(body.model, DEFAULT_ANSWER_MODEL, "the same Sonnet as help→ask");
    assert.equal(body.output_config.effort, "low");
    assert.deepEqual(body.output_config.format, { type: "json_schema", schema: SPEND_SUGGESTION_SCHEMA });
    assert.deepEqual(body.system[0].cache_control, { type: "ephemeral" });
    assert.ok(!("fallbacks" in body) && !("betas" in body), "no server-side fallback where it is not documented");
    assert.deepEqual(JSON.parse(body.messages[0].content).glCode, "6100");
    assert.match(run.promptSha256, /^[0-9a-f]{64}$/);
  });

  it("a refusal, or an unreadable reply, is no suggestion", async () => {
    const refusing = { beta: { messages: { create: async () => ({ stop_reason: "refusal", content: [] }) } } } as unknown as Anthropic;
    assert.equal((await generateSpendSuggestion(anthropicSpendSuggestionModel({ apiKey: "unused", client: refusing }), input)).suggestion, null);
    const garbled = { beta: { messages: { create: async () => ({ stop_reason: "end_turn", content: [{ type: "text", text: "not json" }] }) } } } as unknown as Anthropic;
    assert.equal((await generateSpendSuggestion(anthropicSpendSuggestionModel({ apiKey: "unused", client: garbled }), input)).suggestion, null);
  });
});
