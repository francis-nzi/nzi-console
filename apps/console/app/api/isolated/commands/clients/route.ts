import { createClient } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../lib/commandResponse";
import { isolatedPool } from "../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const principal = await requireCommandPrincipal(request, "client.create");
    const input = await request.json() as CommandInputMap["client.create"];
    return commandSuccess(await createClient(isolatedPool(), input, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
