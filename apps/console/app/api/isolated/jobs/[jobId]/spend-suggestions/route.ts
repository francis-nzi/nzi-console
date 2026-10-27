import {
  anthropicSpendSuggestionModel, assertCapabilityOnClient, generateSpendSuggestion, recordSpendAllocationSuggestion, spendSuggestionRequest, withTenantRead,
} from "@nzi/isolated-backend";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/**
 * Data entry D2 (R5) — an AI suggestion of the category for one spend line the client's map does not know (scoperow.edit).
 *
 * As S3's: the capability **and the client** are checked before the model is called; the line is checked to be unmapped (the map
 * has the answer otherwise); the model is told only the GL code, the normalised description and the taxonomy; it is called
 * **outside** any transaction; and only a grounded answer is recorded — labelled, pending, audited by reference. Nothing is
 * applied: a person confirms it (or uses it to move the line), and that is what writes the map.
 *
 * The key is read here, at the composition edge. Without one, suggestions are simply not switched on — said as that.
 */
export async function POST(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "spend_allocation.suggestion.record");
    const { jobId } = await params;
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return Response.json({ code: "AI_OFF", message: "AI suggestions are not switched on for this console. The map and moves at review are unaffected." }, { status: 503 });
    const body = await request.json() as { glCode?: string | null; description?: string | null };
    const asked = await withTenantRead(isolatedPool(), principal.organisationId, async (db) => {
      const built = await spendSuggestionRequest(db, principal.organisationId, jobId, { glCode: body.glCode ?? null, description: body.description ?? null });
      await assertCapabilityOnClient(db, principal, "scoperow.edit", { clientId: built.clientId });
      return built;
    });
    const run = await generateSpendSuggestion(anthropicSpendSuggestionModel({ apiKey }), asked.input);
    // Nothing grounded (the model said none, declined, or answered with a figure): nothing is stored, and the person chooses.
    if (!run.suggestion) return Response.json({ data: { suggestion: null, dropped: run.dropped } }, { headers: { "Cache-Control": "no-store" } });
    const recorded = await recordSpendAllocationSuggestion(isolatedPool(), {
      jobId, keyKind: asked.key.kind, key: asked.key.display, categoryCode: run.suggestion.categoryCode, reason: run.suggestion.reason,
      model: run.model, promptSha256: run.promptSha256,
    }, commandContext(request, principal));
    // The reason goes back to the person asking, beside the suggestion; it is stored with it, never in the audit trail.
    return commandSuccess({ ...recorded, data: { ...recorded.data, reason: run.suggestion.reason } });
  } catch (error) { return commandFailure(error); }
}
