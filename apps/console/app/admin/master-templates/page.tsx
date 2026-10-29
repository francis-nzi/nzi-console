import type { MasterTemplatesReadModel } from "@nzi/contracts";
import { getMasterTemplatesScreen, withTenantRead } from "@nzi/isolated-backend";
import { serviceEnvironment } from "../../lib/environment";
import { isolatedPool } from "../../lib/isolatedDatabase";
import { adminAccess, holds } from "../adminAccess";
import { MasterTemplatesBoard } from "./MasterTemplatesBoard";

export const dynamic = "force-dynamic";

/**
 * Master templates (data-entry R1, 0197; ruled 29 Oct 2026). The organisation's starting templates — Master · Default,
 * Construction and Office — as cards, and the drawer that authors each one's lines with the capture accordion's activity
 * search. A handful per firm, so no paging.
 */
export default async function MasterTemplatesPage() {
  const access = await adminAccess();
  if (access.state !== "allowed") return null; // The layout states why; nothing is read.

  let screen: MasterTemplatesReadModel | null = null;
  try {
    screen = await withTenantRead(isolatedPool(), access.organisationId, (db) => getMasterTemplatesScreen(db));
  } catch {
    screen = null;
  }
  if (screen === null) {
    return <section className="nz-a-state" role="alert"><h1>Master templates could not be read</h1><p>The templates are unavailable just now. Nothing is shown rather than a list that might be incomplete.</p></section>;
  }

  // Writes need the capability, and a service with writes switched on; the screen says which is missing.
  const editing = !holds(access.capabilities, "admin.lookups") ? { allowed: false as const, reason: "Your role can see master templates but not change them — that needs admin.lookups." }
    : serviceEnvironment().writes !== "enabled" ? { allowed: false as const, reason: "Writes are switched off in this environment, so master templates are read-only here." }
    : { allowed: true as const };
  return <MasterTemplatesBoard screen={screen} editing={editing} />;
}
