import { parseListQuery, portalBroadcastListSpec } from "@nzi/contracts";
import { listBroadcastTargets, listPortalBroadcastsPage, withTenantRead, type PortalBroadcastPage } from "@nzi/isolated-backend";
import { serviceEnvironment } from "../../lib/environment";
import { isolatedPool } from "../../lib/isolatedDatabase";
import { adminAccess, holds } from "../adminAccess";
import { PortalBroadcastsBoard } from "./PortalBroadcastsBoard";

export const dynamic = "force-dynamic";

/**
 * Portal broadcasts (admin Phase F4; ruled F4-RULINGS R1–R7). The notices staff write for the client portal, on the
 * shared DataList and drawer editor, over 0152's portal_broadcasts — under admin.settings. Each row says where it stands
 * in its window (live, scheduled, ended, or down). The URL is the state (phase, style, search, sort, page).
 */
export default async function PortalBroadcastsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const access = await adminAccess();
  if (access.state !== "allowed") return null; // The layout states why; nothing is read.

  const query = parseListQuery(await searchParams, portalBroadcastListSpec).query;
  let data: { page: PortalBroadcastPage; targets: Array<{ clientId: string; name: string }> } | null = null;
  try {
    data = await withTenantRead(isolatedPool(), access.organisationId, async (db) => ({ page: await listPortalBroadcastsPage(db, query), targets: await listBroadcastTargets(db) }));
  } catch {
    data = null;
  }
  if (data === null) {
    return <section className="nz-a-state" role="alert"><h1>Portal broadcasts could not be read</h1><p>They are unavailable just now. Nothing is shown rather than a list that might be incomplete.</p></section>;
  }

  const editing = !holds(access.capabilities, "admin.settings") ? { allowed: false as const, reason: "Your role can see portal broadcasts but not write them — that needs admin.settings." }
    : serviceEnvironment().writes !== "enabled" ? { allowed: false as const, reason: "Writes are switched off in this environment, so broadcasts are read-only here." }
    : { allowed: true as const };
  return <PortalBroadcastsBoard page={data.page} targets={data.targets} query={query} editing={editing} />;
}
