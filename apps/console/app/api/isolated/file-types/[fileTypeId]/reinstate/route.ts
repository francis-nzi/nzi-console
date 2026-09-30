import { reinstateFileType } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Reinstate a job file type (admin C3) — back into the pickers; its name and key are still its own. */
export async function POST(request: Request, { params }: { params: Promise<{ fileTypeId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "job_file_type.reinstate");
    const { fileTypeId } = await params;
    const body = await request.json() as Omit<CommandInputMap["job_file_type.reinstate"], "fileTypeId">;
    return commandSuccess(await reinstateFileType(isolatedPool(), { ...body, fileTypeId: decodeURIComponent(fileTypeId) }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
