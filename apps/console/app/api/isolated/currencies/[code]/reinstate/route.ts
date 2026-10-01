import { reinstateCurrency } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Reinstate a currency (admin E1) — admin.lookups. */
export async function POST(request: Request, { params }: { params: Promise<{ code: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "currency.reinstate");
    const { code } = await params;
    const body = await request.json() as Omit<CommandInputMap["currency.reinstate"], "code">;
    return commandSuccess(await reinstateCurrency(isolatedPool(), { ...body, code: decodeURIComponent(code) }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
