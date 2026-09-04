import { resolveAssuranceGap } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const principal = await requireCommandPrincipal(request, "assurance.gap.resolve");
    const body = (await request.json()) as CommandInputMap["assurance.gap.resolve"];
    return commandSuccess(await resolveAssuranceGap(isolatedPool(), body, commandContext(request, principal)));
  } catch (error) {
    return commandFailure(error);
  }
}
