import { setJobTypeItems } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Set a job type's included items, whole and in order (admin E3) — admin.lookups, against the template's own version; a dropped item is kept as not included. */
export async function PUT(request: Request, { params }: { params: Promise<{ jobTypeId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "job_type.items.set");
    const { jobTypeId } = await params;
    const body = await request.json() as Omit<CommandInputMap["job_type.items.set"], "jobTypeId">;
    return commandSuccess(await setJobTypeItems(isolatedPool(), { ...body, jobTypeId: decodeURIComponent(jobTypeId) }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
