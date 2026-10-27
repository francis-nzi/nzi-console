import type { EntryBasisDefaultRow } from "@nzi/contracts";
import { listEntryBasisDefaults, withTenantRead } from "@nzi/isolated-backend";
import { CapabilityChip } from "@nzi/ui";
import { serviceEnvironment } from "../../lib/environment";
import { isolatedPool } from "../../lib/isolatedDatabase";
import { adminAccess, holds } from "../adminAccess";
import { EntryBasisBoard } from "./EntryBasisBoard";

export const dynamic = "force-dynamic";

/**
 * Data entry (D1, R4): the basis each category's add-entry drawer opens on — Activity or Spend. The seed is PG&S = Spend and every
 * other category Activity; a setting here overrides it for this organisation, and a client's own last choice overrides both.
 */
export default async function DataEntryAdminPage() {
  const access = await adminAccess();
  if (access.state !== "allowed") return null; // The layout states why; nothing is read.

  let rows: EntryBasisDefaultRow[] | null = null;
  try {
    rows = await withTenantRead(isolatedPool(), access.organisationId, (db) => listEntryBasisDefaults(db, access.organisationId));
  } catch {
    rows = null;
  }
  if (rows === null) {
    return <section className="nz-a-state" role="alert"><h1>Data-entry settings could not be read</h1><p>They are unavailable just now. Nothing is shown rather than a default that might not be the one in force.</p></section>;
  }

  const editing = !holds(access.capabilities, "admin.settings") ? { allowed: false as const, reason: "Your role can see these settings but not change them — that needs admin.settings." }
    : serviceEnvironment().writes !== "enabled" ? { allowed: false as const, reason: "Writes are switched off in this environment, so these settings are read-only here." }
    : { allowed: true as const };
  return <>
    <div className="nz-a-page-head">
      <div>
        <div className="nz-a-eyebrow">Carbon data</div>
        <h1>Data entry</h1>
        <p>Every add-entry drawer starts with one question: is this measured as <b>activity</b> (physical units against an activity factor) or as <b>spend</b> (money against a spend factor)? This sets which a category&rsquo;s drawer opens on. A client&rsquo;s own last choice for a category overrides it for them, and Spend is only offered where a spend factor is available.</p>
      </div>
      <div className="nz-a-head-actions"><CapabilityChip capability="admin.settings" /></div>
    </div>
    <EntryBasisBoard rows={rows} editing={editing} />
  </>;
}
