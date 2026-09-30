import { deactivateFileType } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Deactivate a job file type (admin C3) — never a system type, never deleted; the reason comes in `x-command-reason` and is required. */
export async function POST(request: Request, { params }: { params: Promise<{ fileTypeId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "job_file_type.deactivate");
    const { fileTypeId } = await params;
    const body = await request.json() as Omit<CommandInputMap["job_file_type.deactivate"], "fileTypeId">;
    return commandSuccess(await deactivateFileType(isolatedPool(), { ...body, fileTypeId: decodeURIComponent(fileTypeId) }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
