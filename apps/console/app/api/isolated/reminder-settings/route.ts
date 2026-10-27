import { updateReminderSettings } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../lib/commandResponse";
import { isolatedPool } from "../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Turn reminders to action owners on or off, and set the default lead (Actions A3, R6) — admin.templates, versioned, audited. */
export async function PUT(request: Request) {
  try {
    const principal = await requireCommandPrincipal(request, "admin.reminders.update");
    const body = await request.json() as CommandInputMap["admin.reminders.update"];
    return commandSuccess(await updateReminderSettings(isolatedPool(), body, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
