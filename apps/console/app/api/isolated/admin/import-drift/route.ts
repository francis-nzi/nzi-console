import { requireCapability } from "@nzi/isolated-backend";
import { authFailure } from "../../../../lib/authResponse";
import { kickDriftRun } from "../../../../lib/driftCheck";
import { currentStaff, requireAuthOrigin } from "../../../../lib/staffSession";

export const dynamic = "force-dynamic";

/**
 * "Check now" (BRIEF-v7-import-j000663 Part C): an Admin (`import.refresh_batch`) starts one paced run over every imported job. It stores
 * checks, so the write API must be on and the request from our origin. Answers at once: 202 started, or 409 when a run is under way.
 */
export async function POST(request: Request) {
  try {
    if (process.env.NZI_WRITE_API_ENABLED !== "true") return Response.json({ code: "WRITE_API_DISABLED", message: "Write operations are not enabled." }, { status: 503 });
    requireAuthOrigin(request);
    const principal = await currentStaff(request);
    requireCapability(principal, "import.refresh_batch");
    const started = kickDriftRun(principal, request.headers.get("x-correlation-id")?.trim() || crypto.randomUUID());
    return started ? Response.json({ started: true }, { status: 202 })
      : Response.json({ code: "RUN_IN_PROGRESS", message: "A check of every imported job is already running." }, { status: 409 });
  } catch (error) { return authFailure(error); }
}
