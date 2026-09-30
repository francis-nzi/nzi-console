import { createFileType } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../lib/commandResponse";
import { isolatedPool } from "../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Add a job file type (admin C3) — admin.lookups; its key is set here and never again. */
export async function POST(request: Request) {
  try {
    const principal = await requireCommandPrincipal(request, "job_file_type.create");
    const body = await request.json() as CommandInputMap["job_file_type.create"];
    return commandSuccess(await createFileType(isolatedPool(), body, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
