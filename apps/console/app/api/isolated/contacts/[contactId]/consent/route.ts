import { recordContactConsent } from "@nzi/isolated-backend";
import type { ContactConsentBasis, ContactConsentDecision } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/**
 * Production gate (a) — recording whether a contact may be emailed.
 *
 * POST only. There is no DELETE: a decision is superseded by recording the opposite one,
 * never removed, because an earlier grant is the evidence that an earlier send was allowed.
 *
 * The command validates `state` and `basis` rather than this route trusting the body — in
 * particular it refuses `portal-self-serve`, which is the contact's own action in phase 2 and
 * must not be claimable by staff.
 */
export async function POST(request: Request, { params }: { params: Promise<{ contactId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "client.contact.consent.record");
    const { contactId } = await params;
    const body = await request.json() as {
      expectedVersion: number; state: ContactConsentDecision; basis: ContactConsentBasis; note?: string | null;
    };
    return commandSuccess(await recordContactConsent(
      isolatedPool(),
      { contactId, expectedVersion: body.expectedVersion, state: body.state, basis: body.basis, note: body.note ?? null },
      commandContext(request, principal),
    ));
  } catch (error) { return commandFailure(error); }
}
