import type { SpendAllocationRow } from "@nzi/contracts";
import { listClientSpendAllocations, listSpendAllocationClients, listSpendFactors, withTenantRead } from "@nzi/isolated-backend";
import { CapabilityChip } from "@nzi/ui";
import { serviceEnvironment } from "../../lib/environment";
import { isolatedPool } from "../../lib/isolatedDatabase";
import { adminAccess, holds } from "../adminAccess";
import { SpendAllocationBoard } from "./SpendAllocationBoard";

export const dynamic = "force-dynamic";

/**
 * Spend allocation (Data entry D2, R1): a client's map from GL code — or, for a client without them, description — to the category
 * a spend line belongs in. Held per client; it also learns, as reviewers move lines. PG&S is where an unmapped line lands.
 */
export default async function SpendAllocationPage({ searchParams }: { searchParams: Promise<{ client?: string }> }) {
  const access = await adminAccess();
  if (access.state !== "allowed") return null; // The layout states why; nothing is read.

  const { client } = await searchParams;
  let data: { clients: Array<{ clientId: string; name: string; entries: number }>; rows: SpendAllocationRow[]; factors: Awaited<ReturnType<typeof listSpendFactors>> } | null = null;
  try {
    data = await withTenantRead(isolatedPool(), access.organisationId, async (db) => {
      const clients = await listSpendAllocationClients(db, access.organisationId);
      const chosen = clients.some((entry) => entry.clientId === client) ? client! : null;
      return { clients, rows: chosen ? await listClientSpendAllocations(db, access.organisationId, chosen) : [], factors: await listSpendFactors(db, access.organisationId) };
    });
  } catch {
    data = null;
  }
  if (data === null) {
    return <section className="nz-a-state" role="alert"><h1>The allocation map could not be read</h1><p>It is unavailable just now. Nothing is shown rather than a map that might not be the one routing lines.</p></section>;
  }
  const chosen = data.clients.find((entry) => entry.clientId === client) ?? null;
  const editing = !holds(access.capabilities, "admin.lookups") ? { allowed: false as const, reason: "Your role can see the map but not change it — that needs admin.lookups." }
    : serviceEnvironment().writes !== "enabled" ? { allowed: false as const, reason: "Writes are switched off in this environment, so the map is read-only here." }
    : { allowed: true as const };
  return <>
    <div className="nz-a-page-head">
      <div>
        <div className="nz-a-eyebrow">Carbon data</div>
        <h1>Spend allocation</h1>
        <p>Where a client&rsquo;s spend lines belong. Each entry routes a <b>GL code</b> — or, for a client without GL codes, a <b>description</b> — to its proper scope and category, so fuel lands in Company Vehicles and pensions in Investments rather than everything in PG&amp;S. A line the map doesn&rsquo;t know lands in <b>PG&amp;S</b>. When a reviewer moves a line, the map learns it.</p>
      </div>
      <div className="nz-a-head-actions"><CapabilityChip capability="admin.lookups" /></div>
    </div>
    <SpendAllocationBoard clients={data.clients} client={chosen} rows={data.rows} factors={data.factors} editing={editing} />
  </>;
}
