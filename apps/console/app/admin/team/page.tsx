import { parseListQuery, staffListSpec } from "@nzi/contracts";
import { listStaffPage, listStaffPickers, withTenantRead, type StaffPage, type StaffPickers } from "@nzi/isolated-backend";
import { serviceEnvironment } from "../../lib/environment";
import { isolatedPool } from "../../lib/isolatedDatabase";
import { adminAccess, holds } from "../adminAccess";
import { TeamBoard } from "./TeamBoard";

export const dynamic = "force-dynamic";

/**
 * Team & access (admin Phase B, B1; ruled `phaseB-team-access-plan.md`). The roster — `memberships` — on the shared
 * DataList, with the drawer that edits a person, changes their role and deactivates or reinstates them. admin.users
 * opens it; anyone else in the admin section is told why, and nothing is read. Work email addresses are shown here only.
 */
export default async function TeamPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const access = await adminAccess();
  if (access.state !== "allowed") return null; // The layout states why; nothing is read.
  if (!holds(access.capabilities, "admin.users")) {
    return <section className="nz-a-state" role="alert"><h1>Team & access needs admin.users</h1><p>Your role can open administration, but the roster — names, work addresses and roles — is shown only to those who can govern it. Nothing has been read.</p></section>;
  }

  const query = parseListQuery(await searchParams, staffListSpec).query;
  let data: { page: StaffPage; pickers: StaffPickers; activeAdmins: number } | null = null;
  try {
    data = await withTenantRead(isolatedPool(), access.organisationId, async (db) => ({
      page: await listStaffPage(db, query), pickers: await listStaffPickers(db),
      activeAdmins: (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM nzi_console.memberships WHERE role_id = 'admin' AND status = 'active'`)).rows[0]?.n ?? 0,
    }));
  } catch {
    data = null;
  }
  if (data === null) {
    return <section className="nz-a-state" role="alert"><h1>The roster could not be read</h1><p>The team is unavailable just now. Nothing is shown rather than a list that might be incomplete — this is not the same as having no staff.</p></section>;
  }

  const editing = serviceEnvironment().writes !== "enabled" ? { allowed: false as const, reason: "Writes are switched off in this environment, so the roster is read-only here." } : { allowed: true as const };
  return <TeamBoard page={data.page} pickers={data.pickers} query={query} editing={editing} self={access.userId} activeAdmins={data.activeAdmins}
    rates={holds(access.capabilities, "finance.manage")} />;
}
