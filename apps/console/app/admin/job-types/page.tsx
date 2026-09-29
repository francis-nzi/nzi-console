import { jobTypeListSpec, parseListQuery } from "@nzi/contracts";
import { listJobTypePickers, listJobTypesPage, withTenantRead, type JobTypePage, type JobTypePickers } from "@nzi/isolated-backend";
import { serviceEnvironment } from "../../lib/environment";
import { isolatedPool } from "../../lib/isolatedDatabase";
import { adminAccess, holds } from "../adminAccess";
import { JobTypesBoard } from "./JobTypesBoard";

export const dynamic = "force-dynamic";

/**
 * Job types (admin Phase C1; docs/design/admin-prototype.html → Job types). The shared DataList and the drawer editor,
 * over the typed job_types table (0139). The URL is the state (search, family, status, sort, page).
 */
export default async function JobTypesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const access = await adminAccess();
  if (access.state !== "allowed") return null; // The layout states why; nothing is read.

  const query = parseListQuery(await searchParams, jobTypeListSpec).query;
  let data: { page: JobTypePage; pickers: JobTypePickers } | null = null;
  try {
    data = await withTenantRead(isolatedPool(), access.organisationId, async (db) => ({
      page: await listJobTypesPage(db, query), pickers: await listJobTypePickers(db),
    }));
  } catch {
    data = null;
  }
  if (data === null) {
    return <section className="nz-a-state" role="alert"><h1>Job types could not be read</h1><p>The job types are unavailable just now. Nothing is shown rather than a list that might be incomplete.</p></section>;
  }

  // Writes need the capability, and a service with writes switched on; the screen says which is missing.
  const editing = !holds(access.capabilities, "admin.lookups") ? { allowed: false as const, reason: "Your role can see job types but not change them — that needs admin.lookups." }
    : serviceEnvironment().writes !== "enabled" ? { allowed: false as const, reason: "Writes are switched off in this environment, so job types are read-only here." }
    : { allowed: true as const };
  return <JobTypesBoard page={data.page} pickers={data.pickers} query={query} editing={editing} />;
}
