import { customFieldListSpec, parseListQuery } from "@nzi/contracts";
import { listCustomFieldsPage, withTenantRead, type CustomFieldPage } from "@nzi/isolated-backend";
import { serviceEnvironment } from "../../lib/environment";
import { isolatedPool } from "../../lib/isolatedDatabase";
import { adminAccess, holds } from "../adminAccess";
import { CustomFieldsBoard } from "./CustomFieldsBoard";

export const dynamic = "force-dynamic";

/**
 * Custom fields (admin Phase F3). The definitions an organisation adds to its records, on the shared DataList and drawer
 * editor, over 0151's custom_field_definitions — under admin.settings (F-Q5). The values are each record's own
 * workstream's (docs/CUSTOM_FIELD_VALUES_CONTRACT.md). The URL is the state (entity, search, status, sort, page).
 */
export default async function CustomFieldsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const access = await adminAccess();
  if (access.state !== "allowed") return null; // The layout states why; nothing is read.

  const query = parseListQuery(await searchParams, customFieldListSpec).query;
  let page: CustomFieldPage | null = null;
  try {
    page = await withTenantRead(isolatedPool(), access.organisationId, (db) => listCustomFieldsPage(db, query));
  } catch {
    page = null;
  }
  if (page === null) {
    return <section className="nz-a-state" role="alert"><h1>Custom fields could not be read</h1><p>The definitions are unavailable just now. Nothing is shown rather than a list that might be incomplete.</p></section>;
  }

  const editing = !holds(access.capabilities, "admin.settings") ? { allowed: false as const, reason: "Your role can see custom fields but not change them — that needs admin.settings." }
    : serviceEnvironment().writes !== "enabled" ? { allowed: false as const, reason: "Writes are switched off in this environment, so custom fields are read-only here." }
    : { allowed: true as const };
  return <CustomFieldsBoard page={page} query={query} editing={editing} />;
}
