import type { AnswerModel, ModelDraft } from "@nzi/contracts";

/**
 * The model adapter — the only place that talks to an external API.
 *
 * Kept deliberately thin. Everything that decides whether an answer is allowed to exist lives in
 * `answering.ts` and the contract; this file speaks HTTP and parses a reply, and holds no rule of
 * its own. That is what makes the rules testable without a key: the fake and the real adapter
 * both satisfy `AnswerModel`, and nothing above them can tell the difference.
 *
 * **The API key is passed in, never read from `process.env` here** — the same discipline as
 * `spendImportIdentity`. Reading it at the composition edge keeps the one place a secret enters
 * the process greppable, and keeps this module usable from a test that has no secret at all.
 *
 * ## Watch-point: the HTTP call itself is the one path no test exercises
 *
 * By design — there is no key in CI and there should not be, so nothing here proves the request
 * shape, the headers or the response envelope against the real API. `parseModelDraft` is covered
 * thoroughly and the rules above it are covered without a network, but the `fetch` in `draft()`
 * has only ever run against a fake.
 *
 * **The first use of a real key on staging is therefore a supervised check, not a silent
 * enablement.** Set the key, ask one question whose answer is known to be in the library, and
 * confirm a cited answer comes back; then ask one that is not, and confirm the abstention. If the
 * request shape is wrong the failure is safe — a non-2xx throws, `answerQuestion` reports it as a
 * fault and still shows the retrieved sources — but "safe" is not "noticed", and an adapter that
 * silently always fails would look identical to a library that never matches.
 */

/** Sonnet is the default: a grounded lookup over a handful of short entries is not Opus work. */
export const DEFAULT_ANSWER_MODEL = "claude-sonnet-5";

export type AnthropicModelConfig = {
  apiKey: string;
  /** Override for a deliberate change; the default is the one that gets used. */
  model?: string;
  /** Injectable for tests. Defaults to the platform `fetch`. */
  fetchImpl?: typeof fetch;
};

/**
 * Said when the reply came back in a shape that could not be checked.
 *
 * A separate fact from "the sources do not answer this" and from "I could not reach the
 * assistant", and worded so a reader can tell which happened.
 */
export const UNREADABLE_REPLY_REASON =
  "The assistant's reply did not come back in a form I could check against its sources, so I have not shown it.";

/**
 * Pull the model's JSON out of a reply.
 *
 * Tolerant of the usual wrapper — a fenced block, a stray sentence either side — because being
 * strict here would turn a cosmetic deviation into a refusal. It is **not** tolerant about
 * shape: anything that does not resolve to one of the two agreed forms is an unreadable reply,
 * not a best guess at what was meant.
 */
export function parseModelDraft(text: string): ModelDraft {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return { kind: "abstain", reason: UNREADABLE_REPLY_REASON };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return { kind: "abstain", reason: UNREADABLE_REPLY_REASON };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { kind: "abstain", reason: UNREADABLE_REPLY_REASON };
  }

  const body = parsed as Record<string, unknown>;
  if (body.abstain === true) {
    return { kind: "abstain", reason: typeof body.reason === "string" ? body.reason : undefined };
  }

  // `cites` is carried through **unvalidated** on purpose. Checking it against the candidates is
  // `groundAnswer`'s job, and doing it here too would put the rule in two places that can drift.
  if (typeof body.answer === "string" && Array.isArray(body.cites)) {
    return { kind: "draft", answer: body.answer, cites: body.cites.filter((v): v is number => typeof v === "number") };
  }
  return { kind: "abstain", reason: UNREADABLE_REPLY_REASON };
}

/** Anthropic's Messages API, behind the `AnswerModel` interface. */
export function anthropicAnswerModel(config: AnthropicModelConfig): AnswerModel {
  const model = config.model ?? DEFAULT_ANSWER_MODEL;
  const call = config.fetchImpl ?? fetch;

  return {
    id: model,
    async draft(prompt: string): Promise<ModelDraft> {
      const response = await call("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": config.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: 700,
          // Grounded lookup, not composition. Low temperature keeps the answer close to the
          // source text, which is the only text it is allowed to be close to.
          temperature: 0,
          messages: [{ role: "user", content: prompt }],
        }),
      });

      // Thrown, not abstained: an HTTP failure is a fault to be reported as one, and
      // `answerQuestion` turns it into an honest "could not reach" while keeping the sources.
      if (!response.ok) throw new Error(`answer model responded ${response.status}`);

      const body = (await response.json()) as { content?: Array<{ type?: string; text?: string }> };
      const text = (body.content ?? []).filter((part) => part.type === "text").map((part) => part.text ?? "").join("");
      return parseModelDraft(text);
    },
  };
}
