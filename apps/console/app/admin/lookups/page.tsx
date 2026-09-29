import { isLookupCategory, parseListQuery, referenceValueListSpec, type ReferenceValueListQuery } from "@nzi/contracts";
import { listLookupCategories, listReferenceValuesPage, withTenantRead, type LookupCategorySummary, type ReferenceValuePage } from "@nzi/isolated-backend";
import { serviceEnvironment } from "../../lib/environment";
import { isolatedPool } from "../../lib/isolatedDatabase";
import { adminAccess, holds } from "../adminAccess";
import { LookupsBoard } from "./LookupsBoard";

export const dynamic = "force-dynamic";

/**
 * Lookups — the reference-value engine (admin Phase A2; docs/design/admin-prototype.html). Category chips, the
 * shared DataList, and the drawer editor. The URL is the state (category, search, status, sort, page).
 */
export default async function LookupsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const access = await adminAccess();
  if (access.state !== "allowed") return null; // The layout states why; nothing is read.

  const parsed = parseListQuery(await searchParams, referenceValueListSpec).query;
  const chosen = parsed.filters.category?.[0];
  const category = isLookupCategory(chosen) ? chosen : "industries";
  const query: ReferenceValueListQuery = { ...parsed, filters: { ...parsed.filters, category: [category] } };

  let data: { categories: LookupCategorySummary[]; page: ReferenceValuePage } | null = null;
  try {
    data = await withTenantRead(isolatedPool(), access.organisationId, async (db) => ({
      categories: await listLookupCategories(db), page: await listReferenceValuesPage(db, query),
    }));
  } catch {
    data = null;
  }
  if (data === null) {
    return <section className="nz-a-state" role="alert"><h1>Lookups could not be read</h1><p>The values are unavailable just now. Nothing is shown rather than a list that might be incomplete.</p></section>;
  }

  // Writes need the capability, and a service with writes switched on; the screen says which is missing.
  const editing = !holds(access.capabilities, "admin.lookups") ? { allowed: false as const, reason: "Your role can see lookups but not change them — that needs admin.lookups." }
    : serviceEnvironment().writes !== "enabled" ? { allowed: false as const, reason: "Writes are switched off in this environment, so lookups are read-only here." }
    : { allowed: true as const };
  return <LookupsBoard categories={data.categories} page={data.page} query={query} category={category} editing={editing} />;
}
