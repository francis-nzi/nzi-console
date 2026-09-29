import { createJobType } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../lib/commandResponse";
import { isolatedPool } from "../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Add a job type (admin C1) — admin.lookups, through the command runner. */
export async function POST(request: Request) {
  try {
    const principal = await requireCommandPrincipal(request, "job_type.create");
    const body = await request.json() as CommandInputMap["job_type.create"];
    return commandSuccess(await createJobType(isolatedPool(), body, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
