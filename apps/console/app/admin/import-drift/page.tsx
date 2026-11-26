import { listV7Drift, withTenantRead, type V7DriftListItem } from "@nzi/isolated-backend";
import { CapabilityChip } from "@nzi/ui";
import { serviceEnvironment } from "../../lib/environment";
import { isolatedPool } from "../../lib/isolatedDatabase";
import { adminAccess, holds } from "../adminAccess";
import { CheckNowButton } from "./CheckNowButton";
import { parseDriftQuery } from "./driftModel";
import { DriftBoard } from "./driftView";

export const dynamic = "force-dynamic";

/**
 * Imported jobs against the previous system (BRIEF-v7-import-j000663 Part C): read-only, from the stored checks — no call to the previous
 * system on opening it. "Check now" (an Admin, `import.refresh_batch`) starts a paced run that stores a fresh check for every job.
 */
export default async function ImportDriftPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const access = await adminAccess();
  if (access.state !== "allowed") return null; // The layout states why; nothing is read.
  if (!holds(access.capabilities, "import.refresh_batch")) {
    return <section className="nz-a-state" role="alert"><h1>Imported jobs against the previous system</h1><p>This list is for Admins: it needs import.refresh_batch.</p></section>;
  }
  let items: V7DriftListItem[] | null = null;
  try { items = await withTenantRead(isolatedPool(), access.organisationId, (db) => listV7Drift(db, access.organisationId)); } catch { items = null; }
  if (items === null) {
    return <section className="nz-a-state" role="alert"><h1>The list could not be read</h1><p>It is unavailable just now. Nothing is shown rather than a list that might be wrong.</p></section>;
  }
  const writes = serviceEnvironment().writes === "enabled";
  return <>
    <div className="nz-a-page-head">
      <div>
        <div className="nz-a-eyebrow">Carbon data</div>
        <h1>Imported jobs against the previous system</h1>
        <p>Every job imported from the previous system, with its scope totals here and in the previous system at its latest check, largest difference first. Sort by any column, filter by any words or the quick filters, and export what you see; a view&rsquo;s filters are in its address, so it can be shared. More than <b>0.1 t</b> apart in any scope and the job is <b>behind the previous system</b>: it can&rsquo;t be published until its rows are brought in. A job spanning two dataset years can&rsquo;t be published until a check says it is level.</p>
      </div>
      <div className="nz-a-head-actions"><CapabilityChip capability="import.refresh_batch" /></div>
    </div>
    <CheckNowButton enabled={writes} reason={writes ? null : "Writes are switched off in this environment, so checks can't be stored here."} />
    <DriftBoard items={items} initialQuery={parseDriftQuery(new URLSearchParams(Object.entries(await searchParams).flatMap(([key, value]) => typeof value === "string" ? [[key, value]] : Array.isArray(value) && value[0] !== undefined ? [[key, value[0]]] : [])))} />
  </>;
}
