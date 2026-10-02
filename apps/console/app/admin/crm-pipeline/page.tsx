import { bdStageListSpec, parseListQuery } from "@nzi/contracts";
import { listBdStagesPage, withTenantRead, type BdStagePage } from "@nzi/isolated-backend";
import { serviceEnvironment } from "../../lib/environment";
import { isolatedPool } from "../../lib/isolatedDatabase";
import { adminAccess, holds } from "../adminAccess";
import { FunnelStagesBoard } from "./FunnelStagesBoard";

export const dynamic = "force-dynamic";

/**
 * CRM & pipeline (admin Phase F2). The business-development funnel on the shared DataList and drawer editor, over 0150's
 * bd_funnel_stages; CRM tags and BD service lines are Lookups categories (F-Q4), linked rather than repeated. Automation
 * rules are the CRM workstream's (F-Q1). The URL is the state (search, status, sort, page).
 */
export default async function CrmPipelinePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const access = await adminAccess();
  if (access.state !== "allowed") return null; // The layout states why; nothing is read.

  const query = parseListQuery(await searchParams, bdStageListSpec).query;
  let page: BdStagePage | null = null;
  try {
    page = await withTenantRead(isolatedPool(), access.organisationId, (db) => listBdStagesPage(db, query));
  } catch {
    page = null;
  }
  if (page === null) {
    return <section className="nz-a-state" role="alert"><h1>The funnel could not be read</h1><p>Its stages are unavailable just now. Nothing is shown rather than a funnel that might be incomplete.</p></section>;
  }

  const editing = !holds(access.capabilities, "admin.lookups") ? { allowed: false as const, reason: "Your role can see the funnel but not change it — that needs admin.lookups." }
    : serviceEnvironment().writes !== "enabled" ? { allowed: false as const, reason: "Writes are switched off in this environment, so the funnel is read-only here." }
    : { allowed: true as const };
  return <FunnelStagesBoard page={page} query={query} editing={editing} />;
}
