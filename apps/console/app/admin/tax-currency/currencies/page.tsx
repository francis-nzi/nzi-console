import { currencyListSpec, parseListQuery } from "@nzi/contracts";
import { listCurrenciesPage, withTenantRead, type CurrencyPage } from "@nzi/isolated-backend";
import { serviceEnvironment } from "../../../lib/environment";
import { isolatedPool } from "../../../lib/isolatedDatabase";
import { adminAccess, holds } from "../../adminAccess";
import { CurrenciesBoard } from "./CurrenciesBoard";

export const dynamic = "force-dynamic";

/**
 * Tax & currency → Currencies (admin Phase E1). The Lookups pattern over 0145's currencies — the set currencySymbol()
 * reads its symbols from. The URL is the state (search, status, sort, page).
 */
export default async function CurrenciesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const access = await adminAccess();
  if (access.state !== "allowed") return null; // The layout states why; nothing is read.

  const query = parseListQuery(await searchParams, currencyListSpec).query;
  let page: CurrencyPage | null = null;
  try {
    page = await withTenantRead(isolatedPool(), access.organisationId, (db) => listCurrenciesPage(db, query));
  } catch {
    page = null;
  }
  if (page === null) {
    return <section className="nz-a-state" role="alert"><h1>Currencies could not be read</h1><p>The currencies are unavailable just now. Nothing is shown rather than a list that might be incomplete.</p></section>;
  }

  const editing = !holds(access.capabilities, "admin.lookups") ? { allowed: false as const, reason: "Your role can see currencies but not change them — that needs admin.lookups." }
    : serviceEnvironment().writes !== "enabled" ? { allowed: false as const, reason: "Writes are switched off in this environment, so currencies are read-only here." }
    : { allowed: true as const };
  return <CurrenciesBoard page={page} query={query} editing={editing} />;
}
