import { updateFileType } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../lib/commandResponse";
import { isolatedPool } from "../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Edit a job file type's name, folder and order (admin C3) — versioned, admin.lookups; never its key. */
export async function PATCH(request: Request, { params }: { params: Promise<{ fileTypeId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "job_file_type.update");
    const { fileTypeId } = await params;
    const body = await request.json() as Omit<CommandInputMap["job_file_type.update"], "fileTypeId">;
    return commandSuccess(await updateFileType(isolatedPool(), { ...body, fileTypeId: decodeURIComponent(fileTypeId) }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
