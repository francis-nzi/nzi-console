import { billTimeEntry } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Finance stamps the invoice an entry was billed on, or clears it to unbill (time.entry.bill, finance.manage). */
export async function POST(request: Request, { params }: { params: Promise<{ entryId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "time.entry.bill");
    const { entryId } = await params;
    const body = await request.json() as Omit<CommandInputMap["time.entry.bill"], "entryId">;
    return commandSuccess(await billTimeEntry(isolatedPool(), { ...body, entryId: decodeURIComponent(entryId) }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
