import type { CSSProperties } from "react";

/**
 * The curated NZI icon set (DESIGN_CONVENTIONS §10, locked).
 *
 * Inline SVG line icons on `currentColor` at a ~2px stroke — never emoji. Three reasons,
 * all of them practical: `currentColor` lets an icon tint with the design tokens and print
 * cleanly in mono; inline SVG is deterministic in the PDF, with no font or emoji dependency
 * on the rendering machine; and one set serves the console, the client portal and the
 * report, so a metric wears the same mark everywhere it appears.
 *
 * Records store the **key**, never the artwork. Swapping or extending the set is a change
 * here, not a migration.
 */

export const nziIconKeys = [
  // Intensity metrics
  "people", "currency", "building", "vehicle", "water", "package", "factory",
  "flight", "tools", "energy", "waste", "metric",
  // Action levers and categories
  "solar", "heat-pump", "handshake", "policy", "bus", "recycle", "document", "leaf",
  // Readiness and general
  "shield", "target", "chart", "clock",
] as const;
export type NziIconKey = (typeof nziIconKeys)[number];
export const isNziIconKey = (value: string): value is NziIconKey => (nziIconKeys as readonly string[]).includes(value);

const PATHS: Record<NziIconKey, string> = {
  people: "M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM3 20a6 6 0 0 1 12 0M17 11a3 3 0 1 0-2-5.2M16.5 14.5A6 6 0 0 1 21 20",
  currency: "M7 7h7a3 3 0 0 1 0 6H7M5 10h8M7 7v10h7",
  building: "M4 21V6l7-3 7 3v15M4 21h14M9 21v-4h4v4M8 9h1M12 9h1M8 13h1M12 13h1",
  vehicle: "M3 16v-4l2-5h8l3 5h3v4M3 16h18M7.5 18a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM16.5 18a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z",
  water: "M12 3s6 6.5 6 10.5a6 6 0 0 1-12 0C6 9.5 12 3 12 3Z",
  package: "M12 3 4 7v10l8 4 8-4V7l-8-4ZM4 7l8 4 8-4M12 11v10",
  factory: "M3 21V11l5 3V11l5 3V8l6 4v9H3ZM7 21v-3M12 21v-3M17 21v-3",
  flight: "M2 13l20-7-7 20-3-8-8-3Z",
  tools: "M14 6a4 4 0 0 1 5.5 5.2L21 13l-2 2-1.8-1.5A4 4 0 0 1 12 8M9 11l-6 6v4h4l6-6",
  energy: "M13 2 4 14h7l-1 8 9-12h-7l1-8Z",
  waste: "M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13M10 11v6M14 11v6",
  metric: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  solar: "M12 3v2M12 19v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M3 12h2M19 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z",
  "heat-pump": "M12 3v6M9 6l3-3 3 3M4 12h16v8H4zM8 16h8",
  handshake: "M6 12 3 9l4-4 3 2h4l3-2 4 4-3 3M6 12l4 4 2-2 2 2 4-4M6 12v4l2 2",
  policy: "M6 3h9l3 3v15H6zM15 3v3h3M9 11h6M9 15h6",
  bus: "M4 16V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v10M4 16h16M4 16v3M20 16v3M6 10h12M7.5 13.5h.01M16.5 13.5h.01",
  recycle: "M7 19H5a2 2 0 0 1-1.7-3l2-3.4M12 3l2 3.4M17 5l2 3.4a2 2 0 0 1 0 2L17.5 14M9 21h6M7 19l2-3.5M15 21l2-3.5M12 3 9.5 7.3",
  document: "M7 3h7l4 4v14H7zM14 3v4h4M10 12h6M10 16h6",
  leaf: "M4 20C4 10 12 4 20 4c0 10-6 16-16 16ZM9 15c2-3 5-5 8-6",
  shield: "M12 3 5 6v6c0 4.5 3 8 7 9 4-1 7-4.5 7-9V6l-7-3ZM9 12l2 2 4-4",
  target: "M12 3v4M12 17v4M3 12h4M17 12h4M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z",
  chart: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  clock: "M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16ZM12 8v4l3 2",
};

/**
 * One icon. `title` makes it a labelled image for assistive technology; without one it is
 * decorative and hidden, which is right when the label sits next to it.
 */
export function NziIcon({ name, size = 16, title, strokeWidth = 1.8, className, style }: {
  name: string;
  size?: number;
  title?: string;
  strokeWidth?: number;
  className?: string;
  style?: CSSProperties;
}) {
  // An unknown key falls back to the neutral mark rather than rendering an empty box.
  const key: NziIconKey = isNziIconKey(name) ? name : "metric";
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round"
    aria-hidden={title ? undefined : true} role={title ? "img" : undefined}
    className={className} style={{ flex: "0 0 auto", ...style }}>
    {title ? <title>{title}</title> : null}
    <path d={PATHS[key]} />
  </svg>;
}

/** The tile an icon wears in a list, a legend or a portal card. */
export function NziIconBadge({ name, label, size = 30 }: { name: string; label?: string; size?: number }) {
  return <span className="nz-icon-badge" style={{ width: size, height: size }} title={label}>
    <NziIcon name={name} size={Math.round(size * 0.55)} />
  </span>;
}
