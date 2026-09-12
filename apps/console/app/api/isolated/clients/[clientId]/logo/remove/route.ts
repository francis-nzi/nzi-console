import { removeClientLogo } from "@nzi/isolated-backend";
import { requireCommandPrincipal } from "../../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ clientId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "client.logo.remove");
    const { clientId } = await params;
    return commandSuccess(await removeClientLogo(isolatedPool(), { clientId }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
