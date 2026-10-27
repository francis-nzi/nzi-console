import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import type { SrsSuggestionInput } from "@nzi/contracts";
import { DEFAULT_ANSWER_MODEL } from "../src/answerModel";
import { anthropicSrsSuggestionModel, DEFAULT_SRS_SUGGESTION_MODEL, generateSrsGapSuggestions, srsPromptSha256, type SrsSuggestionModel } from "../src/srsSuggestions";

/**
 * SRS S3 — the AI ideas, without a key: the generator keeps only grounded ideas and names its request by SHA-256; the SDK
 * adapter asks Sonnet for the schema's shape at low effort (the refusal fallback only where documented), sends the
 * fixed instructions as a cached system block and the client's details as data, and treats a refusal as no ideas.
 */

const input: SrsSuggestionInput = {
  requirement: { code: "S2 G1", title: "Board oversight", helpText: "Say who oversees climate risk.", pillar: "Governance", standard: "UK SRS S2" },
  stepNow: null, stepTarget: "Established", sector: null,
  facts: { scopesReported: { scope1: true, scope2: false, scope3: false }, targetsSet: false, targetProgressMeasured: false, provenanceStamped: false, independentlyAssured: false },
  libraryTitles: [],
};

describe("AI ideas for a gap — the generator and the adapter", () => {
  it("keeps only grounded ideas and names the request by its prompt's SHA-256", async () => {
    let seen: { system: string; user: string } | null = null;
    const model: SrsSuggestionModel = { id: "fake", async suggest(prompt) { seen = prompt; return { kind: "reply", body: { suggestions: [
      { title: "Name a board sponsor for climate", how: "Give one director accountability so oversight of climate risk is recorded." },
      { title: "Cut emissions by 40%", how: "A target the model invented, which no client may be shown as a fact." },
    ] } }; } };
    const run = await generateSrsGapSuggestions(model, input);
    assert.deepEqual(run.suggestions.map((idea) => idea.title), ["Name a board sponsor for climate"]);
    assert.deepEqual(run.refused, ["contains a figure"]);
    assert.equal(run.promptSha256, srsPromptSha256(seen!));
    assert.match(run.promptSha256, /^[0-9a-f]{64}$/);
    assert.equal(run.refusedByModel, false);
  });

  it("asks Sonnet for the schema at low effort, with the instructions cached — the same Sonnet as help→ask", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const client = { beta: { messages: { create: async (body: Record<string, unknown>) => {
      calls.push(body);
      return { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ suggestions: [] }) }] };
    } } } } as unknown as Anthropic;
    const model = anthropicSrsSuggestionModel({ apiKey: "unused", client });
    assert.equal(model.id, DEFAULT_SRS_SUGGESTION_MODEL);
    assert.equal(DEFAULT_SRS_SUGGESTION_MODEL, "claude-sonnet-5");
    assert.equal(DEFAULT_SRS_SUGGESTION_MODEL, DEFAULT_ANSWER_MODEL, "one Sonnet for both AI paths");
    await generateSrsGapSuggestions(model, input);
    const body = calls[0]!;
    assert.equal(body.model, "claude-sonnet-5");
    // Sonnet 5 has no classifier refusals and is not documented for the server-side fallback: the parameter is not sent.
    assert.ok(!("fallbacks" in body) && !("betas" in body), "no fallback parameter on a model not documented for it");
    // The models that have it still get it — the gate, both ways.
    const opusCalls: Array<Record<string, unknown>> = [];
    const opus = anthropicSrsSuggestionModel({ apiKey: "unused", model: "claude-opus-5-5",
      client: { beta: { messages: { create: async (sent: Record<string, unknown>) => { opusCalls.push(sent); return { stop_reason: "end_turn", content: [{ type: "text", text: "{\"suggestions\":[]}" }] }; } } } } as unknown as Anthropic });
    await generateSrsGapSuggestions(opus, input);
    assert.deepEqual([opusCalls[0]!.betas, opusCalls[0]!.fallbacks], [["server-side-fallback-2026-07-01"], "default"]);
    assert.deepEqual((body.output_config as { effort: string }).effort, "low");
    assert.equal(((body.output_config as { format: { type: string } }).format).type, "json_schema");
    assert.ok(!("temperature" in body) && !("thinking" in body), "no sampling or thinking settings the model rejects");
    const system = body.system as Array<{ text: string; cache_control: unknown }>;
    assert.deepEqual(system[0]!.cache_control, { type: "ephemeral" });
    assert.match(system[0]!.text, /Never include any number/);
    const messages = body.messages as Array<{ role: string; content: string }>;
    assert.deepEqual(messages.map((message) => message.role), ["user"]);
    assert.doesNotThrow(() => JSON.parse(messages[0]!.content), "the client's details go as data");
  });

  it("treats a refusal, or an unreadable reply, as no ideas — never a guess", async () => {
    const reply = (response: Record<string, unknown>) => anthropicSrsSuggestionModel({ apiKey: "unused",
      client: { beta: { messages: { create: async () => response } } } as unknown as Anthropic });
    const refused = await generateSrsGapSuggestions(reply({ stop_reason: "refusal", content: [] }), input);
    assert.deepEqual([refused.suggestions, refused.refusedByModel], [[], true]);
    const garbled = await generateSrsGapSuggestions(reply({ stop_reason: "end_turn", content: [{ type: "text", text: "Here are some ideas: …" }] }), input);
    assert.deepEqual([garbled.suggestions, garbled.refusedByModel], [[], false]);
  });
});
