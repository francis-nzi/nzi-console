import type { ClientAreaGroup } from "@nzi/ui";

/**
 * The client workspace areas (v10). Grouped as the prototype groups them: Client — what
 * the engagement produces; Manage — how it is run; Record — what the client is.
 *
 * `built` marks the areas this phase renders for real. The rest are in the nav because
 * they are part of the approved information architecture, and each says plainly that it
 * is not available yet rather than showing an empty screen that looks like no data.
 */
export type ClientAreaId =
  | "overview" | "analytics" | "reporting" | "actions" | "srs"
  | "tasks" | "notes" | "files" | "comms"
  | "profile" | "financials" | "ai";

export const CLIENT_AREA_IDS: ClientAreaId[] = ["overview", "analytics", "reporting", "actions", "srs", "tasks", "notes", "files", "comms", "profile", "financials", "ai"];
export const isClientAreaId = (value: string | null | undefined): value is ClientAreaId => CLIENT_AREA_IDS.includes(value as ClientAreaId);

export const CLIENT_AREA_LABELS: Record<ClientAreaId, string> = {
  overview: "Overview", analytics: "Carbon Analytics", reporting: "Reporting", actions: "Actions", srs: "SRS Readiness",
  tasks: "Tasks", notes: "Notes", files: "Files", comms: "Communications",
  profile: "Company Profile", financials: "Financials", ai: "AI Profile",
};

/**
 * Areas that render from live data. Phase 2 adds the areas that have real records behind
 * them; Tasks, Notes and AI Profile have no store yet, SRS Readiness is held back for its
 * redesign, and Financials is held by NZC-069 — each says so in its own words.
 */
export const BUILT_AREAS: ReadonlySet<ClientAreaId> = new Set<ClientAreaId>([
  "overview", "analytics", "reporting", "srs", "profile", "comms", "files", "ai",
]);

const ICONS: Record<ClientAreaId, string> = {
  overview: "▦", analytics: "▤", reporting: "▥", actions: "⚡", srs: "◎",
  tasks: "☑", notes: "✎", files: "🗂", comms: "✉",
  profile: "🏢", financials: "£", ai: "✦",
};

export function clientAreaGroups(counts: Partial<Record<ClientAreaId, number | string | null>> = {}): ClientAreaGroup[] {
  const item = (id: ClientAreaId) => ({ id, label: CLIENT_AREA_LABELS[id], icon: ICONS[id], count: counts[id] ?? null, unavailable: !BUILT_AREAS.has(id) });
  return [
    { id: "client", label: "Client", items: (["overview", "analytics", "reporting", "actions", "srs"] as const).map(item) },
    { id: "manage", label: "Manage", items: (["tasks", "notes", "files", "comms"] as const).map(item) },
    { id: "record", label: "Record", items: (["profile", "financials", "ai"] as const).map(item) },
  ];
}
