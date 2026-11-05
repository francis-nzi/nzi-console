/**
 * The client workspace areas (v10). Each area is a section under one of the six top tabs
 * (Overview · Carbon · Data entry · Reporting · Record · Manage); `AREA_TAB` says which, so every
 * area stays reachable and an old `?area=` link still lands where it always did.
 *
 * `built` marks the areas this phase renders for real. The rest are part of the approved
 * information architecture, and each says plainly that it is not available yet rather than
 * showing an empty screen that looks like no data.
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

/**
 * The top tab bar on the client header. The sections each tab hosts are composed in ClientWorkspaceView. History
 * (audit.view, CLIENT-12) and Portal Management (the `portal-management` flag + portal.admin) sit under Manage and are
 * offered there only to whoever may use them — the same gates as before, now applied to a section rather than a nav item.
 */
export type ClientTabId = "overview" | "carbon" | "data-entry" | "reporting" | "record" | "manage";
export const CLIENT_TABS: ReadonlyArray<{ id: ClientTabId; label: string }> = [
  { id: "overview", label: "Overview" }, { id: "carbon", label: "Carbon" }, { id: "data-entry", label: "Data entry" },
  { id: "reporting", label: "Reporting" }, { id: "record", label: "Record" }, { id: "manage", label: "Manage" },
];
export const CLIENT_TAB_IDS: ClientTabId[] = CLIENT_TABS.map((tab) => tab.id);

/** The tab each area sits under. Total over ClientAreaId, so an area cannot be added without being placed. */
export const AREA_TAB: Record<ClientAreaId, ClientTabId> = {
  overview: "overview",
  analytics: "carbon", strategies: "carbon",
  reporting: "reporting", srs: "reporting",
  profile: "record", financials: "record", ai: "record",
  tasks: "manage", notes: "manage", files: "manage", comms: "manage", portal: "manage", history: "manage",
};

/** The tab a URL asks for: a tab id, or an area id from before the tabs (`?area=srs`). */
export function tabForParam(value: string | null | undefined): ClientTabId {
  if (CLIENT_TAB_IDS.includes(value as ClientTabId)) return value as ClientTabId;
  return isClientAreaId(value) ? AREA_TAB[value] : "overview";
}
