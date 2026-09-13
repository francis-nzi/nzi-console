import { confirmTraineeEmailChange, requestTraineeEmailChange } from "@nzi/isolated-backend";
import { traineeAuthFailure } from "../../../lib/authResponse";
import { isolatedPool } from "../../../lib/isolatedDatabase";
import { clearTraineeSessionCookie, currentTrainee, requireTraineeAuthEnabled, requireTraineeOrigin } from "../../../lib/traineeSession";

export const dynamic = "force-dynamic";

/**
 * Changing the sign-in address, in two halves.
 *
 * POST asks for the change and issues a verification token for the NEW address. The old
 * address stays the login until the new one is confirmed — so mistyping it locks nobody
 * out, and someone with a borrowed session cannot quietly take the account over.
 *
 * The token is returned to the caller in this isolated environment rather than emailed;
 * wiring it to a mail service is a delivery concern, not a change to the rule.
 */
export async function POST(request: Request) {
  try {
    const trainee = await currentTrainee(request);
    requireTraineeOrigin(request);
    const body = await request.json() as { newEmail?: unknown };
    if (typeof body.newEmail !== "string") {
      return Response.json({ code: "INVALID_EMAIL", message: "Give the new address you want to sign in with." }, { status: 400 });
    }
    const result = await requestTraineeEmailChange(isolatedPool(), {
      organisationId: trainee.organisationId, traineeId: trainee.traineeId, newEmail: body.newEmail,
    });
    return Response.json(
      { newEmail: result.newEmail, expiresAt: result.expiresAt, verificationToken: result.token },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) { return traineeAuthFailure(error); }
}

/**
 * PUT confirms it from the link. It takes no session — the person following a link from
 * their new inbox may well not be signed in, and requiring it would defeat the point.
 * Every existing session is revoked as the address switches, so the change takes effect
 * everywhere at once; this response clears the cookie to match.
 */
export async function PUT(request: Request) {
  try {
    requireTraineeAuthEnabled();
    requireTraineeOrigin(request);
    const body = await request.json() as { token?: unknown };
    if (typeof body.token !== "string") {
      return Response.json({ code: "INVALID_TOKEN", message: "This verification link is no longer valid." }, { status: 400 });
    }
    const result = await confirmTraineeEmailChange(isolatedPool(), {
      organisationId: process.env.NZI_DEMO_ORGANISATION_ID ?? "", token: body.token,
    });
    return Response.json({ email: result.email }, {
      headers: { "Set-Cookie": clearTraineeSessionCookie(), "Cache-Control": "private, no-store" },
    });
  } catch (error) { return traineeAuthFailure(error); }
}
