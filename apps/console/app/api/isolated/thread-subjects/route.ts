import { setThreadSubject } from "@nzi/isolated-backend";
import { requireCommandPrincipal } from "../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../lib/commandResponse";
import { conversationsOff, requireConversations } from "../../../lib/conversations";
import { isolatedPool } from "../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Configure the conversation subject tags (thread_subject.set, admin.lookups): add, rename, reorder or switch off. Body: { code, label, sortOrder?, active? }. */
export async function POST(request: Request) {
  try {
    requireConversations();
    const principal = await requireCommandPrincipal(request, "thread_subject.set");
    const body = await request.json().catch(() => ({})) as { code?: unknown; label?: unknown; sortOrder?: number; active?: boolean };
    return commandSuccess(await setThreadSubject(isolatedPool(), { code: String(body.code ?? ""), label: String(body.label ?? ""), ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder } : {}), ...(body.active !== undefined ? { active: body.active } : {}) }, commandContext(request, principal)));
  } catch (error) { return conversationsOff(error) ?? commandFailure(error); }
}
