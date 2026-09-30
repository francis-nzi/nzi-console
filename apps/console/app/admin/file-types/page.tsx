import { fileTypeListSpec, parseListQuery } from "@nzi/contracts";
import { listFileTypesPage, withTenantRead, type FileTypePage } from "@nzi/isolated-backend";
import { serviceEnvironment } from "../../lib/environment";
import { isolatedPool } from "../../lib/isolatedDatabase";
import { adminAccess, holds } from "../adminAccess";
import { FileTypesBoard } from "./FileTypesBoard";

export const dynamic = "force-dynamic";

/**
 * File types (admin Phase C3; docs/design/admin-prototype.html → File types). The Lookups pattern — the shared DataList
 * and the drawer editor — over job_file_types (0139). The URL is the state (search, status, sort, page).
 */
export default async function FileTypesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const access = await adminAccess();
  if (access.state !== "allowed") return null; // The layout states why; nothing is read.

  const query = parseListQuery(await searchParams, fileTypeListSpec).query;
  let page: FileTypePage | null = null;
  try {
    page = await withTenantRead(isolatedPool(), access.organisationId, (db) => listFileTypesPage(db, query));
  } catch {
    page = null;
  }
  if (page === null) {
    return <section className="nz-a-state" role="alert"><h1>File types could not be read</h1><p>The file types are unavailable just now. Nothing is shown rather than a list that might be incomplete.</p></section>;
  }

  // Writes need the capability, and a service with writes switched on; the screen says which is missing.
  const editing = !holds(access.capabilities, "admin.lookups") ? { allowed: false as const, reason: "Your role can see file types but not change them — that needs admin.lookups." }
    : serviceEnvironment().writes !== "enabled" ? { allowed: false as const, reason: "Writes are switched off in this environment, so file types are read-only here." }
    : { allowed: true as const };
  return <FileTypesBoard page={page} query={query} editing={editing} />;
}
