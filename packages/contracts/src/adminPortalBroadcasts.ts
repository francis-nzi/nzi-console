import { defineListSpec, type ListQuery } from "./listQuery";

/**
 * Portal broadcasts (admin Phase F4; ruled `F4-RULINGS.md`, R1–R7): notices staff write for the client portal — to every
 * portal client, or to one.
 *
 * - **Title and body required** (R6); a **style** from a closed set, default `info` (R2) — F4 owns the value, the portal
 *   how it looks.
 * - **A link, both or neither** (R3): an `https://` URL or one of the console's own paths — no other scheme, ever, on a
 *   client-facing surface.
 * - **A window** (R4): a start (required), an end (optional — none is "until deactivated"), the end after the start.
 *   Entered on the platform's London clock, stored as instants. **Live** = active and `starts_at <= now < ends_at`.
 * - **Several live at once** (R5): the portal read returns every live one for the client, warnings first, then newest,
 *   five at most.
 * - Deactivate, never delete (R7). Capability `admin.settings`.
 */
export const PORTAL_BROADCAST_STYLES = ["info", "warning", "success", "promo"] as const;
export type PortalBroadcastStyle = (typeof PORTAL_BROADCAST_STYLES)[number];
export const PORTAL_BROADCAST_STYLE_LABELS: Record<PortalBroadcastStyle, string> = { info: "Information", warning: "Warning", success: "Good news", promo: "Promotion" };
export const isPortalBroadcastStyle = (value: unknown): value is PortalBroadcastStyle =>
  typeof value === "string" && (PORTAL_BROADCAST_STYLES as readonly string[]).includes(value);

export const PORTAL_BROADCAST_TITLE_MAX = 120;
export const PORTAL_BROADCAST_BODY_MAX = 2000;
export const PORTAL_BROADCAST_LINK_URL_MAX = 500;
export const PORTAL_BROADCAST_LINK_LABEL_MAX = 80;
/** How many live broadcasts the portal read returns at most (R5). */
export const PORTAL_BROADCAST_LIVE_CAP = 5;

/**
 * Whether a link may be put in front of a portal client (R3): `https://` with a host, or one of the console's own paths
 * (`/…`, but not `//…`, which a browser reads as another host). No whitespace, no backslashes, no other scheme.
 */
export function isAllowedBroadcastLink(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > PORTAL_BROADCAST_LINK_URL_MAX) return false;
  if (/[\s\\]/.test(value)) return false;
  if (value.startsWith("/")) return !value.startsWith("//");
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.length > 0 && value.toLowerCase().startsWith("https://");
  } catch {
    return false;
  }
}

/** An instant as the API carries it: an ISO string with a zone, which `Date` reads unambiguously. */
export const isBroadcastInstant = (value: unknown): value is string =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(value) && !Number.isNaN(Date.parse(value));

/** What a broadcast carries — every part editable (no set-once identity beyond its id). */
export type PortalBroadcastEditableFields = {
  title: string;
  body: string;
  style: PortalBroadcastStyle;
  linkUrl: string | null;
  linkLabel: string | null;
  /** An instant (ISO, with a zone). The screen enters it on the platform's London clock. */
  startsAt: string;
  /** An instant, after the start — or null: until deactivated. */
  endsAt: string | null;
  /** One client, or null for every portal client. */
  targetClientId: string | null;
};

export type PortalBroadcastPhase = "live" | "scheduled" | "ended" | "inactive";
export const PORTAL_BROADCAST_PHASE_LABELS: Record<PortalBroadcastPhase, string> = { live: "Live", scheduled: "Scheduled", ended: "Ended", inactive: "Inactive" };

/** Where a broadcast stands at `now`: inactive, else before its window, inside it, or past it (the end exclusive). */
export function portalBroadcastPhase(row: { active: boolean; startsAt: string; endsAt: string | null }, now: Date): PortalBroadcastPhase {
  if (!row.active) return "inactive";
  if (now.getTime() < Date.parse(row.startsAt)) return "scheduled";
  if (row.endsAt !== null && now.getTime() >= Date.parse(row.endsAt)) return "ended";
  return "live";
}

/** The broadcasts list: search (title), the phase, newest start first. */
export const portalBroadcastListSpec = defineListSpec({
  sortKeys: ["startsAt", "title", "style", "phase"] as const,
  defaultSort: { key: "startsAt", dir: "desc" },
  filters: { phase: "value", style: "value" },
});
export type PortalBroadcastListSortKey = (typeof portalBroadcastListSpec.sortKeys)[number];
export type PortalBroadcastListFilterKey = keyof typeof portalBroadcastListSpec.filters;
export type PortalBroadcastListQuery = ListQuery<PortalBroadcastListSortKey, PortalBroadcastListFilterKey>;

/** A live broadcast as the portal receives it (R5): content only — never who wrote it or which client it targets. */
export type PortalLiveBroadcast = {
  broadcastId: string; title: string; body: string; style: PortalBroadcastStyle;
  link: { url: string; label: string } | null;
  startsAt: string; endsAt: string | null;
};
