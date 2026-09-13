import type { CSSProperties } from "react";
import { NziIcon, NziIconBadge } from "@nzi/ui";

/**
 * Intensity metric icons resolve through the shared NZI set (DESIGN_CONVENTIONS §10):
 * inline SVG on currentColor, never emoji, and the same mark in the console, the portal
 * and the report. The definition stores the key; this only decides how big it is drawn.
 */
export function IntensityMetricIcon({ iconKey, size = 16, title, style }: {
  iconKey: string; size?: number; title?: string; style?: CSSProperties;
}) {
  return <NziIcon name={iconKey} size={size} title={title} style={style} />;
}

export function IntensityMetricBadge({ iconKey, label, size = 30 }: { iconKey: string; label?: string; size?: number }) {
  return <NziIconBadge name={iconKey} label={label} size={size} />;
}
