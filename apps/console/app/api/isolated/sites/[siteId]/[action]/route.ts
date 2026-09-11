import { editSite, recordSiteFloorArea, reinstateSite, setRegisteredOffice, vacateSite } from "@nzi/isolated-backend";
import type { CommandContext, CommandInputMap, CommandKey } from "@nzi/contracts";
import type { PoolLike } from "@nzi/isolated-backend";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

// NZC-070 / NZC-071 — site lifecycle commands, one per action. Each is permission-
// checked (site.manage), atomic, idempotent and audited by the command runner.
type SiteCommand<K extends CommandKey> = { key: K; run: (pool: PoolLike, input: CommandInputMap[K], context: CommandContext) => Promise<unknown> };
const actions = {
  edit: { key: "site.edit", run: editSite } as SiteCommand<"site.edit">,
  "registered-office": { key: "site.registeredOffice", run: setRegisteredOffice } as SiteCommand<"site.registeredOffice">,
  vacate: { key: "site.vacate", run: vacateSite } as SiteCommand<"site.vacate">,
  reinstate: { key: "site.reinstate", run: reinstateSite } as SiteCommand<"site.reinstate">,
  "floor-area": { key: "site.floorArea.record", run: recordSiteFloorArea } as SiteCommand<"site.floorArea.record">,
};

export async function POST(request: Request, { params }: { params: Promise<{ siteId: string; action: string }> }) {
  const { siteId, action } = await params;
  const command = actions[action as keyof typeof actions] as SiteCommand<CommandKey> | undefined;
  if (!command) return Response.json({ type: "about:blank", title: "Unknown site action", status: 404 }, { status: 404 });
  try {
    const principal = await requireCommandPrincipal(request, command.key);
    const body = await request.json() as Record<string, unknown>;
    const outcome = await command.run(isolatedPool(), { ...body, siteId } as never, commandContext(request, principal));
    return commandSuccess(outcome as Parameters<typeof commandSuccess>[0]);
  } catch (error) {
    return commandFailure(error);
  }
}
