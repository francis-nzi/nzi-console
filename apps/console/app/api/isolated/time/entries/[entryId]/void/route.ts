import { voidTimeEntry } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Void one's own entry until it is billed (time.entry.void) — voided, never deleted. */
export async function POST(request: Request, { params }: { params: Promise<{ entryId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "time.entry.void");
    const { entryId } = await params;
    const body = await request.json() as Omit<CommandInputMap["time.entry.void"], "entryId">;
    return commandSuccess(await voidTimeEntry(isolatedPool(), { ...body, entryId: decodeURIComponent(entryId) }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
