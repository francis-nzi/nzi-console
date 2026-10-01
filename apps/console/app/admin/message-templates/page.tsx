import { listMessageTemplates, readOrganisationProfile, withTenantRead, type MessageTemplateRow } from "@nzi/isolated-backend";
import { serviceEnvironment } from "../../lib/environment";
import { isolatedPool } from "../../lib/isolatedDatabase";
import { adminAccess, holds } from "../adminAccess";
import { MessageTemplatesBoard, type SenderReference } from "./MessageTemplatesBoard";

export const dynamic = "force-dynamic";

/**
 * Message templates (admin Phase F1). The messages the console sends — a fixed set, governed in code (F-Q3) — each with
 * the organisation's own wording beside the built-in, edited over its declared tokens and previewed against sample values
 * only (F-Q2). The sender and footer are the organisation profile's, shown for reference (F-Q7). Three messages, so no
 * paging.
 */
export default async function MessageTemplatesPage() {
  const access = await adminAccess();
  if (access.state !== "allowed") return null; // The layout states why; nothing is read.

  let data: { templates: MessageTemplateRow[]; sender: SenderReference } | null = null;
  try {
    data = await withTenantRead(isolatedPool(), access.organisationId, async (db) => {
      const profile = await readOrganisationProfile(db, access.organisationId);
      return {
        templates: await listMessageTemplates(db),
        sender: { name: profile?.fields.displayName ?? null, email: profile?.fields.contactEmail ?? null, footer: profile?.footer || null },
      };
    });
  } catch {
    data = null;
  }
  if (data === null) {
    return <section className="nz-a-state" role="alert"><h1>Message templates could not be read</h1><p>They are unavailable just now. Nothing is shown rather than wording that might not be what is sent.</p></section>;
  }

  const editing = !holds(access.capabilities, "admin.templates") ? { allowed: false as const, reason: "Your role can see the messages but not reword them — that needs admin.templates." }
    : serviceEnvironment().writes !== "enabled" ? { allowed: false as const, reason: "Writes are switched off in this environment, so the messages are read-only here." }
    : { allowed: true as const };
  return <MessageTemplatesBoard templates={data.templates} sender={data.sender} editing={editing} />;
}
