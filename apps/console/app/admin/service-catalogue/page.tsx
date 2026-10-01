import { jobItemListSpec, parseListQuery } from "@nzi/contracts";
import { listJobItemPickers, listJobItemsPage, withTenantRead, type JobItemPage, type JobItemPickers } from "@nzi/isolated-backend";
import { serviceEnvironment } from "../../lib/environment";
import { isolatedPool } from "../../lib/isolatedDatabase";
import { adminAccess, holds } from "../adminAccess";
import { ServiceCatalogueBoard } from "./ServiceCatalogueBoard";

export const dynamic = "force-dynamic";

/**
 * Service catalogue (admin Phase E2). The Lookups pattern — the shared DataList and the drawer editor — over 0146's
 * job_items. Cost and sell are read only with finance.manage (E-Q8); without it the list says so rather than showing a
 * figure. The URL is the state (search, status, category, sort, page).
 */
export default async function ServiceCataloguePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const access = await adminAccess();
  if (access.state !== "allowed") return null; // The layout states why; nothing is read.

  const query = parseListQuery(await searchParams, jobItemListSpec).query;
  const finance = holds(access.capabilities, "finance.manage");
  let data: { page: JobItemPage; pickers: JobItemPickers } | null = null;
  try {
    data = await withTenantRead(isolatedPool(), access.organisationId, async (db) => ({
      page: await listJobItemsPage(db, query, { showAmounts: finance }), pickers: await listJobItemPickers(db, access.organisationId),
    }));
  } catch {
    data = null;
  }
  if (data === null) {
    return <section className="nz-a-state" role="alert"><h1>The service catalogue could not be read</h1><p>It is unavailable just now. Nothing is shown rather than a catalogue that might be incomplete.</p></section>;
  }

  const writes = serviceEnvironment().writes === "enabled";
  const editing = !holds(access.capabilities, "admin.lookups") ? { allowed: false as const, reason: "Your role can see the catalogue but not change it — that needs admin.lookups." }
    : !writes ? { allowed: false as const, reason: "Writes are switched off in this environment, so the catalogue is read-only here." }
    : { allowed: true as const };
  const pricing = !finance ? { allowed: false as const, reason: "Cost and sell need finance.manage." }
    : !writes ? { allowed: false as const, reason: "Writes are switched off in this environment." }
    : { allowed: true as const };
  return <ServiceCatalogueBoard page={data.page} pickers={data.pickers} query={query} editing={editing} pricing={pricing} showAmounts={finance} />;
}
