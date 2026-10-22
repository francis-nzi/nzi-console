import type { ClientAreaGroup } from "@nzi/ui";

/**
 * The client workspace areas (v10). Grouped as the prototype groups them: Client — what
 * the job produces; Manage — how it is run; Record — what the client is.
 *
 * `built` marks the areas this phase renders for real. The rest are in the nav because
 * they are part of the approved information architecture, and each says plainly that it
 * is not available yet rather than showing an empty screen that looks like no data.
 */
export type ClientAreaId =
  | "overview" | "analytics" | "reporting" | "strategies" | "srs"
  | "tasks" | "notes" | "files" | "comms" | "portal"
  | "profile" | "financials" | "ai" | "history";

export const CLIENT_AREA_IDS: ClientAreaId[] = ["overview", "analytics", "reporting", "strategies", "srs", "tasks", "notes", "files", "comms", "portal", "profile", "financials", "ai", "history"];
export const isClientAreaId = (value: string | null | undefined): value is ClientAreaId => CLIENT_AREA_IDS.includes(value as ClientAreaId);

export const CLIENT_AREA_LABELS: Record<ClientAreaId, string> = {
  overview: "Overview", analytics: "Carbon Analytics", reporting: "Reporting", strategies: "Reduction Strategies", srs: "SRS Readiness",
  tasks: "Tasks", notes: "Notes", files: "Files", comms: "Communications", portal: "Portal Management",
  profile: "Company Profile", financials: "Financials", ai: "AI Profile", history: "History",
};

/**
 * Areas that render from live data. Phase 2 adds the areas that have real records behind
 * them; Tasks, Notes and AI Profile have no store yet, SRS Readiness is held back for its
 * redesign, and Financials is held by NZC-069 — each says so in its own words.
 */
export const BUILT_AREAS: ReadonlySet<ClientAreaId> = new Set<ClientAreaId>([
  "overview", "analytics", "reporting", "strategies", "srs", "profile", "comms", "files", "portal", "ai", "history",
]);

const ICONS: Record<ClientAreaId, string> = {
  overview: "▦", analytics: "▤", reporting: "▥", strategies: "⚡", srs: "◎",
  tasks: "☑", notes: "✎", files: "🗂", comms: "✉", portal: "◐",
  profile: "🏢", financials: "£", ai: "✦", history: "↺",
};

/**
 * `showHistory` — History is offered only to a holder of audit.view who may read this client's (CLIENT-12).
 * `showPortal` — Portal Management (portal data-entry phase 1) is offered only behind the `portal-management` flag, to a
 * holder of portal.admin on this client — the same mechanism, so a member of staff never sees an area they cannot use.
 */
export function clientAreaGroups(counts: Partial<Record<ClientAreaId, number | string | null>> = {}, showHistory = false, showPortal = false): ClientAreaGroup[] {
  const item = (id: ClientAreaId) => ({ id, label: CLIENT_AREA_LABELS[id], icon: ICONS[id], count: counts[id] ?? null, unavailable: !BUILT_AREAS.has(id) });
  return [
    { id: "client", label: "Client", items: (["overview", "analytics", "reporting", "strategies", "srs"] as const).map(item) },
    { id: "manage", label: "Manage", items: ([...["tasks", "notes", "files", "comms"] as const, ...(showPortal ? ["portal"] as const : [])]).map(item) },
    { id: "record", label: "Record", items: ([...["profile", "financials", "ai"] as const, ...(showHistory ? ["history"] as const : [])]).map(item) },
  ];
}
