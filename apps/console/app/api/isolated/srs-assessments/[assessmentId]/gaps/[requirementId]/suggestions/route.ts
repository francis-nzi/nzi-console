import {
  anthropicSrsSuggestionModel, assertCapabilityOnClient, generateSrsGapSuggestions, recordSrsGapSuggestions, srsSuggestionInputFor,
  withdrawSrsGapSuggestion, withTenantRead,
} from "@nzi/isolated-backend";
import { requireCommandPrincipal } from "../../../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/**
 * SRS S3 — AI ideas for one gap (srs.manage).
 *
 * POST asks the model, then stores what passes grounding as shown (the client sees it in their portal, labelled as AI).
 * The order is the point: the capability **and the client** are checked before the model is called, so no one spends a
 * call — or sends a client's sector — on a client they cannot assess; the model is called **outside** any transaction;
 * and only then does the record command run, which checks everything again and audits the request by reference.
 *
 * The API key is read here, at the composition edge. Without one, AI ideas are simply not switched on — said as that,
 * not as an error, and the library candidates are unaffected.
 *
 * PUT withdraws one idea from what the client is shown.
 */
export async function POST(request: Request, { params }: { params: Promise<{ assessmentId: string; requirementId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "srs.gap.suggestions.record");
    const { assessmentId, requirementId } = await params;
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return Response.json({ code: "AI_OFF", message: "AI ideas are not switched on for this console. The library's actions are unaffected." }, { status: 503 });

    const { input } = await withTenantRead(isolatedPool(), principal.organisationId, async (db) => {
      const built = await srsSuggestionInputFor(db, { assessmentId, requirementId });
      await assertCapabilityOnClient(db, principal, "srs.manage", { clientId: built.clientId });
      return built;
    });
    const run = await generateSrsGapSuggestions(anthropicSrsSuggestionModel({ apiKey }), input);
    const recorded = await recordSrsGapSuggestions(isolatedPool(),
      { assessmentId, requirementId, suggestions: run.suggestions, model: run.model, promptSha256: run.promptSha256 }, commandContext(request, principal));
    // The refusals are counted for the consultant ("two ideas were dropped for quoting a figure") — never shown to a client.
    return commandSuccess({ ...recorded, data: { ...recorded.data, dropped: run.refused, declinedByModel: run.refusedByModel } });
  } catch (error) { return commandFailure(error); }
}

export async function PUT(request: Request, { params }: { params: Promise<{ assessmentId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "srs.gap.suggestion.withdraw");
    const { assessmentId } = await params;
    const body = await request.json() as { suggestionId: string };
    return commandSuccess(await withdrawSrsGapSuggestion(isolatedPool(), { assessmentId, suggestionId: body.suggestionId }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
