import { emailBrandFor, type ReminderSettings } from "@nzi/contracts";
import { listMessageTemplates, readOrganisationProfile, readReminderSettings, withTenantRead, type MessageTemplateRow } from "@nzi/isolated-backend";
import { serviceEnvironment } from "../../lib/environment";
import { isolatedPool } from "../../lib/isolatedDatabase";
import { adminAccess, holds } from "../adminAccess";
import { MessageTemplatesBoard, type SenderReference } from "./MessageTemplatesBoard";
import { ReminderSettingsCard } from "./ReminderSettingsCard";

export const dynamic = "force-dynamic";

/**
 * Message templates (admin Phase F1). The messages the console sends — a fixed set, governed in code (F-Q3) — each with
 * the organisation's own wording beside the built-in, edited over its declared tokens and previewed against sample values
 * only (F-Q2). The sender and footer are the organisation profile's, shown for reference (F-Q7). Seven messages (the
 * transactional four joined in phase 2), so no paging.
 */
export default async function MessageTemplatesPage() {
  const access = await adminAccess();
  if (access.state !== "allowed") return null; // The layout states why; nothing is read.

  let data: { templates: MessageTemplateRow[]; sender: SenderReference; reminders: ReminderSettings } | null = null;
  try {
    data = await withTenantRead(isolatedPool(), access.organisationId, async (db) => {
      const profile = await readOrganisationProfile(db, access.organisationId);
      return {
        templates: await listMessageTemplates(db),
        reminders: await readReminderSettings(db, access.organisationId),
        sender: { name: profile?.fields.displayName ?? null, email: profile?.fields.contactEmail ?? null, footer: profile?.footer || null,
          // The house signature as a send would draw it (5-1): the same settings, the same console origin for the logo.
          brand: emailBrandFor(profile?.fields ?? null, process.env.NZI_ISOLATED_API_URL ?? null) },
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
  // A3 (R6): the reminder master switch and default lead, beside the messages that word them, under the same capability.
  return <MessageTemplatesBoard templates={data.templates} sender={data.sender} editing={editing}
    reminders={<ReminderSettingsCard settings={data.reminders} editing={editing} />} />;
}
