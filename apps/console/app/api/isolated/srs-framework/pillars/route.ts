import { upsertSrsPillar } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../lib/commandResponse";
import { isolatedPool } from "../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

// Add or rename an SRS pillar in the working definition (framework rework, Phase B) — admin.lookups; every framework unlocked (0222).
export async function POST(request: Request) {
  try {
    const principal = await requireCommandPrincipal(request, "srs.framework.pillar.upsert");
    const body = await request.json() as CommandInputMap["srs.framework.pillar.upsert"];
    return commandSuccess(await upsertSrsPillar(isolatedPool(), body, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
