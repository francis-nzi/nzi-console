import { archiveMasterTemplate, reinstateMasterTemplate, renameMasterTemplate, setMasterTemplateRows } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

// Data-entry R1 (0197) — a master template's writes, each against the header's version: `rename`, `archive` (never a
// delete; the reason comes in x-command-reason and is required), `reinstate`, and `rows` (the whole set of lines, as the
// next rows version).
export async function POST(request: Request, { params }: { params: Promise<{ masterId: string; action: string }> }) {
  try {
    const { masterId: raw, action } = await params;
    const masterId = decodeURIComponent(raw);
    if (action === "rename") {
      const principal = await requireCommandPrincipal(request, "master.template.rename");
      const body = await request.json() as Omit<CommandInputMap["master.template.rename"], "masterId">;
      return commandSuccess(await renameMasterTemplate(isolatedPool(), { ...body, masterId }, commandContext(request, principal)));
    }
    if (action === "archive") {
      const principal = await requireCommandPrincipal(request, "master.template.archive");
      const body = await request.json() as Omit<CommandInputMap["master.template.archive"], "masterId">;
      return commandSuccess(await archiveMasterTemplate(isolatedPool(), { ...body, masterId }, commandContext(request, principal)));
    }
    if (action === "reinstate") {
      const principal = await requireCommandPrincipal(request, "master.template.reinstate");
      const body = await request.json() as Omit<CommandInputMap["master.template.reinstate"], "masterId">;
      return commandSuccess(await reinstateMasterTemplate(isolatedPool(), { ...body, masterId }, commandContext(request, principal)));
    }
    if (action === "rows") {
      const principal = await requireCommandPrincipal(request, "master.template.rows.set");
      const body = await request.json() as Omit<CommandInputMap["master.template.rows.set"], "masterId">;
      return commandSuccess(await setMasterTemplateRows(isolatedPool(), { ...body, masterId }, commandContext(request, principal)));
    }
    return Response.json({ type: "about:blank", title: "Unknown master-template action", status: 404 }, { status: 404 });
  } catch (error) { return commandFailure(error); }
}
