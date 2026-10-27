import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import {
  groundSrsSuggestions, srsSuggestionPrompt, SRS_SUGGESTION_SCHEMA,
  type SrsSuggestionDraft, type SrsSuggestionInput,
} from "@nzi/contracts";
import type { Queryable } from "./postgres";
import { CommandValidationError } from "./postgresCommands";
import { listLibraryStrategies } from "./reductionStrategies";
import { getSrsAssessment, resolveNziFacts } from "./srsReadiness";
import { getSrsFramework } from "./srsReadinessRecords";

/**
 * SRS S3 — AI ideas for bridging a readiness gap (R2, R3, R8).
 *
 * **The AI proposes; a person decides.** This module asks a model for action ideas and returns only the ones that pass
 * `groundSrsSuggestions` (action-shaped; no figure, no claim). It writes nothing: storing what is shown is the
 * `srs.gap.suggestions.record` command, run after this returns — never a model call inside a transaction.
 *
 * **What leaves the platform is the `SrsSuggestionInput` and nothing else** (R8): the requirement and its gap in words, the
 * client's sector, yes/no facts about their assured record, and the library titles already aligned. No client name, no
 * person, no figure. `srsSuggestionInputFor` is the only builder of that input, and the boundary is tested on what it
 * produces.
 *
 * The model sits behind `SrsSuggestionModel` so the rules are testable without a key; the real adapter uses the official
 * Anthropic SDK, with structured output (the schema), adaptive thinking at low effort (a short, grounded task) and the
 * server-side refusal fallback. The API key is passed in at the composition edge, never read here.
 */

export type SrsSuggestionModel = {
  /** The model that answers — recorded beside every stored idea. */
  id: string;
  /** The parsed JSON reply (the schema's shape), or a refusal. Throws on a transport fault. */
  suggest(prompt: { system: string; user: string }): Promise<{ kind: "reply"; body: unknown } | { kind: "refused" }>;
};

/** The current Opus — a short task, so effort is kept low rather than the model changed. */
export const DEFAULT_SRS_SUGGESTION_MODEL = "claude-opus-5-5";

export function anthropicSrsSuggestionModel(config: { apiKey: string; model?: string; client?: Anthropic }): SrsSuggestionModel {
  const model = config.model ?? DEFAULT_SRS_SUGGESTION_MODEL;
  const client = config.client ?? new Anthropic({ apiKey: config.apiKey });
  return {
    id: model,
    async suggest(prompt) {
      const response = await client.beta.messages.create({
        model,
        max_tokens: 16000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        // The fixed instructions cache; the client's details arrive as data in the user turn.
        system: [{ type: "text", text: prompt.system, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: prompt.user }],
        output_config: { effort: "low", format: { type: "json_schema", schema: SRS_SUGGESTION_SCHEMA as unknown as Record<string, unknown> } },
      });
      if (response.stop_reason === "refusal") return { kind: "refused" };
      const text = response.content.filter((block) => block.type === "text").map((block) => (block as { text: string }).text).join("");
      try {
        return { kind: "reply", body: JSON.parse(text) as unknown };
      } catch {
        // An unreadable reply is no ideas, never a guess at what was meant.
        return { kind: "reply", body: { suggestions: [] } };
      }
    },
  };
}

/** The SHA-256 of the exact prompt sent — how the audit trail names the request without keeping it. */
export const srsPromptSha256 = (prompt: { system: string; user: string }) =>
  createHash("sha256").update(`${prompt.system}\n\n${prompt.user}`).digest("hex");

/**
 * Build what the model is told about one gap — and refuse a requirement that is not a gap. Reads the assessment, the
 * framework version it was made against, the client's sector and S1's yes/no facts, and the library's aligned titles.
 */
export async function srsSuggestionInputFor(db: Queryable, input: { assessmentId: string; requirementId: string }): Promise<{ clientId: string; input: SrsSuggestionInput }> {
  const assessment = await getSrsAssessment(db, input.assessmentId);
  if (!assessment) throw new CommandValidationError([{ field: "assessmentId", code: "NOT_FOUND", message: "That assessment does not exist." }]);
  const framework = await getSrsFramework(db, assessment.frameworkId);
  const requirement = framework?.requirements.find((entry) => entry.id === input.requirementId);
  if (!framework || !requirement) throw new CommandValidationError([{ field: "requirementId", code: "UNKNOWN_REQUIREMENT", message: "That requirement is not in the framework this assessment was made against." }]);
  const maturity = assessment.items.find((item) => item.requirementId === requirement.id)?.maturity ?? null;
  if (maturity !== null && maturity >= requirement.targetMaturity) throw new CommandValidationError([{ field: "requirementId", code: "NOT_A_GAP", message: "That requirement already meets what the framework expects." }]);
  const [facts, client, library] = await Promise.all([
    resolveNziFacts(db, assessment.clientId),
    db.query<{ sector: string | null }>(`SELECT sector FROM nzi_console.clients WHERE client_id = $1`, [assessment.clientId]).then((result) => result.rows[0]),
    listLibraryStrategies(db),
  ]);
  const step = (level: number) => framework.maturityLevels.find((entry) => entry.level === level)?.label ?? `Step ${level}`;
  return {
    clientId: assessment.clientId,
    input: {
      requirement: {
        code: requirement.code, title: requirement.title, helpText: requirement.helpText,
        pillar: framework.pillars.find((pillar) => pillar.key === requirement.pillarKey)?.label ?? requirement.pillarKey,
        standard: framework.standards.find((standard) => standard.key === requirement.standardKey)?.label ?? requirement.standardKey,
      },
      stepNow: maturity === null ? null : step(maturity),
      stepTarget: step(requirement.targetMaturity),
      sector: client?.sector?.trim() || null,
      facts: {
        scopesReported: facts.scopesReported, targetsSet: facts.targetsSet, targetProgressMeasured: facts.targetProgressMeasured,
        provenanceStamped: facts.provenanceStamped, independentlyAssured: facts.independentlyAssured,
      },
      libraryTitles: library.filter((entry) => entry.active && entry.defaultSrsRequirementIds.includes(requirement.id)).map((entry) => entry.title),
    },
  };
}

export type SrsSuggestionRun = {
  suggestions: SrsSuggestionDraft[];
  /** Why ideas were dropped (a figure, a claim, a repeat of the library) — counts for the consultant, never shown to a client. */
  refused: string[];
  refusedByModel: boolean;
  model: string;
  promptSha256: string;
};

/** Ask the model for one gap's ideas and keep only the grounded ones. Pure but for the model call. */
export async function generateSrsGapSuggestions(model: SrsSuggestionModel, input: SrsSuggestionInput): Promise<SrsSuggestionRun> {
  const prompt = srsSuggestionPrompt(input);
  const promptSha256 = srsPromptSha256(prompt);
  const reply = await model.suggest(prompt);
  if (reply.kind === "refused") return { suggestions: [], refused: [], refusedByModel: true, model: model.id, promptSha256 };
  const grounded = groundSrsSuggestions(reply.body, input.libraryTitles);
  return { suggestions: grounded.kept, refused: grounded.refused, refusedByModel: false, model: model.id, promptSha256 };
}
