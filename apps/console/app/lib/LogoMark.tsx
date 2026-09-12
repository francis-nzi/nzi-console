"use client";

import { useState } from "react";

export const monogramOf = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word[0]!.toUpperCase()).join("") || "—";

/**
 * A client's logo, falling back to its monogram when there is none or it fails to
 * load — the one rule every client-facing surface follows (record, portal, report).
 */
export function LogoMark({ src, name, className }: { src: string | null; name: string; className: string }) {
  const [failed, setFailed] = useState(false);
  return src && !failed
    ? <span className={`${className} has-img`}><img src={src} alt={`${name} logo`} onError={() => setFailed(true)} /></span>
    : <span className={className} aria-hidden="true">{monogramOf(name)}</span>;
}
