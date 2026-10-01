import { parseListQuery, supplierListSpec } from "@nzi/contracts";
import { listJobItemPickers, listSuppliersPage, readSupplierParts, withTenantRead, type JobItemPickers, type SupplierPage, type SupplierParts } from "@nzi/isolated-backend";
import { serviceEnvironment } from "../../lib/environment";
import { isolatedPool } from "../../lib/isolatedDatabase";
import { adminAccess, holds } from "../adminAccess";
import { SuppliersBoard } from "./SuppliersBoard";

export const dynamic = "force-dynamic";

/**
 * Suppliers (admin Phase E4). The Lookups pattern — the shared DataList and the drawer editor — over 0148's suppliers,
 * with each listed supplier's contacts and rate card read alongside (one query each, for the page). Contacts are
 * third-party personal data, sealed on write (E-Q6); agreed rates are read only with finance.manage (E-Q8), and without
 * it the drawer says so rather than showing a figure. The URL is the state (search, status, sort, page).
 */
export default async function SuppliersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const access = await adminAccess();
  if (access.state !== "allowed") return null; // The layout states why; nothing is read.

  const query = parseListQuery(await searchParams, supplierListSpec).query;
  const finance = holds(access.capabilities, "finance.manage");
  let data: { page: SupplierPage; parts: Record<string, SupplierParts>; pickers: JobItemPickers } | null = null;
  try {
    data = await withTenantRead(isolatedPool(), access.organisationId, async (db) => {
      const page = await listSuppliersPage(db, query);
      return {
        page, parts: await readSupplierParts(db, access.organisationId, page.rows.map((row) => row.supplierId), { showRates: finance }),
        pickers: await listJobItemPickers(db, access.organisationId),
      };
    });
  } catch {
    data = null;
  }
  if (data === null) {
    return <section className="nz-a-state" role="alert"><h1>Suppliers could not be read</h1><p>They are unavailable just now. Nothing is shown rather than a list that might be incomplete.</p></section>;
  }

  const writes = serviceEnvironment().writes === "enabled";
  const editing = !holds(access.capabilities, "admin.lookups") ? { allowed: false as const, reason: "Your role can see suppliers but not change them — that needs admin.lookups." }
    : !writes ? { allowed: false as const, reason: "Writes are switched off in this environment, so suppliers are read-only here." }
    : { allowed: true as const };
  const rating = !finance ? { allowed: false as const, reason: "Agreed rates need finance.manage." }
    : !writes ? { allowed: false as const, reason: "Writes are switched off in this environment." }
    : { allowed: true as const };
  return <SuppliersBoard page={data.page} parts={data.parts} pickers={data.pickers} query={query} editing={editing} rating={rating} showRates={finance} />;
}
