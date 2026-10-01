import { parseListQuery, vatRateListSpec } from "@nzi/contracts";
import { listVatRatesPage, withTenantRead, type VatRatePage } from "@nzi/isolated-backend";
import { serviceEnvironment } from "../../../lib/environment";
import { isolatedPool } from "../../../lib/isolatedDatabase";
import { adminAccess, holds } from "../../adminAccess";
import { VatRatesBoard } from "./VatRatesBoard";

export const dynamic = "force-dynamic";

/**
 * Tax & currency → VAT rates (admin Phase E1). The Lookups pattern — the shared DataList and the drawer editor — over
 * 0139's vat_rates, read-only until now. The URL is the state (search, status, sort, page).
 */
export default async function VatRatesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const access = await adminAccess();
  if (access.state !== "allowed") return null; // The layout states why; nothing is read.

  const query = parseListQuery(await searchParams, vatRateListSpec).query;
  let page: VatRatePage | null = null;
  try {
    page = await withTenantRead(isolatedPool(), access.organisationId, (db) => listVatRatesPage(db, query));
  } catch {
    page = null;
  }
  if (page === null) {
    return <section className="nz-a-state" role="alert"><h1>VAT rates could not be read</h1><p>The VAT rates are unavailable just now. Nothing is shown rather than a list that might be incomplete.</p></section>;
  }

  const editing = !holds(access.capabilities, "admin.lookups") ? { allowed: false as const, reason: "Your role can see VAT rates but not change them — that needs admin.lookups." }
    : serviceEnvironment().writes !== "enabled" ? { allowed: false as const, reason: "Writes are switched off in this environment, so VAT rates are read-only here." }
    : { allowed: true as const };
  return <VatRatesBoard page={page} query={query} editing={editing} />;
}
