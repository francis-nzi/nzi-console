import { listMilestoneTemplates, withTenantRead, type MilestoneTemplateCard } from "@nzi/isolated-backend";
import { serviceEnvironment } from "../../lib/environment";
import { isolatedPool } from "../../lib/isolatedDatabase";
import { adminAccess, holds } from "../adminAccess";
import { MilestoneTemplatesBoard } from "./MilestoneTemplatesBoard";

export const dynamic = "force-dynamic";

/**
 * Milestone templates (admin Phase C2; docs/design/admin-prototype.html → Milestone templates). The design's card grid
 * and the child-row drawer, over milestone_templates and their items (0139). A handful per firm, so no paging.
 */
export default async function MilestoneTemplatesPage() {
  const access = await adminAccess();
  if (access.state !== "allowed") return null; // The layout states why; nothing is read.

  let templates: MilestoneTemplateCard[] | null = null;
  try {
    templates = await withTenantRead(isolatedPool(), access.organisationId, (db) => listMilestoneTemplates(db));
  } catch {
    templates = null;
  }
  if (templates === null) {
    return <section className="nz-a-state" role="alert"><h1>Milestone templates could not be read</h1><p>The templates are unavailable just now. Nothing is shown rather than a list that might be incomplete.</p></section>;
  }

  // Writes need the capability, and a service with writes switched on; the screen says which is missing.
  const editing = !holds(access.capabilities, "admin.templates") ? { allowed: false as const, reason: "Your role can see templates but not change them — that needs admin.templates." }
    : serviceEnvironment().writes !== "enabled" ? { allowed: false as const, reason: "Writes are switched off in this environment, so templates are read-only here." }
    : { allowed: true as const };
  return <MilestoneTemplatesBoard templates={templates} editing={editing} />;
}
