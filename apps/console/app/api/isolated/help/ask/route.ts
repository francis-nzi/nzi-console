import { anthropicAnswerModel, answerQuestion, withTenantRead } from "@nzi/isolated-backend";
import { apiFailure, requireIsolatedApiContext } from "../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/**
 * Ask — a cited answer, or an honest reason there isn't one.
 *
 * **POST, but nothing is written.** The verb carries the question in a body rather than a URL
 * that would land in logs and browser history; it is not a command, there is no
 * `expectedVersion`, and no row changes. The assistant's entire write surface is a
 * knowledge-library draft, which goes through 0a's approval-gated command and not through here.
 *
 * The API key is read **here**, at the composition edge, and nowhere deeper. Its absence is a
 * supported state, not a failure: retrieval still runs and the sources still come back, with an
 * explicit "answering is not switched on" — which is the truth, and is different from saying the
 * library had nothing.
 */
export async function POST(request: Request) {
  try {
    const { pool, organisationId } = requireIsolatedApiContext();
    const body = (await request.json().catch(() => ({}))) as { question?: unknown; pageContext?: unknown };
    const question = typeof body.question === "string" ? body.question : "";
    const pageContext = typeof body.pageContext === "string" ? body.pageContext : undefined;

    const apiKey = process.env.ANTHROPIC_API_KEY;
    const model = apiKey ? anthropicAnswerModel({ apiKey }) : undefined;

    const result = await withTenantRead(pool, organisationId, (db) =>
      answerQuestion(question, { db }, { model, pageContext }));

    return Response.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return apiFailure(error); }
}
