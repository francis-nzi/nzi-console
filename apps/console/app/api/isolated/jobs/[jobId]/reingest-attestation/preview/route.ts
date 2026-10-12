import { previewReingestAttestation } from "@nzi/isolated-backend";
import { requireCommandPrincipal } from "../../../../../../lib/commandAuth";
import { commandContext, commandFailure } from "../../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

// The preview: the attestation's own plan, read-only — the rows it would approve (with the versions the confirm sends back),
// the record-of-account gaps it would resolve, and what it leaves alone. Held to the same permission as the act.
export async function POST(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "scope.review.attest_reingest");
    const { jobId } = await params;
    return Response.json(await previewReingestAttestation(isolatedPool(), jobId, commandContext(request, principal)), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return commandFailure(error); }
}
